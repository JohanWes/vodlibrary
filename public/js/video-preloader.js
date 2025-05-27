/**
 * Video Preloader and Caching Utility
 * 
 * This module provides functionality for preloading video segments and caching them
 * for faster playback when a user clicks on a video.
 */

// Feature detection for Cache API
const CACHE_API_AVAILABLE = typeof caches !== 'undefined';
console.log(`Cache API available: ${CACHE_API_AVAILABLE}`);

const VIDEO_SEGMENT_CACHE = 'video-segments-cache-v1';
const VIDEO_METADATA_CACHE = 'video-metadata-cache-v1';

const LS_METADATA_PREFIX = 'vod_metadata_';
const LS_PRELOADED_VIDEOS = 'vod_preloaded_videos';

const config = {
  maxCacheSize: 250 * 1024 * 1024, // Reduced cache size (250MB) for better performance
  // Reduced segment size for faster loading (1MB)
  segmentSize: 1 * 1024 * 1024,
  // Reduced number of segments to preload
  preloadSegments: 1,
  // Quality to use for preloaded segments (low, medium, high)
  preloadQuality: 'low',
  // Reduced timeout for faster failure detection (5s)
  preloadTimeout: 5000,
  // Reduced maximum number of concurrent preloads
  maxConcurrentPreloads: 2,
  // Maximum localStorage size (5MB)
  maxLocalStorageSize: 5 * 1024 * 1024 // Maximum localStorage size (5MB)
};

let activePreloads = 0;
let preloadQueue = [];
let preloadedVideos = new Set(); // Track preloaded videos for fallback mode

/**
 * Initialize the video preloader
 */
async function initVideoPreloader() {
  console.log('Initializing video preloader...');
  
  try {
    if (CACHE_API_AVAILABLE) {
      await caches.open(VIDEO_SEGMENT_CACHE);
      await caches.open(VIDEO_METADATA_CACHE);
      
      try {
        await cleanupCache();
      } catch (error) {
        console.error('Error cleaning up cache:', error);
      }
      
      console.log('Video preloader initialized with Cache API');
    } else {
      console.log('Cache API not available, using localStorage fallback');
      
      try {
        const savedPreloadedVideos = localStorage.getItem(LS_PRELOADED_VIDEOS);
        if (savedPreloadedVideos) {
          preloadedVideos = new Set(JSON.parse(savedPreloadedVideos));
        }
      } catch (error) {
        console.warn('Error loading preloaded videos from localStorage:', error);
      }
      
      cleanupLocalStorage();
    }
    
    console.log('Video preloader initialized');
    return true;
  } catch (error) {
    console.error('Error initializing video preloader:', error);
    return false;
  }
}

/**
 * Clean up localStorage to stay within size limits
 */
function cleanupLocalStorage() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(LS_METADATA_PREFIX)) {
        keys.push(key);
      }
    }
    
    if (keys.length > 50) { // Arbitrary limit
      keys.sort((a, b) => {
        try {
          const aData = JSON.parse(localStorage.getItem(a));
          const bData = JSON.parse(localStorage.getItem(b));
          return (aData.timestamp || 0) - (bData.timestamp || 0);
        } catch (e) {
          return 0;
        }
      });
      
      const toRemove = keys.slice(0, keys.length - 30); // Keep 30 newest
      for (const key of toRemove) {
        localStorage.removeItem(key);
      }
      
      console.log(`Cleaned up localStorage, removed ${toRemove.length} items`);
    }
  } catch (error) {
    console.error('Error cleaning up localStorage:', error);
  }
}

/**
 * Preload a specific segment of a video
 * @param {number} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number to preload
 * @param {string} quality - The quality of the segment (low, medium, high)
 * @returns {Promise<boolean>} - Whether the preload was successful
 */
async function preloadVideoSegment(videoId, segmentNumber = 0, quality = 'low') {
  if (activePreloads >= config.maxConcurrentPreloads) {
    return new Promise((resolve) => {
      preloadQueue.push({ videoId, segmentNumber, quality, resolve });
    });
  }
  
  try {
    if (CACHE_API_AVAILABLE) {
      return await preloadVideoSegmentWithCacheAPI(videoId, segmentNumber, quality);
    } else {
      return await preloadVideoSegmentWithLocalStorage(videoId, segmentNumber, quality);
    }
  } catch (error) {
    console.error(`Error in preloadVideoSegment:`, error);
    return false;
  }
}

/**
 * Processes the next item in the preload queue if available.
 * @private
 */
async function processNextPreloadInQueue() {
  if (preloadQueue.length > 0) {
    const nextPreload = preloadQueue.shift();
    const result = await preloadVideoSegment(
      nextPreload.videoId, 
      nextPreload.segmentNumber, 
      nextPreload.quality
    );
    nextPreload.resolve(result);
  }
}

