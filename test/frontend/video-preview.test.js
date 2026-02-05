/**
 * @jest-environment jsdom
 */

// jest is available globally from setup.js

// Mock DOM environment
global.fetch = jest.fn();
global.HTMLVideoElement.prototype.play = jest.fn().mockImplementation(() => Promise.resolve());
global.HTMLVideoElement.prototype.pause = jest.fn();

// Mock performance API
global.performance = {
  now: jest.fn().mockReturnValue(1000),
  mark: jest.fn(),
  measure: jest.fn()
};

// Import VideoPreviewManager using require (CommonJS export)
const { VideoPreviewManager } = require('../../public/js/video-preview.js');

describe('VideoPreviewManager - Hover Preview Tests', () => {
  let manager;
  let mockVideoCard;
  let mockThumbnailContainer;

  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';

    // Create mock video card element
    mockVideoCard = document.createElement('div');
    mockVideoCard.className = 'video-card';
    mockVideoCard.dataset.id = '1';

    mockThumbnailContainer = document.createElement('div');
    mockThumbnailContainer.className = 'thumbnail-container';
    mockVideoCard.appendChild(mockThumbnailContainer);

    document.body.appendChild(mockVideoCard);

    // Mock fetch responses
    global.fetch.mockClear();

    // Create fresh manager instance
    manager = new VideoPreviewManager();
  });

  afterEach(() => {
    if (manager) {
      manager.cleanup();
    }
    jest.clearAllMocks();
  });

  describe('Hover Trigger Tests', () => {
    test('should trigger preview via handleHover after delay', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: true,
          status: 'completed',
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      });

      const showPreviewSpy = jest.spyOn(manager, 'showPreview');

      // Use handleHover which sets up the delay
      manager.handleHover(mockVideoCard, '1');

      // Should not trigger immediately (due to delay)
      expect(showPreviewSpy).not.toHaveBeenCalled();

      // Wait for hover delay (500ms + buffer)
      await new Promise(resolve => setTimeout(resolve, 700));

      expect(showPreviewSpy).toHaveBeenCalledWith(mockVideoCard, '1');
    });

    test('should not trigger preview if cancelled before delay', async () => {
      const showPreviewSpy = jest.spyOn(manager, 'showPreview');

      // Start hover then cancel quickly
      manager.handleHover(mockVideoCard, '1');

      // Cancel before delay
      manager.handleMouseLeave(mockVideoCard, '1');

      // Wait longer than delay
      await new Promise(resolve => setTimeout(resolve, 700));

      expect(showPreviewSpy).not.toHaveBeenCalled();
    });

    test('should hide preview when mouse leaves', async () => {
      const hidePreviewSpy = jest.spyOn(manager, 'hidePreview');

      manager.handleMouseLeave(mockVideoCard, '1');

      expect(hidePreviewSpy).toHaveBeenCalledWith(mockVideoCard, '1');
    });
  });

  describe('Event Listener Attachment', () => {
    test('should attach and remove preview listeners', () => {
      manager.attachPreviewListeners(mockVideoCard, '1');

      expect(mockVideoCard._previewHandlers).toBeDefined();
      expect(mockVideoCard._previewHandlers.mouseEnter).toBeDefined();
      expect(mockVideoCard._previewHandlers.mouseLeave).toBeDefined();

      manager.removePreviewListeners(mockVideoCard);

      expect(mockVideoCard._previewHandlers).toBeUndefined();
    });
  });

  describe('Multiple Simultaneous Previews', () => {
    test('should limit concurrent previews to maximum allowed', async () => {
      const videoCard1 = mockVideoCard;
      const videoCard2 = document.createElement('div');
      videoCard2.className = 'video-card';
      videoCard2.dataset.id = '2';
      videoCard2.appendChild(document.createElement('div'));
      videoCard2.querySelector('div').className = 'thumbnail-container';

      const videoCard3 = document.createElement('div');
      videoCard3.className = 'video-card';
      videoCard3.dataset.id = '3';
      videoCard3.appendChild(document.createElement('div'));
      videoCard3.querySelector('div').className = 'thumbnail-container';

      document.body.appendChild(videoCard2);
      document.body.appendChild(videoCard3);

      // Mock successful responses for all videos
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: true,
          status: 'completed',
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      });

      // Trigger previews for all three videos
      await manager.showPreview(videoCard1, '1');
      await manager.showPreview(videoCard2, '2');
      await manager.showPreview(videoCard3, '3');

      // Should only have maximum concurrent previews active
      expect(manager.activeVideos.size).toBeLessThanOrEqual(manager.maxConcurrentPreviews);
    });

    test('should not conflict when multiple previews are active', async () => {
      const videoCard2 = document.createElement('div');
      videoCard2.className = 'video-card';
      videoCard2.dataset.id = '2';
      videoCard2.appendChild(document.createElement('div'));
      videoCard2.querySelector('div').className = 'thumbnail-container';
      document.body.appendChild(videoCard2);

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: true,
          status: 'completed',
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      });

      // Start both previews
      await manager.showPreview(mockVideoCard, '1');
      await manager.showPreview(videoCard2, '2');

      // Both should be tracked separately
      expect(manager.activeVideos.has('1')).toBe(true);
      expect(manager.activeVideos.has('2')).toBe(true);

      // Hide one preview
      manager.hidePreview(mockVideoCard, '1');

      // Only one should remain
      expect(manager.activeVideos.has('1')).toBe(false);
      expect(manager.activeVideos.has('2')).toBe(true);
    });
  });

  describe('Graceful Fallback Tests', () => {
    test('should fallback when preview clips unavailable', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: false,
          status: 'failed',
          clips: []
        })
      });

      const showFallbackSpy = jest.spyOn(manager, 'showFallbackPreview');

      await manager.showPreview(mockVideoCard, '1');

      expect(showFallbackSpy).toHaveBeenCalledWith(mockVideoCard, '1');
    });

    test('should fallback when preview loading fails', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const showFallbackSpy = jest.spyOn(manager, 'showFallbackPreview');

      await manager.showPreview(mockVideoCard, '1');

      expect(showFallbackSpy).toHaveBeenCalledWith(mockVideoCard, '1');
    });

    test('should ignore empty-src media errors during preview teardown', async () => {
      jest.useFakeTimers();
      try {
        global.fetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            hasPreview: true,
            status: 'completed',
            clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
          })
        });

        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const showFallbackSpy = jest.spyOn(manager, 'showFallbackPreview');

        await manager.showPreview(mockVideoCard, '1');

        const activeVideo = manager.activeVideos.get('1');
        expect(activeVideo).toBeDefined();

        manager.hidePreview(mockVideoCard, '1');

        Object.defineProperty(activeVideo.element, 'error', {
          configurable: true,
          value: {
            code: 4,
            message: 'MEDIA_ELEMENT_ERROR: Empty src attribute',
            MEDIA_ERR_ABORTED: 1,
            MEDIA_ERR_NETWORK: 2,
            MEDIA_ERR_DECODE: 3,
            MEDIA_ERR_SRC_NOT_SUPPORTED: 4
          }
        });

        activeVideo.element.dispatchEvent(new Event('error'));
        jest.advanceTimersByTime(350);

        expect(showFallbackSpy).not.toHaveBeenCalled();
        expect(
          consoleErrorSpy.mock.calls.some(
            (args) =>
              typeof args[0] === 'string'
              && args[0].includes('[VideoPreview] Preview playback failed for video 1')
          )
        ).toBe(false);

        consoleErrorSpy.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Memory Management Tests', () => {
    test('should properly create video elements from pool', () => {
      const video1 = manager.getVideoElement();
      const video2 = manager.getVideoElement();

      expect(video1).toBeInstanceOf(HTMLVideoElement);
      expect(video2).toBeInstanceOf(HTMLVideoElement);
      expect(video1).not.toBe(video2);
    });

    test('should respect maximum pool size', () => {
      const videos = [];

      // Create videos beyond pool size
      for (let i = 0; i < manager.maxPoolSize + 2; i++) {
        videos.push(manager.getVideoElement());
      }

      // Release all videos
      videos.forEach(video => manager.releaseVideoElement(video));

      // Pool should not exceed max size
      expect(manager.videoPool.length).toBeLessThanOrEqual(manager.maxPoolSize);
    });

    test('should clean up all active previews on manager cleanup', () => {
      // Create active previews
      manager.activeVideos.set('1', { element: document.createElement('video'), container: mockThumbnailContainer });
      manager.activeVideos.set('2', { element: document.createElement('video'), container: mockThumbnailContainer });

      manager.cleanup();

      expect(manager.activeVideos.size).toBe(0);
      expect(manager.videoPool.length).toBe(0);
    });
  });

  describe('Performance Tests', () => {
    test('should not start loading if already loading same video', async () => {
      global.fetch.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: () => Promise.resolve({ hasPreview: true, clips: [] })
        }), 100))
      );

      // Start two previews for same video quickly
      const promise1 = manager.showPreview(mockVideoCard, '1');
      const promise2 = manager.showPreview(mockVideoCard, '1');

      await Promise.all([promise1, promise2]);

      // Should only make one fetch call (deduplication via loadingPreviews set)
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('should cache preview info to avoid repeated API calls', async () => {
      const previewInfo = {
        hasPreview: true,
        status: 'completed',
        clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(previewInfo)
      });

      // Load preview info twice
      await manager.preloadPreviewInfo('1');
      await manager.preloadPreviewInfo('1');

      // Should only make one API call due to caching
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(manager.previewCache.get('1')).toEqual(previewInfo);
    });
  });

  describe('Adaptive Quality', () => {
    test('should return low quality for slow networks', () => {
      Object.defineProperty(navigator, 'connection', {
        value: { effectiveType: '2g', downlink: 0.5 },
        configurable: true
      });

      expect(manager.getAdaptiveQuality()).toBe('low');
    });

    test('should return high quality for fast networks', () => {
      Object.defineProperty(navigator, 'connection', {
        value: { effectiveType: '4g', downlink: 10 },
        configurable: true
      });

      expect(manager.getAdaptiveQuality()).toBe('high');
    });

    test('should return medium quality when connection info unavailable', () => {
      Object.defineProperty(navigator, 'connection', {
        value: undefined,
        configurable: true
      });

      expect(manager.getAdaptiveQuality()).toBe('medium');
    });
  });
});
