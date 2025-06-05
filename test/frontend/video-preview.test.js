/**
 * @jest-environment jsdom
 */

// jest is available globally from setup.js

// Mock DOM environment
global.fetch = jest.fn();
global.HTMLVideoElement.prototype.play = jest.fn().mockImplementation(() => Promise.resolve());
global.HTMLVideoElement.prototype.pause = jest.fn();

// Mock the VideoPreviewManager class that we'll implement
let VideoPreviewManager;

describe('VideoPreviewManager - Hover Preview Tests', () => {
  let manager;
  let mockVideoCard;
  let mockThumbnailContainer;

  beforeEach(async () => {
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
    
    // Load the VideoPreviewManager
    require('../../public/js/video-preview.js');
    VideoPreviewManager = global.VideoPreviewManager || global.window.VideoPreviewManager;
    manager = new VideoPreviewManager();
  });

  afterEach(() => {
    if (manager) {
      manager.cleanup();
    }
    jest.clearAllMocks();
  });

  describe('Hover Trigger Tests', () => {
    test('should trigger preview on thumbnail mouseover after delay', async () => {
      // Mock successful preview info response
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: true,
          status: 'completed',
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      });

      const showPreviewSpy = jest.spyOn(manager, 'showPreview');

      // Trigger mouseenter event
      const mouseenterEvent = new Event('mouseenter');
      mockVideoCard.dispatchEvent(mouseenterEvent);

      // Should not trigger immediately (due to delay)
      expect(showPreviewSpy).not.toHaveBeenCalled();

      // Wait for hover delay (800ms + some buffer)
      await new Promise(resolve => setTimeout(resolve, 900));

      expect(showPreviewSpy).toHaveBeenCalledWith(mockVideoCard, '1');
    });

    test('should not trigger preview if mouse leaves before delay', async () => {
      const showPreviewSpy = jest.spyOn(manager, 'showPreview');

      // Trigger mouseenter then mouseleave quickly
      mockVideoCard.dispatchEvent(new Event('mouseenter'));
      
      // Leave before delay
      setTimeout(() => {
        mockVideoCard.dispatchEvent(new Event('mouseleave'));
      }, 200);

      // Wait longer than delay
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(showPreviewSpy).not.toHaveBeenCalled();
    });

    test('should stop preview when mouse leaves thumbnail', async () => {
      const hidePreviewSpy = jest.spyOn(manager, 'hidePreview');

      // First trigger a preview
      mockVideoCard.dispatchEvent(new Event('mouseenter'));
      await new Promise(resolve => setTimeout(resolve, 900));

      // Then leave
      mockVideoCard.dispatchEvent(new Event('mouseleave'));

      expect(hidePreviewSpy).toHaveBeenCalledWith(mockVideoCard, '1');
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
    test('should fallback to enhanced thumbnail when preview clips unavailable', async () => {
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

    test('should handle video element errors gracefully', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          hasPreview: true,
          status: 'completed',
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      });

      // Mock video element error
      const mockVideo = document.createElement('video');
      const errorSpy = jest.fn();
      mockVideo.addEventListener('error', errorSpy);

      jest.spyOn(manager, 'getVideoElement').mockReturnValue(mockVideo);
      const fallbackSpy = jest.spyOn(manager, 'showFallbackPreview');

      await manager.showPreview(mockVideoCard, '1');

      // Simulate video error
      mockVideo.dispatchEvent(new Event('error'));

      expect(fallbackSpy).toHaveBeenCalled();
    });
  });

  describe('Memory Management Tests', () => {
    test('should properly manage video element pool', () => {
      const video1 = manager.getVideoElement();
      const video2 = manager.getVideoElement();

      expect(video1).toBeInstanceOf(HTMLVideoElement);
      expect(video2).toBeInstanceOf(HTMLVideoElement);
      expect(video1).not.toBe(video2);

      // Release and get again - should reuse
      manager.releaseVideoElement(video1);
      const video3 = manager.getVideoElement();

      expect(video3).toBe(video1);
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

    test('should clean up video elements properly on release', () => {
      const video = manager.getVideoElement();
      video.src = 'test.mp4';
      video.currentTime = 10;

      manager.releaseVideoElement(video);

      expect(video.src).toBe('');
      expect(video.currentTime).toBe(0);
      expect(video.style.opacity).toBe('0');
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
    test('should debounce rapid hover events', async () => {
      const showPreviewSpy = jest.spyOn(manager, 'showPreview');

      // Rapid mouseenter/mouseleave events
      for (let i = 0; i < 5; i++) {
        mockVideoCard.dispatchEvent(new Event('mouseenter'));
        mockVideoCard.dispatchEvent(new Event('mouseleave'));
      }

      // Final mouseenter
      mockVideoCard.dispatchEvent(new Event('mouseenter'));

      await new Promise(resolve => setTimeout(resolve, 900));

      // Should only call showPreview once for the final event
      expect(showPreviewSpy).toHaveBeenCalledTimes(1);
    });

    test('should not start loading if already loading same video', async () => {
      global.fetch.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: () => Promise.resolve({ hasPreview: true, clips: [] })
        }), 500))
      );

      // Start two previews for same video quickly
      const promise1 = manager.showPreview(mockVideoCard, '1');
      const promise2 = manager.showPreview(mockVideoCard, '1');

      await Promise.all([promise1, promise2]);

      // Should only make one fetch call
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
});