/**
 * Preload a video segment using the Cache API
 * @private
 */
async function preloadVideoSegmentWithCacheAPI(videoId, segmentNumber, quality) {
  try {
    const cache = await caches.open(VIDEO_SEGMENT_CACHE);
    const cacheKey = `/api/videos/${videoId}/segments/${segmentNumber}?quality=${quality}`;
    const cachedResponse = await cache.match(cacheKey);
    
    if (cachedResponse) {
      console.log(`Segment ${segmentNumber} of video ${videoId} already cached`);
      return true;
    }
    
    activePreloads++;
    console.log(`Preloading segment ${segmentNumber} of video ${videoId}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.preloadTimeout);
    
    const response = await fetch(cacheKey, { 
      signal: controller.signal,
      headers: {
        'Range': `bytes=0-${config.segmentSize - 1}`
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Failed to preload segment: ${response.status} ${response.statusText}`);
    }

    let responseToCache;
    if (response.status === 206) {
      // Cache API cannot store 206 responses directly. Create a new 200 OK response.
      const blob = await response.blob();
      const headers = new Headers(response.headers);
      responseToCache = new Response(blob, { status: 200, statusText: 'OK', headers });
      console.log(`Synthesized 200 OK response for caching segment ${segmentNumber} of video ${videoId}`);
    } else {
      responseToCache = response.clone();
    }

    await cache.put(cacheKey, responseToCache);
    
    console.log(`Successfully cached segment ${segmentNumber} of video ${videoId}`);
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(`Preload timeout for segment ${segmentNumber} of video ${videoId}`);
    } else {
      console.error(`Error preloading segment ${segmentNumber} of video ${videoId}:`, error);
    }
    return false;
  } finally {
    activePreloads--;
    processNextPreloadInQueue();
  }
}

/**
 * Preload a video segment using localStorage (fallback)
 * @private
 */
