const request = require('supertest');
const express = require('express');

jest.mock('../../db/database', () => ({
  getVideoById: jest.fn()
}));

describe('Preview Endpoints Integration (Public Before Auth)', () => {
  let app;

  const mockVideo = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test.mp4',
    duration: 120,
    preview_clips: JSON.stringify({
      clips: [
        { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 24119 }
      ]
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.locals.db = {};

    const publicApiRoutes = require('../../routes/public-api');
    app.use('/api', publicApiRoutes);

    const mockAuth = (_req, res) => {
      res.status(302).set('Location', '/login.html').end();
    };

    app.use('/api', mockAuth);
    app.get('/api/videos/1/stream', mockAuth);
  });

  test('serves preview-info without authentication', async () => {
    const { getVideoById } = require('../../db/database');
    getVideoById.mockResolvedValue(mockVideo);

    const response = await request(app)
      .get('/api/videos/1/preview-info')
      .expect(200);

    expect(response.body.hasPreview).toBe(true);
  });

  test('still blocks protected routes after preview router', async () => {
    const response = await request(app)
      .get('/api/videos/1/stream')
      .expect(302);

    expect(response.headers.location).toBe('/login.html');
  });
});
