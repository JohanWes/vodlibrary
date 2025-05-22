/**
 * Server-side caching module for video content
 * 
 * This module provides functionality for caching frequently accessed videos
 * in memory to improve performance and reduce disk I/O.
 */

const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  // Standard TTL in seconds (1 hour)
  stdTTL: 3600,
  // Check period in seconds (every 10 minutes)
  checkperiod: 600,
  // Maximum size of the cache in bytes (default: 500MB)
  maxCacheSize: 500 * 1024 * 1024,
  // Enable/disable cache statistics
  enableStats: true,
  // Threshold for considering a video "popular" (access count)
  popularityThreshold: 5,
  // Maximum number of segments to cache per video
  maxSegmentsPerVideo: 3
};

const videoCache = new NodeCache({
  stdTTL: config.stdTTL,
  checkperiod: config.checkperiod,
  useClones: false // Don't clone objects (for better performance with buffers)
});

const cacheStats = {
  hits: 0,
  misses: 0,
  size: 0,
  videoAccess: {} // Track access count per video
};

/**
 * Get a video segment from cache
 * @param {string} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number
 * @returns {Buffer|null} - The cached segment data or null if not found
 */
function getCachedSegment(videoId, segmentNumber) {
  const cacheKey = `video_${videoId}_segment_${segmentNumber}`;
  const cachedData = videoCache.get(cacheKey);
  
  if (cachedData) {
    if (config.enableStats) {
      cacheStats.hits++;
      incrementVideoAccess(videoId);
    }
    return cachedData;
  }
  
  if (config.enableStats) {
    cacheStats.misses++;
  }
  return null;
}

/**
 * Cache a video segment
 * @param {string} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number
 * @param {Buffer} data - The segment data to cache
 * @returns {boolean} - Whether the caching was successful
 */
function cacheSegment(videoId, segmentNumber, data) {
  if (cacheStats.size + data.length > config.maxCacheSize) {
    cleanupCache(data.length);
  }
  
  const cacheKey = `video_${videoId}_segment_${segmentNumber}`;
  
  try {
    videoCache.set(cacheKey, data);
    
    cacheStats.size += data.length;
    
    return true;
  } catch (error) {
    console.error('Error caching segment:', error);
    return false;
  }
}

/**
 * Cache a video segment from a file
 * @param {string} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number
 * @param {string} filePath - Path to the video file
 * @param {number} start - Start byte position
 * @param {number} end - End byte position
 * @returns {Promise<boolean>} - Whether the caching was successful
 */
async function cacheSegmentFromFile(videoId, segmentNumber, filePath, start, end) {
  try {
    const cacheKey = `video_${videoId}_segment_${segmentNumber}`;
    if (videoCache.has(cacheKey)) {
      return true;
    }
    
    // Check popularity
    if (config.enableStats && 
        (!cacheStats.videoAccess[videoId] || 
         cacheStats.videoAccess[videoId] < config.popularityThreshold)) {
      return false;
    }
    
    // Check segment limit per video
    const videoSegmentCount = countCachedSegmentsForVideo(videoId);
    if (videoSegmentCount >= config.maxSegmentsPerVideo) {
      return false;
    }
    
    const data = await readFileSegment(filePath, start, end);
    
    return cacheSegment(videoId, segmentNumber, data);
  } catch (error) {
    console.error('Error caching segment from file:', error);
    return false;
  }
}

/**
 * Read a segment of a file
 * @param {string} filePath - Path to the file
 * @param {number} start - Start byte position
 * @param {number} end - End byte position
 * @returns {Promise<Buffer>} - The file segment data
 */
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

/**
 * Clean up the cache to free up space
 * @param {number} requiredSpace - The amount of space needed in bytes
 */
function cleanupCache(requiredSpace) {
  const keys = videoCache.keys();
  
  if (keys.length === 0) {
    return;
  }
  
  const entries = [];
  for (const key of keys) {
    const value = videoCache.get(key);
    if (value) {
      const size = value.length || 0;
      
      const match = key.match(/^video_(\d+)_segment_\d+$/);
      const videoId = match ? match[1] : null;
      
      const accessCount = videoId && cacheStats.videoAccess[videoId] 
        ? cacheStats.videoAccess[videoId] 
        : 0;
      
      entries.push({
        key,
        size,
        videoId,
        accessCount
      });
    }
  }
  
  // Sort by access count (least accessed first)
  entries.sort((a, b) => a.accessCount - b.accessCount);
  
  let freedSpace = 0;
  for (const entry of entries) {
    if (freedSpace >= requiredSpace) {
      break;
    }
    
    const value = videoCache.take(entry.key);
    if (value) {
      freedSpace += entry.size;
      cacheStats.size -= entry.size;
      
      console.log(`Removed from cache: ${entry.key}, freed ${entry.size} bytes`);
    }
  }
  
  console.log(`Cleaned up cache, freed ${freedSpace} bytes`);
}

/**
 * Count the number of cached segments for a video
 * @param {string} videoId - The ID of the video
 * @returns {number} - The number of cached segments
 */
function countCachedSegmentsForVideo(videoId) {
  const keys = videoCache.keys();
  const pattern = new RegExp(`^video_${videoId}_segment_\\d+$`);
  
  return keys.filter(key => pattern.test(key)).length;
}

/**
 * Increment the access count for a video
 * @param {string} videoId - The ID of the video
 */
function incrementVideoAccess(videoId) {
  if (!cacheStats.videoAccess[videoId]) {
    cacheStats.videoAccess[videoId] = 0;
  }
  
  cacheStats.videoAccess[videoId]++;
}

/**
 * Get cache statistics
 * @returns {Object} - Cache statistics
 */
function getCacheStats() {
  return {
    ...cacheStats,
    keys: videoCache.keys().length,
    hitRate: cacheStats.hits + cacheStats.misses > 0 
      ? (cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100 
      : 0,
    sizeInMB: (cacheStats.size / (1024 * 1024)).toFixed(2)
  };
}

/**
 * Reset cache statistics
 */
function resetCacheStats() {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  // Don't reset size or videoAccess
}

/**
 * Clear the entire cache
 */
function clearCache() {
  videoCache.flushAll();
  cacheStats.size = 0;
  console.log('Cache cleared');
}

/**
 * Update cache configuration
 * @param {Object} newConfig - New configuration values
 */
function updateConfig(newConfig) {
  Object.assign(config, newConfig);
  
  if (newConfig.stdTTL !== undefined || newConfig.checkperiod !== undefined) {
    videoCache.options.stdTTL = config.stdTTL;
    videoCache.options.checkperiod = config.checkperiod;
  }
  
  console.log('Cache configuration updated:', config);
}

module.exports = {
  getCachedSegment,
  cacheSegment,
  cacheSegmentFromFile,
  getCacheStats,
  resetCacheStats,
  clearCache,
  updateConfig,
  config
};
