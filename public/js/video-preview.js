/**
 * Video Preview Manager for Hover Video Previews
 * Manages video element pooling, preview loading, and memory optimization
 */

/**
 * Resolve API URLs beneath the document base href.
 * Falls back to the raw path when VideoUtils is unavailable (e.g. tests).
 * @param {string} path - Application path to resolve
 * @returns {string} - Root-relative URL resolved against the document base
 */
function resolveAppUrl(path) {
  if (typeof window !== 'undefined' && window.VideoUtils && typeof window.VideoUtils.appUrl === 'function') {
    return window.VideoUtils.appUrl(path);
  }
  return path;
}

class VideoPreviewManager {
  constructor() {
    this.videoPool = [];
    this.activeVideos = new Map();
    this.maxPoolSize = 3;
    this.maxConcurrentPreviews = 2;
    this.previewCache = new Map(); // Cache preview metadata
    this.loadingPreviews = new Set();
    this.hoverTimeouts = new Map(); // Track hover timeouts
    this.HOVER_DELAY = 300; // 300ms delay before showing preview
    
    this.isSuspended = false;



    // Performance monitoring
    this.performanceMetrics = {
      totalPreviews: 0,
      successfulPreviews: 0,
      failedPreviews: 0,
      averageLoadTime: 0
    };

    if (typeof window !== 'undefined') {
      window.VideoUIEffects = window.VideoUIEffects || {};
    }

    const safeGetItem = (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch (storageError) {
        return null;
      }
    };

    const safeSetItem = (key, value) => {
      try {
        if (value === null || typeof value === 'undefined') {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }
      } catch (storageError) {
        // Ignore storage failures
      }
    };

    const storedDebugPreference = typeof window !== 'undefined' ? safeGetItem('vod-preview-debug') : null;
    this.debugEnabled = Boolean(window.VideoUIEffects && window.VideoUIEffects.previewDebug);

    if (storedDebugPreference === 'true') {
      this.debugEnabled = true;
    } else if (storedDebugPreference === 'false') {
      this.debugEnabled = false;
    }

    if (typeof window !== 'undefined' && window.VideoUIEffects) {
      window.VideoUIEffects.previewDebug = this.debugEnabled;
      window.VideoUIEffects.setPreviewDebug = (value) => {
        if (typeof value === 'boolean') {
          this.debugEnabled = value;
          safeSetItem('vod-preview-debug', value ? 'true' : 'false');
        } else {
          this.debugEnabled = false;
          safeSetItem('vod-preview-debug', null);
        }
        window.VideoUIEffects.previewDebug = this.debugEnabled;
      };
    }

    // Setup cleanup on page unload
    this.setupCleanup();
  }

