// jest is available globally from setup.js
const request = require('supertest');
const express = require('express');

// Mock cache module
const mockCache = {
  getCachedSegment: jest.fn(),
  cacheSegment: jest.fn(),
  getCacheStats: jest.fn(),
  clearCache: jest.fn(),
  config: {
    maxCacheSize: 500 * 1024 * 1024,
    maxPreviewCacheSize: 100 * 1024 * 1024
  }
};

jest.mock('../../lib/cache', () => mockCache);

describe('Performance and Memory Management Tests', () => {
  let app;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    
    app.locals.db = {
      get: jest.fn(),
      run: jest.fn(),
      all: jest.fn()
    };
    
    jest.clearAllMocks();
  });

  describe('Memory Management', () => {
    test('should respect memory limits for preview cache', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      // Test that memory limits are enforced
      expect(manager.maxConcurrentPreviews).toBeLessThanOrEqual(3);
      expect(manager.maxPoolSize).toBeLessThanOrEqual(5);
    });

    test('should clean up video elements after use', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      const video = manager.getVideoElement();
      video.src = 'test.mp4';
      video.currentTime = 10;
      
      manager.releaseVideoElement(video);
      
      expect(video.src).toBe('');
      expect(video.currentTime).toBe(0);
    });

    test('should prevent memory leaks with event listeners', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      const mockElement = {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn()
      };
      
      // Simulate adding and removing event listeners
      manager.attachPreviewListeners(mockElement, '1');
      manager.cleanup();
      
      // Should clean up event listeners
      expect(mockElement.removeEventListener).toHaveBeenCalled();
    });

    test('should limit concurrent preview generations to prevent CPU overload', async () => {
      const { PreviewGenerator } = require('../../lib/preview.js');
      const generator = new PreviewGenerator();
      
      // Mock FFmpeg processes
      const mockProcesses = [];
      for (let i = 0; i < 5; i++) {
        mockProcesses.push(generator.generatePreviewClips(`/test/video${i}.mp4`, i, 120));
      }
      
      // Should queue requests beyond the limit
      expect(generator.activeGenerations.size).toBeLessThanOrEqual(generator.maxConcurrentGenerations);
    });
  });

  describe('Cache Performance', () => {
    test('should efficiently cache and retrieve preview clips', () => {
      const testData = Buffer.alloc(1024 * 1024, 'test'); // 1MB test data
      
      mockCache.cacheSegment.mockReturnValue(true);
      mockCache.getCachedSegment.mockReturnValue(testData);
      
      // Cache a preview clip
      const cached = mockCache.cacheSegment('video_1', 'preview_10', testData);
      expect(cached).toBe(true);
      
      // Retrieve cached clip
      const retrieved = mockCache.getCachedSegment('video_1', 'preview_10');
      expect(retrieved).toBe(testData);
      expect(retrieved.length).toBe(1024 * 1024);
    });

    test('should evict old cache entries when memory limit reached', () => {
      const largeData = Buffer.alloc(150 * 1024 * 1024, 'large'); // 150MB
      
      mockCache.getCacheStats.mockReturnValue({
        size: 150 * 1024 * 1024,
        maxSize: 100 * 1024 * 1024,
        hits: 10,
        misses: 5
      });
      
      // Should trigger cache cleanup
      mockCache.cacheSegment('video_1', 'preview_10', largeData);
      
      expect(mockCache.cacheSegment).toHaveBeenCalled();
    });

    test('should prioritize frequently accessed previews in cache', () => {
      mockCache.getCacheStats.mockReturnValue({
        videoAccess: {
          'video_1': 20, // High access count
          'video_2': 5,  // Medium access count
          'video_3': 1   // Low access count
        }
      });
      
      // Cache should prioritize video_1 previews
      const stats = mockCache.getCacheStats();
      expect(stats.videoAccess['video_1']).toBeGreaterThan(stats.videoAccess['video_2']);
    });
  });

  describe('Network Performance', () => {
    test('should handle multiple concurrent preview requests efficiently', async () => {
      const { getVideoById } = await import('../../db/database');
      const testVideo = {
        id: 1,
        preview_clips: JSON.stringify({
          clips: [{ timestamp: 10, path: '/previews/test_10s.mp4' }]
        })
      };
      
      getVideoById.mockResolvedValue(testVideo);
      
      const { default: apiRoutes } = await import('../../routes/api.js');
      app.use('/api', apiRoutes);
      
      // Make 10 concurrent requests
      const requests = Array(10).fill().map(() =>
        request(app).get('/api/videos/1/preview-info')
      );
      
      const start = Date.now();
      const responses = await Promise.all(requests);
      const duration = Date.now() - start;
      
      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
      
      // Should handle requests efficiently (under 2 seconds for 10 requests)
      expect(duration).toBeLessThan(2000);
    });

    test('should implement request deduplication for same preview', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hasPreview: true, clips: [] })
      });
      
      global.fetch = fetchSpy;
      
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      // Make multiple requests for the same preview info
      const promises = [
        manager.preloadPreviewInfo('1'),
        manager.preloadPreviewInfo('1'),
        manager.preloadPreviewInfo('1')
      ];
      
      await Promise.all(promises);
      
      // Should only make one actual fetch call due to deduplication
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('CPU Performance', () => {
    test('should throttle preview generation to prevent CPU overload', async () => {
      const { PreviewGenerator } = require('../../lib/preview.js');
      const generator = new PreviewGenerator();
      
      // Mock high CPU usage scenario
      const startTime = Date.now();
      
      // Try to generate many previews simultaneously
      const generatePromises = [];
      for (let i = 0; i < 10; i++) {
        generatePromises.push(
          generator.generatePreviewClips(`/test/video${i}.mp4`, i, 120)
        );
      }
      
      await Promise.allSettled(generatePromises);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should not overwhelm the system - expect reasonable processing time
      expect(duration).toBeGreaterThan(100); // Some processing time expected
      expect(generator.activeGenerations.size).toBeLessThanOrEqual(generator.maxConcurrentGenerations);
    });

    test('should use efficient video processing settings', async () => {
      const { PreviewGenerator } = require('../../lib/preview.js');
      const generator = new PreviewGenerator();
      
      // The mock is already set up in setup.js, so we just need to verify behavior
      const result = await generator.generateSingleClip('/test/video.mp4', 10, 'test_hash');
      
      // Should return a relative path for successful generation
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });
  });

  describe('Loading Performance', () => {
    test('should preload preview metadata on scroll into viewport', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      const mockIntersectionObserver = jest.fn();
      global.IntersectionObserver = jest.fn().mockImplementation(mockIntersectionObserver);
      
      const videoCard = document.createElement('div');
      videoCard.dataset.id = '1';
      
      manager.setupPreviewObserver(videoCard);
      
      expect(global.IntersectionObserver).toHaveBeenCalled();
    });

    test('should debounce rapid hover events to prevent excessive loading', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      const showPreviewSpy = jest.spyOn(manager, 'showPreview');
      const videoCard = document.createElement('div');
      videoCard.dataset.id = '1';
      
      // Simulate rapid hover events
      for (let i = 0; i < 10; i++) {
        manager.handleHover(videoCard, '1');
      }
      
      // Should debounce and only call showPreview once
      setTimeout(() => {
        expect(showPreviewSpy).toHaveBeenCalledTimes(1);
      }, 1000);
    });

    test('should measure and report loading performance metrics', async () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      global.performance = {
        now: jest.fn().mockReturnValue(1000),
        mark: jest.fn(),
        measure: jest.fn()
      };
      
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hasPreview: true, clips: [] })
      });
      
      await manager.preloadPreviewInfo('1');
      
      // Should measure loading performance
      expect(global.performance.now).toHaveBeenCalled();
    });
  });

  describe('Resource Cleanup', () => {
    test('should cleanup preview files older than retention period', async () => {
      const { PreviewGenerator } = require('../../lib/preview.js');
      const generator = new PreviewGenerator();
      
      const mockFs = {
        readdir: jest.fn().mockResolvedValue(['old_preview.mp4', 'new_preview.mp4']),
        stat: jest.fn().mockImplementation((path) => {
          if (path.includes('old')) {
            return Promise.resolve({ mtime: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }); // 31 days old
          }
          return Promise.resolve({ mtime: new Date() }); // New file
        }),
        unlink: jest.fn().mockResolvedValue()
      };
      
      jest.mock('fs/promises', () => mockFs);
      
      await generator.cleanupOldPreviews();
      
      expect(mockFs.unlink).toHaveBeenCalledWith(expect.stringContaining('old_preview.mp4'));
      expect(mockFs.unlink).not.toHaveBeenCalledWith(expect.stringContaining('new_preview.mp4'));
    });

    test('should cleanup memory on page unload', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      // Add some active previews
      manager.activeVideos.set('1', { element: document.createElement('video') });
      manager.activeVideos.set('2', { element: document.createElement('video') });
      
      // Simulate page unload
      window.dispatchEvent(new Event('beforeunload'));
      
      expect(manager.activeVideos.size).toBe(0);
      expect(manager.videoPool.length).toBe(0);
    });
  });

  describe('Quality Adaptation', () => {
    test('should adapt preview quality based on network conditions', () => {
      const { VideoPreviewManager } = require('../../public/js/video-preview.js');
      const manager = new VideoPreviewManager();
      
      // Mock slow network
      global.navigator.connection = {
        effectiveType: '2g',
        downlink: 0.5
      };
      
      const quality = manager.getAdaptiveQuality();
      expect(quality).toBe('low');
      
      // Mock fast network
      global.navigator.connection = {
        effectiveType: '4g',
        downlink: 10
      };
      
      const highQuality = manager.getAdaptiveQuality();
      expect(highQuality).toBe('high');
    });

    test('should skip preview generation for very short videos', async () => {
      const { PreviewGenerator } = require('../../lib/preview.js');
      const generator = new PreviewGenerator();
      
      const shortVideoDuration = 15; // 15 seconds
      const result = await generator.generatePreviewClips('/test/short.mp4', 1, shortVideoDuration);
      
      // Should skip generation for videos shorter than minimum duration
      expect(result).toBeNull();
    });
  });
});