async function preloadVideoSegmentWithLocalStorage(videoId, segmentNumber, quality) {
  try {
    // For localStorage, we don't actually store the video data (too large).
    // Instead, mark the video as "preloaded" and make a HEAD request to warm up browser cache.
    activePreloads++;
    
    const cacheKey = `/api/videos/${videoId}/segments/${segmentNumber}?quality=${quality}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.preloadTimeout);
    
    try {
      await fetch(cacheKey, { 
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'Range': `bytes=0-${config.segmentSize - 1}`
        }
      });
      
      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      console.warn(`HEAD request failed for ${cacheKey}, but continuing anyway`);
    }
    
    preloadedVideos.add(videoId.toString());
    
    try {
      localStorage.setItem(LS_PRELOADED_VIDEOS, JSON.stringify([...preloadedVideos]));
    } catch (error) {
      console.warn('Failed to save preloaded videos to localStorage:', error);
    }
    
    console.log(`Marked video ${videoId} as preloaded (localStorage fallback)`);
    return true;
  } catch (error) {
    console.error(`Error in localStorage preload for video ${videoId}:`, error);
    return false;
  } finally {
    activePreloads--;
    processNextPreloadInQueue();
  }
}

/**
 * Preload multiple segments of a video
 * @param {number} videoId - The ID of the video
 * @param {number} count - The number of segments to preload
 * @param {string} quality - The quality of the segments
 * @returns {Promise<boolean[]>} - Array of results for each segment
 */
async function preloadVideoSegments(videoId, count = config.preloadSegments, quality = config.preloadQuality) {
  try {
    const results = [];
    
    for (let i = 0; i < count; i++) {
      const result = await preloadVideoSegment(videoId, i, quality);
      results.push(result);
    }
    
    return results;
  } catch (error) {
    console.error('Error in preloadVideoSegments:', error);
    return Array(count).fill(false);
  }
}

/**
 * Check if a video segment is cached
 * @param {number} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number
 * @param {string} quality - The quality of the segment
 * @returns {Promise<boolean>} - Whether the segment is cached
 */
async function isSegmentCached(videoId, segmentNumber, quality = 'low') {
  try {
    if (CACHE_API_AVAILABLE) {
      const cache = await caches.open(VIDEO_SEGMENT_CACHE);
      const cacheKey = `/api/videos/${videoId}/segments/${segmentNumber}?quality=${quality}`;
      const cachedResponse = await cache.match(cacheKey);
      
      return !!cachedResponse;
    } else {
      // localStorage fallback: We don't actually cache segments, just track if video is "preloaded"
      return preloadedVideos.has(videoId.toString());
    }
  } catch (error) {
    console.error('Error checking segment cache:', error);
    return false;
  }
}

/**
 * Get a cached video segment
 * @param {number} videoId - The ID of the video
 * @param {number} segmentNumber - The segment number
 * @param {string} quality - The quality of the segment
 * @returns {Promise<Response|null>} - The cached response or null if not found
 */
async function getCachedSegment(videoId, segmentNumber, quality = 'low') {
  try {
    if (CACHE_API_AVAILABLE) {
      const cache = await caches.open(VIDEO_SEGMENT_CACHE);
      const cacheKey = `/api/videos/${videoId}/segments/${segmentNumber}?quality=${quality}`;
      return await cache.match(cacheKey);
    } else {
      // localStorage fallback: No actual segment data stored
      return null;
    }
  } catch (error) {
    console.error('Error getting cached segment:', error);
    return null;
  }
}

/**
 * Cache video metadata
 * @param {number} videoId - The ID of the video
 * @param {Object} metadata - The video metadata
 * @returns {Promise<boolean>} - Whether the caching was successful
 */
async function cacheVideoMetadata(videoId, metadata) {
  try {
    if (CACHE_API_AVAILABLE) {
      const cache = await caches.open(VIDEO_METADATA_CACHE);
      const cacheKey = `/api/videos/${videoId}`;
      
      const response = new Response(JSON.stringify(metadata), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=86400' // 24 hours
        }
      });
      
      await cache.put(cacheKey, response);
    } else {
      try {
        // localStorage fallback: Add timestamp for LRU eviction
        const dataToStore = {
          ...metadata,
          timestamp: Date.now()
        };
        
        localStorage.setItem(
          `${LS_METADATA_PREFIX}${videoId}`, 
          JSON.stringify(dataToStore)
        );
        
        cleanupLocalStorage();
      } catch (error) {
        console.warn('Failed to store metadata in localStorage:', error);
        return false;
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error caching video metadata:', error);
    return false;
  }
}

/**
 * Get cached video metadata
 * @param {number} videoId - The ID of the video
 * @returns {Promise<Object|null>} - The cached metadata or null if not found
 */
async function getCachedMetadata(videoId) {
  try {
    if (CACHE_API_AVAILABLE) {
      const cache = await caches.open(VIDEO_METADATA_CACHE);
      const cacheKey = `/api/videos/${videoId}`;
      const cachedResponse = await cache.match(cacheKey);
      
      if (cachedResponse) {
        return await cachedResponse.json();
      }
    } else {
      // localStorage fallback
      const storedData = localStorage.getItem(`${LS_METADATA_PREFIX}${videoId}`);
      if (storedData) {
        try {
          const data = JSON.parse(storedData);
          delete data.timestamp; // Remove internal timestamp
          return data;
        } catch (error) {
          console.warn('Error parsing metadata from localStorage:', error);
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting cached metadata:', error);
    return null;
  }
}

/**
 * Clean up the cache to stay within size limits
 * Uses a Least Recently Used (LRU) strategy
 */
async function cleanupCache() {
  try {
    const cache = await caches.open(VIDEO_SEGMENT_CACHE);
    const keys = await cache.keys();
    
    if (keys.length < 10) {
      return; // No need to clean up yet
    }
    
    let totalSize = 0;
    const entries = [];
    
    for (const request of keys) {
      const response = await cache.match(request);
      const clone = response.clone();
      const buffer = await clone.arrayBuffer();
      const size = buffer.byteLength;
      
      entries.push({
        request,
        size,
        timestamp: new Date(response.headers.get('date') || Date.now()).getTime()
      });
      
      totalSize += size;
    }
    
    console.log(`Cache size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB of ${(config.maxCacheSize / (1024 * 1024)).toFixed(2)}MB`);
    
    if (totalSize > config.maxCacheSize) {
      // Sort by timestamp (oldest first) for LRU
      entries.sort((a, b) => a.timestamp - b.timestamp);
      
      let sizeToFree = totalSize - (config.maxCacheSize * 0.8); // Target 80% capacity
      console.log(`Need to free up ${(sizeToFree / (1024 * 1024)).toFixed(2)}MB`);
      
      for (const entry of entries) {
        if (sizeToFree <= 0) break;
        
        await cache.delete(entry.request);
        sizeToFree -= entry.size;
        console.log(`Removed cache entry: ${entry.request.url}, size: ${(entry.size / 1024).toFixed(2)}KB`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up cache:', error);
  }
}

// Export the API
window.VideoPreloader = {
  init: initVideoPreloader,
  preloadSegment: preloadVideoSegment,
  preloadSegments: preloadVideoSegments,
  isSegmentCached,
  getCachedSegment,
  cacheVideoMetadata,
  getCachedMetadata,
  cleanupCache,
  config
};