  /**
   * Get a video element from the pool or create a new one
   * @returns {HTMLVideoElement}
   */
  getVideoElement() {
    let video;
    
    if (this.videoPool.length > 0) {
      video = this.videoPool.pop();
      this.debugLog(`[VideoPreview] Reusing video element from pool, current src: "${video.src}"`);
    } else {
      video = document.createElement('video');
      this.debugLog(`[VideoPreview] Created new video element`);
    }
    
    // Always reset and configure the video element
    video.muted = true;
    video.loop = true;
    video.preload = 'metadata'; // Changed from 'none' to 'metadata' for better loading
    video.playsInline = true; // Important for mobile
    video.autoplay = false;
    video.controls = false;
    video.removeAttribute('src');
    video.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
      z-index: 2;
    `;
    
    this.debugLog(`[VideoPreview] Video element configured, src: "${video.src}"`);
    return video;
  }

  /**
   * Release a video element back to the pool
   * @param {HTMLVideoElement} video
   */
  releaseVideoElement(video) {
    video.pause();
    video.removeAttribute('src');
    video.load(); // Ensure any in-flight load is cancelled
    video.currentTime = 0;
    video.style.opacity = '0';
    
    // Remove all event listeners
    const newVideo = video.cloneNode(false);
    if (video.parentNode) {
      video.parentNode.replaceChild(newVideo, video);
    }
    
    if (this.videoPool.length < this.maxPoolSize) {
      this.videoPool.push(newVideo);
    }
  }

  /**
   * Determine whether a video error should be ignored during expected teardown
   * @param {string} videoId
   * @param {HTMLVideoElement} video
   * @param {Event} event
   * @returns {boolean}
   */
  isExpectedTeardownError(videoId, video, event) {
    const activeVideo = this.activeVideos.get(videoId);
    if (!activeVideo || activeVideo.element !== video || activeVideo.isDisposing) {
      return true;
    }

    const mediaError = event && event.target && event.target.error ? event.target.error : null;
    const srcAttr = video.getAttribute('src');
    const hasNoSrc = !srcAttr;

    return Boolean(mediaError && mediaError.code === 4 && hasNoSrc);
  }

  primePreviewInfo(videoId, descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
      return;
    }

    const timestamp = descriptor.firstTimestamp;
    const hasPreview = descriptor.hasPreview === true &&
      Number.isSafeInteger(timestamp) &&
      timestamp >= 0;

    this.previewCache.set(String(videoId), {
      hasPreview,
      status: descriptor.status || 'pending',
      clips: hasPreview ? [{ timestamp }] : []
    });
  }

  /**
   * Preload preview info for a video
   * @param {string} videoId
   * @returns {Promise<Object>}
   */
  async preloadPreviewInfo(videoId) {
    if (this.previewCache.has(videoId)) {
      this.debugLog(`[VideoPreview] Using cached preview info for video ${videoId}`);
      return this.previewCache.get(videoId);
    }

    try {
      const startTime = performance.now();
      const apiUrl = resolveAppUrl(`/api/videos/${videoId}/preview-info`);
      this.debugLog(`[VideoPreview] Fetching preview info from: ${apiUrl}`);
      
      const response = await fetch(apiUrl);
      this.debugLog(`[VideoPreview] API response status: ${response.status} ${response.statusText}`);
      this.debug(() => this.debugLog(`[VideoPreview] API response headers:`, Object.fromEntries(response.headers.entries())));
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[VideoPreview] API error response body:`, errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const previewInfo = await response.json();
      const loadTime = performance.now() - startTime;
      
      this.debugLog(`[VideoPreview] Preview info loaded in ${loadTime.toFixed(2)}ms for video ${videoId}:`, previewInfo);
      
      // Update performance metrics
      this.updatePerformanceMetrics(loadTime, true);
      
      this.previewCache.set(videoId, previewInfo);
      return previewInfo;
    } catch (error) {
      console.error(`[VideoPreview] Failed to preload preview info for video ${videoId}:`, error);
      console.error(`[VideoPreview] Error details:`, {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      this.updatePerformanceMetrics(0, false);
      return { hasPreview: false, status: 'failed', clips: [] };
    }
  }

  /**
   * Show preview for a video card
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  async showPreview(cardElement, videoId) {
    this.debugLog(`[VideoPreview] Attempting to show preview for video ${videoId}`);

    // Check if preview system is suspended
    if (this.isSuspended) {
      this.debugLog(`[VideoPreview] Preview system is suspended, skipping preview for video ${videoId}`);
      return;
    }

    // Rate limiting - check concurrent previews
    if (this.activeVideos.size >= this.maxConcurrentPreviews) {
      this.debugLog(`[VideoPreview] Rate limited: ${this.activeVideos.size}/${this.maxConcurrentPreviews} active previews`);
      return;
    }

    // Check if already loading
    if (this.loadingPreviews.has(videoId)) {
      this.debugLog(`[VideoPreview] Already loading preview for video ${videoId}`);
      return;
    }

    this.loadingPreviews.add(videoId);

    try {
      this.debugLog(`[VideoPreview] Loading preview info for video ${videoId}`);
      const previewInfo = await this.preloadPreviewInfo(videoId);
      this.debugLog(`[VideoPreview] Preview info loaded for video ${videoId}:`, previewInfo);
      
      if (!previewInfo.hasPreview || previewInfo.clips.length === 0) {
        this.debugLog(`[VideoPreview] No preview clips available for video ${videoId}, using fallback`);
        this.showFallbackPreview(cardElement, videoId);
        return;
      }

      const video = this.getVideoElement();
      const thumbnailContainer = cardElement.querySelector('.thumbnail-container');
      
      if (!thumbnailContainer) {
        this.debugWarn(`[VideoPreview] No thumbnail container found for video ${videoId}`);
        this.releaseVideoElement(video);
        return;
      }

      // Position video element
      thumbnailContainer.style.position = 'relative';
      thumbnailContainer.appendChild(video);

      // Load and play preview
      const firstClip = previewInfo.clips[0];
      if (firstClip) {
        this.debugLog(`[VideoPreview] Loading clip for video ${videoId}:`, firstClip);
        
        // Use the API endpoint to serve the preview clip
        const videoSrc = resolveAppUrl(`/api/videos/${videoId}/preview/${firstClip.timestamp}`);
        this.debugLog(`[VideoPreview] Setting video src to API endpoint: ${videoSrc}`);
        this.debugLog(`[VideoPreview] Original clip path was: ${firstClip.path}`);
        video.src = videoSrc;
        
        // Add enhanced error handling
        const errorHandler = (event) => {
          if (this.isExpectedTeardownError(videoId, video, event)) {
            this.debugLog(`[VideoPreview] Ignoring expected preview teardown error for video ${videoId}`);
            return;
          }

          console.error(`[VideoPreview] Preview playback failed for video ${videoId}`);
          console.error(`[VideoPreview] Video element details:`, {
            src: video.src,
            readyState: video.readyState,
            networkState: video.networkState,
            error: video.error,
            currentTime: video.currentTime,
            duration: video.duration,
            paused: video.paused,
            muted: video.muted,
            autoplay: video.autoplay,
            preload: video.preload
          });
          if (event && event.target && event.target.error) {
            console.error(`[VideoPreview] Video error object:`, {
              code: event.target.error.code,
              message: event.target.error.message,
              MEDIA_ERR_ABORTED: event.target.error.MEDIA_ERR_ABORTED,
              MEDIA_ERR_NETWORK: event.target.error.MEDIA_ERR_NETWORK,
              MEDIA_ERR_DECODE: event.target.error.MEDIA_ERR_DECODE,
              MEDIA_ERR_SRC_NOT_SUPPORTED: event.target.error.MEDIA_ERR_SRC_NOT_SUPPORTED
            });
          }
          this.hidePreview(cardElement, videoId);
          this.showFallbackPreview(cardElement, videoId);
        };
        
        const loadHandler = () => {
          this.debugLog(`[VideoPreview] Video loaded successfully for video ${videoId}, attempting to play`);
          video.style.opacity = '1';
          video.play().catch((playError) => {
            console.error(`[VideoPreview] Play failed for video ${videoId}:`, playError);
            console.error(`[VideoPreview] Play error details:`, {
              name: playError.name,
              message: playError.message,
              stack: playError.stack
            });
            errorHandler();
          });
        };

        this.activeVideos.set(videoId, {
          element: video,
          container: thumbnailContainer,
          isDisposing: false,
          errorHandler,
          loadHandler
        });

        video.addEventListener('loadeddata', loadHandler, { once: true });
        video.addEventListener('error', errorHandler, { once: true });
        
        // Additional event listeners for debugging
        video.addEventListener('loadstart', () => {
          this.debugLog(`[VideoPreview] Load started for video ${videoId}, src: ${video.src}`);
        }, { once: true });
        
        video.addEventListener('canplay', () => {
          this.debugLog(`[VideoPreview] Can play video ${videoId}`);
        }, { once: true });
        
        video.addEventListener('canplaythrough', () => {
          this.debugLog(`[VideoPreview] Can play through video ${videoId}`);
        }, { once: true });
        
        // Add immediate verification of src setting
        setTimeout(() => {
          this.debugLog(`[VideoPreview] Video src verification for ${videoId}: ${video.src}`);
          this.debugLog(`[VideoPreview] Video currentSrc for ${videoId}: ${video.currentSrc}`);
        }, 10);

        this.performanceMetrics.totalPreviews++;
        this.performanceMetrics.successfulPreviews++;
        this.debugLog(`[VideoPreview] Preview setup complete for video ${videoId}`);
      }

    } catch (error) {
      console.error(`[VideoPreview] Preview loading failed for video ${videoId}:`, error);
      console.error(`[VideoPreview] Error stack:`, error.stack);
      this.showFallbackPreview(cardElement, videoId);
      this.performanceMetrics.failedPreviews++;
    } finally {
      this.loadingPreviews.delete(videoId);
    }
  }

  /**
   * Hide preview for a video card
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  hidePreview(cardElement, videoId) {
    const activeVideo = this.activeVideos.get(videoId);
    if (activeVideo) {
      activeVideo.isDisposing = true;
      if (typeof activeVideo.loadHandler === 'function') {
        activeVideo.element.removeEventListener('loadeddata', activeVideo.loadHandler);
      }
      if (typeof activeVideo.errorHandler === 'function') {
        activeVideo.element.removeEventListener('error', activeVideo.errorHandler);
      }

      activeVideo.element.style.opacity = '0';
      
      setTimeout(() => {
        if (activeVideo.container && activeVideo.container.contains(activeVideo.element)) {
          activeVideo.container.removeChild(activeVideo.element);
        }
        this.releaseVideoElement(activeVideo.element);
      }, 300); // Wait for fade transition

      this.activeVideos.delete(videoId);
    }
    
    // Clear any hover timeout
    if (this.hoverTimeouts.has(videoId)) {
      clearTimeout(this.hoverTimeouts.get(videoId));
      this.hoverTimeouts.delete(videoId);
    }
  }

  /**
   * Show fallback preview (enhanced thumbnail animation)
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  showFallbackPreview(cardElement, videoId) {
    const thumbnail = cardElement.querySelector('.thumbnail');
    if (thumbnail) {
      thumbnail.style.transform = 'scale(1.05)';
      thumbnail.style.transition = 'transform 0.3s ease';
      thumbnail.style.filter = 'brightness(1.1)';
    }
  }

  /**
   * Hide fallback preview
   * @param {HTMLElement} cardElement
   */
  hideFallbackPreview(cardElement) {
    const thumbnail = cardElement.querySelector('.thumbnail');
    if (thumbnail) {
      thumbnail.style.transform = 'scale(1)';
      thumbnail.style.filter = 'brightness(1)';
    }
  }

  /**
   * Handle hover events with debouncing
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  handleHover(cardElement, videoId) {
    this.debugLog(`[VideoPreview] Hover detected for video ${videoId}, delay: ${this.HOVER_DELAY}ms`);

    // Check if preview system is suspended
    if (this.isSuspended) {
      this.debugLog(`[VideoPreview] Preview system is suspended, ignoring hover for video ${videoId}`);
      return;
    }

    // Clear any existing timeout
    if (this.hoverTimeouts.has(videoId)) {
      this.debugLog(`[VideoPreview] Clearing existing hover timeout for video ${videoId}`);
      clearTimeout(this.hoverTimeouts.get(videoId));
    }

    const timeout = setTimeout(() => {
      this.debugLog(`[VideoPreview] Hover delay elapsed, triggering preview for video ${videoId}`);
      this.showPreview(cardElement, videoId);
    }, this.HOVER_DELAY);

    this.hoverTimeouts.set(videoId, timeout);
  }

  /**
   * Handle mouse leave events
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  handleMouseLeave(cardElement, videoId) {
    this.debugLog(`[VideoPreview] Mouse leave detected for video ${videoId}`);
    
    // Clear hover timeout
    if (this.hoverTimeouts.has(videoId)) {
      this.debugLog(`[VideoPreview] Clearing hover timeout on mouse leave for video ${videoId}`);
      clearTimeout(this.hoverTimeouts.get(videoId));
      this.hoverTimeouts.delete(videoId);
    }

    this.hidePreview(cardElement, videoId);
    this.hideFallbackPreview(cardElement);
  }

  /**
   * Attach preview event listeners to a video card
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  attachPreviewListeners(cardElement, videoId) {
    const mouseEnterHandler = () => this.handleHover(cardElement, videoId);
    const mouseLeaveHandler = () => this.handleMouseLeave(cardElement, videoId);

    cardElement.addEventListener('mouseenter', mouseEnterHandler);
    cardElement.addEventListener('mouseleave', mouseLeaveHandler);

    // Store handlers for cleanup
    cardElement._previewHandlers = {
      mouseEnter: mouseEnterHandler,
      mouseLeave: mouseLeaveHandler
    };
  }

  /**
   * Remove preview event listeners from a video card
   * @param {HTMLElement} cardElement
   */
  removePreviewListeners(cardElement) {
    if (cardElement._previewHandlers) {
      cardElement.removeEventListener('mouseenter', cardElement._previewHandlers.mouseEnter);
      cardElement.removeEventListener('mouseleave', cardElement._previewHandlers.mouseLeave);
      delete cardElement._previewHandlers;
    }
  }


  /**
   * Get adaptive quality based on network conditions
   * @returns {string}
   */
  getAdaptiveQuality() {
    if (navigator.connection) {
      const connection = navigator.connection;
      if (connection.effectiveType === '2g' || connection.downlink < 1) {
        return 'low';
      } else if (connection.effectiveType === '4g' && connection.downlink > 5) {
        return 'high';
      }
    }
    return 'medium';
  }

  /**
   * Update performance metrics
   * @param {number} loadTime
   * @param {boolean} success
   */
  updatePerformanceMetrics(loadTime, success) {
    if (success) {
      const currentAvg = this.performanceMetrics.averageLoadTime;
      const successCount = this.performanceMetrics.successfulPreviews;
      this.performanceMetrics.averageLoadTime = 
        (currentAvg * successCount + loadTime) / (successCount + 1);
    }
  }

  /**
   * Get performance metrics
   * @returns {Object}
   */
  getPerformanceMetrics() {
    return { ...this.performanceMetrics };
  }

  debugLog(...args) {
    if (!this.debugEnabled) {
      return;
    }
    console.log(...args);
  }

  debugWarn(...args) {
    if (!this.debugEnabled) {
      return;
    }
    console.warn(...args);
  }

  debug(callback) {
    if (!this.debugEnabled || typeof callback !== 'function') {
      return;
    }
    callback();
  }

  /**
   * Pause the video preview system
   * Prevents new previews from starting and clears existing timeouts
   */
  pause() {
    if (this.isSuspended) {
      return; // Already paused
    }

    this.isSuspended = true;

    // Clear all pending hover timeouts
    this.hoverTimeouts.forEach(timeout => clearTimeout(timeout));
    this.hoverTimeouts.clear();

    // Pause all active video previews
    this.activeVideos.forEach((activeVideo, videoId) => {
      if (activeVideo.element && typeof activeVideo.element.pause === 'function') {
        activeVideo.element.pause();
      }
    });

    console.log('[VideoPreview] Preview system paused');
  }

  /**
   * Resume the video preview system
   * Allows new previews to start again
   */
  resume() {
    if (!this.isSuspended) {
      return; // Already running
    }

    this.isSuspended = false;
    console.log('[VideoPreview] Preview system resumed');
  }

  /**
   * Setup cleanup handlers
   */
  setupCleanup() {
    window.addEventListener('beforeunload', () => {
      this.cleanup();
    });

    // Cleanup on page visibility change (mobile background)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.cleanup();
      }
    });
  }

  /**
   * Clean up all resources
   */
  cleanup() {
    // Clear all active previews
    this.activeVideos.forEach((activeVideo, videoId) => {
      if (activeVideo.container && activeVideo.container.contains(activeVideo.element)) {
        activeVideo.container.removeChild(activeVideo.element);
      }
    });
    
    this.activeVideos.clear();
    this.videoPool = [];
    this.previewCache.clear();
    this.loadingPreviews.clear();
    
    // Clear all hover timeouts
    this.hoverTimeouts.forEach(timeout => clearTimeout(timeout));
    this.hoverTimeouts.clear();
  }
}

// Export for both module and global usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VideoPreviewManager };
} else {
  window.VideoPreviewManager = VideoPreviewManager;
}
