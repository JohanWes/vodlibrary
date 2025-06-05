const request = require('supertest');
const express = require('express');
const { getVideoById } = require('../../db/database');

// Mock the database
jest.mock('../../db/database');

describe('Preview Endpoints Integration (Before Auth)', () => {
  let app;
  
  const mockVideo = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test.mp4',
    duration: 120,
    preview_clips: JSON.stringify({
      clips: [
        { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 24119 },
        { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 24260 }
      ]
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(() => {
    // Create minimal express app with the same structure as server.js
    app = express();
    app.use(express.json());
    
    // Mock app.locals.db
    app.locals.db = {};
    
    // Add the preview endpoints before authentication (like in server.js)
    app.get('/api/videos/:id/preview-info', async (req, res) => {
      try {
        const db = req.app.locals.db;
        const video = await getVideoById(db, req.params.id);
        
        if (!video) {
          return res.status(404).json({ error: 'Video not found' });
        }
        
        const previewInfo = {
          hasPreview: !!video.preview_clips,
          status: video.preview_generation_status || 'pending',
          clips: video.preview_clips ? JSON.parse(video.preview_clips).clips : []
        };
        
        res.json(previewInfo);
      } catch (error) {
        console.error(`Error getting preview info for video ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to get preview info' });
      }
    });

    // Mock authentication middleware that would block these requests
    const mockAuth = (req, res, next) => {
      res.redirect('/login.html');
    };
    
    // Apply mock auth to other routes (but not preview endpoints)
    app.use('/api/videos/:id/stream', mockAuth);
    app.use('/api/videos', mockAuth);
    
    // Reset mocks
    jest.clearAllMocks();
  });

  test('should serve preview-info without authentication', async () => {
    getVideoById.mockResolvedValue(mockVideo);

    const response = await request(app)
      .get('/api/videos/1/preview-info')
      .expect(200);

    expect(response.body).toEqual({
      hasPreview: true,
      status: 'completed',
      clips: [
        { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 24119 },
        { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 24260 }
      ]
    });
  });

  test('should return 404 for non-existent video', async () => {
    getVideoById.mockResolvedValue(null);

    const response = await request(app)
      .get('/api/videos/999/preview-info')
      .expect(404);

    expect(response.body.error).toBe('Video not found');
  });

  test('should handle videos without preview clips', async () => {
    const videoWithoutPreviews = {
      ...mockVideo,
      preview_clips: null,
      preview_generation_status: 'pending'
    };
    
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

  test('should handle database errors gracefully', async () => {
    getVideoById.mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app)
      .get('/api/videos/1/preview-info')
      .expect(500);

    expect(response.body.error).toBe('Failed to get preview info');
  });

  test('should be accessible before authentication middleware', async () => {
    getVideoById.mockResolvedValue(mockVideo);

    // This should succeed even though other video endpoints would be blocked
    const previewResponse = await request(app)
      .get('/api/videos/1/preview-info')
      .expect(200);

    expect(previewResponse.body.hasPreview).toBe(true);

    // Regular video endpoint should be blocked (demonstrating auth works)
    const blockedResponse = await request(app)
      .get('/api/videos/1/stream')
      .expect(302);

    expect(blockedResponse.headers.location).toBe('/login.html');
  });
});