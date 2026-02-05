/**
 * Server-side caching module for video content.
 *
 * This module caches frequently accessed video segments in memory.
 */

const NodeCache = require('node-cache');
const fs = require('fs');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function debugLog(...args) {
  if (LOG_LEVEL === 'debug') {
    console.log(...args);
  }
}

// Configuration
const config = {
  stdTTL: 3600,
  checkperiod: 600,
  maxCacheSize: 500 * 1024 * 1024,
  enableStats: true,
  popularityThreshold: 5,
  maxSegmentsPerVideo: 3
};

const videoCache = new NodeCache({
  stdTTL: config.stdTTL,
  checkperiod: config.checkperiod,
  useClones: false
});

const cacheStats = {
  hits: 0,
  misses: 0,
  size: 0,
  videoAccess: {}
};

// Sidecar LRU metadata indexed by cache key.
const lruMeta = new Map();

function getAccessCounterKey(videoId, namespace) {
  return `${videoId}:${namespace}`;
}

function buildCacheKey(videoId, segmentNumber, options = {}) {
  const namespace = options.namespace || 'default';
  const quality = options.quality || 'default';
  const hasRange = Number.isInteger(options.startByte) && Number.isInteger(options.endByte);
  const rangeKey = hasRange ? `${options.startByte}-${options.endByte}` : 'na';

  return `video_${videoId}_ns_${namespace}_segment_${segmentNumber}_q_${quality}_r_${rangeKey}`;
}

function trackAccess(videoId, namespace) {
  const accessKey = getAccessCounterKey(videoId, namespace);
  if (!cacheStats.videoAccess[accessKey]) {
    cacheStats.videoAccess[accessKey] = 0;
  }
  cacheStats.videoAccess[accessKey]++;
}

function touchLruEntry(cacheKey) {
  const meta = lruMeta.get(cacheKey);
  if (!meta) {
    return;
  }

  meta.lastAccess = Date.now();
  lruMeta.set(cacheKey, meta);
}

function setCacheEntry(cacheKey, data, meta) {
  const existingMeta = lruMeta.get(cacheKey);
  if (existingMeta) {
    cacheStats.size -= existingMeta.size;
  }

  videoCache.set(cacheKey, data);

  const nextMeta = {
    ...meta,
    size: data.length,
    lastAccess: Date.now()
  };
  lruMeta.set(cacheKey, nextMeta);
  cacheStats.size += data.length;
}

function countCachedSegmentsForVideo(videoId, namespace = 'default') {
  const normalizedVideoId = String(videoId);
  let count = 0;

  for (const meta of lruMeta.values()) {
    if (meta.videoId === normalizedVideoId && meta.namespace === namespace) {
      count++;
    }
  }

  return count;
}

function cleanupCache(requiredSpace) {
  if (lruMeta.size === 0) {
    return 0;
  }

  const entries = Array.from(lruMeta.entries()).sort(([, a], [, b]) => a.lastAccess - b.lastAccess);

  let freedSpace = 0;
  for (const [cacheKey, meta] of entries) {
    if (freedSpace >= requiredSpace) {
      break;
    }

    videoCache.del(cacheKey);
    lruMeta.delete(cacheKey);
    freedSpace += meta.size;
    cacheStats.size -= meta.size;
    debugLog(`[cache] evicted ${cacheKey}, freed ${meta.size} bytes`);
  }

  return freedSpace;
}

function getCachedSegment(videoId, segmentNumber, options = {}) {
  const cacheKey = buildCacheKey(videoId, segmentNumber, options);
  const cachedData = videoCache.get(cacheKey);

  if (cachedData) {
    if (config.enableStats) {
      cacheStats.hits++;
      trackAccess(videoId, options.namespace || 'default');
    }
    touchLruEntry(cacheKey);
    return cachedData;
  }

  if (config.enableStats) {
    cacheStats.misses++;
  }
  return null;
}

function cacheSegment(videoId, segmentNumber, data, options = {}) {
  if (!Buffer.isBuffer(data)) {
    return false;
  }

  if (cacheStats.size + data.length > config.maxCacheSize) {
    const neededSpace = (cacheStats.size + data.length) - config.maxCacheSize;
    const freedSpace = cleanupCache(neededSpace);

    if (cacheStats.size + data.length > config.maxCacheSize && freedSpace < neededSpace) {
      return false;
    }
  }

  const namespace = options.namespace || 'default';
  const cacheKey = buildCacheKey(videoId, segmentNumber, options);

  try {
    setCacheEntry(cacheKey, data, {
      videoId: String(videoId),
      segmentNumber,
      namespace,
      quality: options.quality || 'default',
      range: Number.isInteger(options.startByte) && Number.isInteger(options.endByte)
        ? `${options.startByte}-${options.endByte}`
        : 'na'
    });

    return true;
  } catch (error) {
    console.error('Error caching segment:', error);
    return false;
  }
}

async function cacheSegmentFromFile(videoId, segmentNumber, filePath, start, end, options = {}) {
  try {
    const namespace = options.namespace || 'default';
    const cacheKey = buildCacheKey(videoId, segmentNumber, {
      ...options,
      startByte: start,
      endByte: end
    });

    if (videoCache.has(cacheKey)) {
      return true;
    }

    if (config.enableStats) {
      const accessKey = getAccessCounterKey(videoId, namespace);
      if (!cacheStats.videoAccess[accessKey] || cacheStats.videoAccess[accessKey] < config.popularityThreshold) {
        return false;
      }
    }

    const videoSegmentCount = countCachedSegmentsForVideo(videoId, namespace);
    if (videoSegmentCount >= config.maxSegmentsPerVideo) {
      return false;
    }

    const data = await readFileSegment(filePath, start, end);

    return cacheSegment(videoId, segmentNumber, data, {
      ...options,
      namespace,
      startByte: start,
      endByte: end
    });
  } catch (error) {
    console.error('Error caching segment from file:', error);
    return false;
  }
}

function readFileSegment(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start, end });
    const chunks = [];

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

function getCacheStats() {
  return {
    ...cacheStats,
    keys: videoCache.keys().length,
    lruEntries: lruMeta.size,
    hitRate: cacheStats.hits + cacheStats.misses > 0
      ? (cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100
      : 0,
    sizeInMB: (cacheStats.size / (1024 * 1024)).toFixed(2)
  };
}

function resetCacheStats() {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

function clearCache() {
  videoCache.flushAll();
  lruMeta.clear();
  cacheStats.size = 0;
  debugLog('[cache] cleared');
}

function updateConfig(newConfig) {
  Object.assign(config, newConfig);

  if (newConfig.stdTTL !== undefined || newConfig.checkperiod !== undefined) {
    videoCache.options.stdTTL = config.stdTTL;
    videoCache.options.checkperiod = config.checkperiod;
  }

  debugLog('[cache] configuration updated', config);
}

module.exports = {
  buildCacheKey,
  getCachedSegment,
  cacheSegment,
  cacheSegmentFromFile,
  getCacheStats,
  resetCacheStats,
  clearCache,
  updateConfig,
  config
};
