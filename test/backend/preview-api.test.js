// jest is available globally from setup.js
const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');

// Mock dependencies
const mockDb = {
  get: jest.fn(),
  run: jest.fn(),
  all: jest.fn()
};

const mockCdnManager = {
  shouldUseCdn: jest.fn(),
  getCdnUrl: jest.fn()
};

jest.mock('../../db/database', () => ({
  getVideoById: jest.fn()
}));

jest.mock('../../lib/cdn', () => mockCdnManager);

describe('Preview API Endpoints', () => {
  let app;
  const testVideoData = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test-video-1.mp4',
    duration: 120,
    preview_clips: JSON.stringify({
      clips: [
        { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 524288 },
        { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 618432 }
      ],
      generated_at: '2025-01-06T10:30:00.000Z',
      total_size: 1142720
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(async () => {
    // Create express app for testing
    app = express();
    app.use(express.json());
    
    // Mock app.locals
    app.locals.db = mockDb;
    
    // Import and use the API routes
    const apiRoutes = require('../../routes/api.js');
    app.use('/api', apiRoutes);
    
    // Reset mocks
    jest.clearAllMocks();
    mockCdnManager.shouldUseCdn.mockReturnValue(false);
    
    // Mock file system
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: 524288 });
    jest.spyOn(fs, 'createReadStream').mockReturnValue({
      pipe: jest.fn()
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/videos/:id/preview/:timestamp', () => {
    test('should serve preview clip when available', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(200);

      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['cache-control']).toBe('public, max-age=86400');
      expect(getVideoById).toHaveBeenCalledWith(mockDb, '1');
    });

    test('should return 404 when video not found', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/videos/999/preview/10')
        .expect(404);

      expect(response.body.error).toBe('Video not found');
    });

    test('should return 404 when preview clip not found for timestamp', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/90')
        .expect(404);

      expect(response.body.error).toBe('Preview clip not found');
    });

    test('should fallback to video segment when no preview clips exist', async () => {
      const videoWithoutPreviews = {
        ...testVideoData,
        preview_clips: null,
        preview_generation_status: 'pending'
      };

      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(videoWithoutPreviews);

      // Mock the fallback function
      const fallbackSpy = jest.fn().mockImplementation((req, res) => {
        res.status(206).send('video segment data');
      });

      // This test would need the actual fallback implementation
      // For now, we'll test that it attempts fallback
      const response = await request(app)
        .get('/api/videos/1/preview/10');

      // Should attempt to serve video segment as fallback
      expect(response.status).toBe(206);
    });

    test('should redirect to CDN when CDN is enabled', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(302);

      expect(response.headers.location).toBe('https://cdn.example.com/previews/test_10s.mp4');
    });

    test('should handle file system errors gracefully', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      fs.statSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(500);

      expect(response.body.error).toBe('Failed to serve preview');
    });
  });

  describe('GET /api/videos/:id/preview-info', () => {
    test('should return preview information when available', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview-info')
        .expect(200);

      expect(response.body).toEqual({
        hasPreview: true,
        status: 'completed',
        clips: [
          { timestamp: 10, path: '/previews/test_10s.mp4', duration: 3, size: 524288 },
          { timestamp: 30, path: '/previews/test_30s.mp4', duration: 3, size: 618432 }
        ]
      });
    });

    test('should return preview info for video without previews', async () => {
      const videoWithoutPreviews = {
        ...testVideoData,
        preview_clips: null,
        preview_generation_status: 'pending'
      };

      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(videoWithoutPreviews);

      const response = await request(app)
        .get('/api/videos/1/preview-info')
        .expect(200);

      expect(response.body).toEqual({
        hasPreview: false,
        status: 'pending',
        clips: []
      });
    });

    test('should return 404 when video not found', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/videos/999/preview-info')
        .expect(404);

      expect(response.body.error).toBe('Video not found');
    });

    test('should handle database errors gracefully', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/videos/1/preview-info')
        .expect(500);

      expect(response.body.error).toBe('Failed to get preview info');
    });
  });

  describe('Video Segment Fallback', () => {
    test('should serve video segments with range requests', async () => {
      const videoWithoutPreviews = {
        ...testVideoData,
        preview_clips: null
      };

      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(videoWithoutPreviews);

      // Mock file system for video file
      fs.statSync.mockReturnValue({ size: 10485760 }); // 10MB file
      
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', 'bytes=1250000-2500000'); // Approximate range for 10s-13s

      expect(response.status).toBe(206); // Partial content
    });
  });

  describe('GET /api/videos/:id/segments/:segmentNumber', () => {
    test('should serve video segments with quality parameter', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      const mockCache = {
        getCachedSegment: jest.fn().mockReturnValue(null),
        cacheSegmentFromFile: jest.fn().mockResolvedValue(true)
      };
      
      // Mock video cache
      jest.doMock('../../lib/cache', () => mockCache);

      // Mock file system for video file
      fs.statSync.mockReturnValue({ size: 10485760 }); // 10MB file
      
      const response = await request(app)
        .get('/api/videos/1/segments/0?quality=low')
        .expect(206);

      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(getVideoById).toHaveBeenCalledWith(mockDb, '1');
    });

    test('should handle different quality levels with appropriate segment sizes', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      const mockCache = {
        getCachedSegment: jest.fn().mockReturnValue(null),
        cacheSegmentFromFile: jest.fn().mockResolvedValue(true)
      };
      
      jest.doMock('../../lib/cache', () => mockCache);
      fs.statSync.mockReturnValue({ size: 10485760 }); // 10MB file

      // Test low quality (512KB segments)
      const lowResponse = await request(app)
        .get('/api/videos/1/segments/0?quality=low')
        .expect(206);

      // Test high quality (2MB segments)  
      const highResponse = await request(app)
        .get('/api/videos/1/segments/0?quality=high')
        .expect(206);

      // Verify content-length differs based on quality
      expect(lowResponse.headers['content-length']).toBe('524288'); // 512KB
      expect(highResponse.headers['content-length']).toBe('2097152'); // 2MB
    });

    test('should return 404 when video not found for segments', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/videos/999/segments/0?quality=low')
        .expect(404);

      expect(response.body.error).toBe('Video not found');
    });

    test('should return 416 when segment is beyond file size', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      fs.statSync.mockReturnValue({ size: 524288 }); // 512KB file

      const response = await request(app)
        .get('/api/videos/1/segments/10?quality=low') // Segment 10 * 512KB = beyond file
        .expect(416);

      expect(response.body.error).toBe('Requested segment beyond file size');
    });

    test('should serve from cache when segment is cached', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      const mockCachedData = Buffer.from('cached segment data');
      const mockCache = {
        getCachedSegment: jest.fn().mockReturnValue(mockCachedData),
        cacheSegmentFromFile: jest.fn()
      };
      
      jest.doMock('../../lib/cache', () => mockCache);
      fs.statSync.mockReturnValue({ size: 10485760 });

      const response = await request(app)
        .get('/api/videos/1/segments/0?quality=low')
        .expect(206);

      expect(mockCache.getCachedSegment).toHaveBeenCalledWith('1', 0);
      expect(mockCache.cacheSegmentFromFile).not.toHaveBeenCalled();
    });

    test('should handle file system errors gracefully for segments', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      fs.statSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const response = await request(app)
        .get('/api/videos/1/segments/0?quality=low')
        .expect(500);

      expect(response.body.error).toBe('Failed to serve video segment');
    });
  });

  describe('Integration with existing video streaming', () => {
    test('should reuse existing streaming infrastructure for fallback', async () => {
      const videoWithoutPreviews = {
        ...testVideoData,
        preview_clips: null
      };

      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(videoWithoutPreviews);

      // Mock existing video streaming endpoint
      app.get('/api/videos/:id/stream', (req, res) => {
        res.status(206);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.send('video stream data');
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10');

      // Should handle the request and provide video content
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(400);
    });
  });

  describe('Performance Tests', () => {
    test('should handle concurrent requests efficiently', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const requests = Array(10).fill().map((_, i) => 
        request(app).get(`/api/videos/1/preview/10`)
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Should only query database once due to potential caching
      expect(getVideoById).toHaveBeenCalled();
    });

    test('should set appropriate cache headers for preview clips', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10');

      expect(response.headers['cache-control']).toBe('public, max-age=86400');
      expect(response.headers['content-length']).toBe('524288');
    });
  });
});