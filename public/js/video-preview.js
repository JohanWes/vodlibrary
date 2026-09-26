/**
 * Hover video previews for grid cards.
 * Pools <video> elements, limits concurrency, and tears every preview down
 * (pause + remove src + load()) when the pointer leaves or the grid re-renders.
 */

class VideoPreviewManager {
  constructor() {
    this.videoPool = [];
    this.activeVideos = new Map(); // videoId -> { element, container, listeners: AbortController }
    this.pendingPreviews = new Map(); // videoId -> AbortController for an in-flight showPreview
    this.hoverTimeouts = new Map();
    this.previewCache = new Map();
    this.maxPoolSize = 3;
    this.maxConcurrentPreviews = 2;
    this.HOVER_DELAY = 300; // hover intent: ignore cards the pointer merely passes over
    this.FADE_MS = 300;
    this.isSuspended = false;

    // Previews are hidden by CSS on narrow/touch layouts; don't download them there.
    this.previewMedia = typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: hover) and (min-width: 769px)')
      : null;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.hideAll();
    });
  }

  /**
   * @returns {HTMLVideoElement} A reset element from the pool, or a new one
   */
  getVideoElement() {
    const video = this.videoPool.pop() || document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.autoplay = false;
    video.controls = false;
    video.removeAttribute('src');
    video.className = 'preview-video';
    return video;
  }

  /**
   * Stop a preview element, cancel its network activity and return it to the pool
   * @param {HTMLVideoElement} video
   */
  releaseVideoElement(video) {
    video.pause();
    video.removeAttribute('src');
    video.load(); // cancels any in-flight request
    video.classList.remove('is-playing');
    video.remove();
    if (this.videoPool.length < this.maxPoolSize && !this.videoPool.includes(video)) {
      this.videoPool.push(video);
    }
  }

  /**
   * Seed preview metadata from the list response so hovering needs no extra request
   * @param {string} videoId
   * @param {{hasPreview: boolean, firstTimestamp: number|null}} descriptor
   */
  primePreviewInfo(videoId, descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
      return;
    }

    const timestamp = descriptor.firstTimestamp;
    const hasPreview = descriptor.hasPreview === true &&
      Number.isSafeInteger(timestamp) &&
      timestamp >= 0;

    this.previewCache.set(String(videoId), { hasPreview, clips: hasPreview ? [{ timestamp }] : [] });
  }

  /**
   * @param {string} videoId
   * @param {AbortSignal} [signal]
   * @returns {Promise<Object|null>} Preview info, or null when aborted
   */
  async preloadPreviewInfo(videoId, signal) {
    if (this.previewCache.has(videoId)) {
      return this.previewCache.get(videoId);
    }

    try {
      const response = await fetch(appUrl(`/api/videos/${videoId}/preview-info`), { signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const previewInfo = await response.json();
      this.previewCache.set(videoId, previewInfo);
      return previewInfo;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return null;
      }
      console.warn(`[VideoPreview] No preview info for video ${videoId}:`, error);
      return { hasPreview: false, status: 'failed', clips: [] };
    }
  }

  /**
   * Show the hover preview for a card
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  async showPreview(cardElement, videoId) {
    if (this.isSuspended || this.pendingPreviews.has(videoId) || this.activeVideos.has(videoId)) {
      return;
    }
    if (this.activeVideos.size >= this.maxConcurrentPreviews) {
      return;
    }

    const controller = new AbortController();
    this.pendingPreviews.set(videoId, controller);

    try {
      const previewInfo = await this.preloadPreviewInfo(videoId, controller.signal);

      // The pointer may have left, the grid may have re-rendered, or the overlay opened meanwhile.
      if (!previewInfo || controller.signal.aborted || this.isSuspended || !cardElement.isConnected) {
        return;
      }

      const clip = previewInfo.hasPreview && previewInfo.clips && previewInfo.clips[0];
      const thumbnailContainer = cardElement.querySelector('.thumbnail-container');
      if (!clip || !thumbnailContainer) {
        cardElement.classList.add('preview-fallback');
        return;
      }
      if (this.activeVideos.size >= this.maxConcurrentPreviews) {
        return;
      }

      const video = this.getVideoElement();
      const listeners = new AbortController();
      const onError = () => {
        this.hidePreview(cardElement, videoId);
        cardElement.classList.add('preview-fallback');
      };
      video.addEventListener('loadeddata', () => {
        video.classList.add('is-playing');
        video.play().catch((playError) => {
          if (playError && playError.name === 'AbortError') return; // teardown interrupted play()
          console.warn(`[VideoPreview] Play failed for video ${videoId}:`, playError);
          onError();
        });
      }, { once: true, signal: listeners.signal });
      video.addEventListener('error', onError, { once: true, signal: listeners.signal });

      this.activeVideos.set(videoId, { element: video, container: thumbnailContainer, listeners });
      thumbnailContainer.appendChild(video);
      video.src = appUrl(`/api/videos/${videoId}/preview/${clip.timestamp}`);
    } finally {
      if (this.pendingPreviews.get(videoId) === controller) {
        this.pendingPreviews.delete(videoId);
      }
    }
  }

  /**
   * Hide the preview for a card (fades out, then releases the element)
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   * @param {{immediate?: boolean}} [options]
   */
  hidePreview(cardElement, videoId, { immediate = false } = {}) {
    if (this.hoverTimeouts.has(videoId)) {
      clearTimeout(this.hoverTimeouts.get(videoId));
      this.hoverTimeouts.delete(videoId);
    }

    const pending = this.pendingPreviews.get(videoId);
    if (pending) {
      pending.abort();
      this.pendingPreviews.delete(videoId);
    }

    const activeVideo = this.activeVideos.get(videoId);
    if (!activeVideo) {
      return;
    }
    this.activeVideos.delete(videoId);
    if (activeVideo.listeners) {
      activeVideo.listeners.abort();
    }

    const video = activeVideo.element;
    const container = activeVideo.container;
    if (immediate || !container || !container.isConnected) {
      this.releaseVideoElement(video);
      return;
    }
    video.classList.remove('is-playing');
    setTimeout(() => this.releaseVideoElement(video), this.FADE_MS);
  }

  /**
   * Tear down every preview immediately. Call before clearing or re-rendering the grid.
   */
  hideAll() {
    this.hoverTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.hoverTimeouts.clear();
    this.pendingPreviews.forEach((controller) => controller.abort());
    this.pendingPreviews.clear();
    [...this.activeVideos.keys()].forEach((videoId) => {
      const { container } = this.activeVideos.get(videoId);
      const card = container && container.closest ? container.closest('.video-card') : null;
      this.hidePreview(card, videoId, { immediate: true });
    });
    document.querySelectorAll('.video-card.preview-fallback').forEach((card) => {
      card.classList.remove('preview-fallback');
    });
  }

  /**
   * Start the hover-intent timer for a card
   * @param {HTMLElement} cardElement
   * @param {string} videoId
   */
  handleHover(cardElement, videoId) {
    if (this.isSuspended || (this.previewMedia && !this.previewMedia.matches)) {
      return;
    }
    if (this.hoverTimeouts.has(videoId)) {
      clearTimeout(this.hoverTimeouts.get(videoId));
    }
    this.hoverTimeouts.set(videoId, setTimeout(() => {
      this.hoverTimeouts.delete(videoId);
      this.showPreview(cardElement, videoId);
    }, this.HOVER_DELAY));
  }

  handleMouseLeave(cardElement, videoId) {
    this.hidePreview(cardElement, videoId);
    cardElement.classList.remove('preview-fallback');
  }

  /**
   * Delegate hover handling for every card in a grid (mouse pointers only)
   * @param {HTMLElement} grid
   */
  attachToGrid(grid) {
    const cardFrom = (event) => {
      const card = event.target && event.target.closest ? event.target.closest('.video-card') : null;
      if (!card || !grid.contains(card) || !card.dataset.id) return null;
      // Moving between elements inside the same card is not an enter/leave.
      if (event.relatedTarget && card.contains(event.relatedTarget)) return null;
      return card;
    };
    grid.addEventListener('pointerover', (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const card = cardFrom(event);
      if (card) this.handleHover(card, card.dataset.id);
    });
    grid.addEventListener('pointerout', (event) => {
      const card = cardFrom(event);
      if (card) this.handleMouseLeave(card, card.dataset.id);
    });
  }

  /** Stop previews while the overlay player is open. */
  pause() {
    this.isSuspended = true;
    this.hideAll();
  }

  resume() {
    this.isSuspended = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VideoPreviewManager };
} else {
  window.VideoPreviewManager = VideoPreviewManager;
}
