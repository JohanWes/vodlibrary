const request = require('supertest');
const express = require('express');
const fs = require('fs');
const { Readable } = require('stream');

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

describe('Public Preview API Endpoints', () => {
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
      ]
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.locals.db = mockDb;

    const publicApiRoutes = require('../../routes/public-api');
    app.use('/api', publicApiRoutes);

    mockCdnManager.shouldUseCdn.mockReturnValue(false);

    jest.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 524288 });
    jest.spyOn(fs, 'createReadStream').mockImplementation((_path, opts) => {
      const start = opts && Number.isInteger(opts.start) ? opts.start : 0;
      const end = opts && Number.isInteger(opts.end) ? opts.end : 524287;
      const size = Math.max((end - start) + 1, 0);
      return Readable.from(Buffer.alloc(size));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/videos/:id/preview-info', () => {
    test('returns preview information', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview-info')
        .expect(200);

      expect(response.body).toEqual({
        hasPreview: true,
        status: 'completed',
        clips: [
          { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 524288 },
          { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 618432 }
        ]
      });
    });

    test('returns 404 when video does not exist', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/videos/999/preview-info')
        .expect(404);

      expect(response.body.error).toBe('Video not found');
    });
  });

  describe('GET /api/videos/:id/preview/:timestamp', () => {
    test('serves preview clip when available', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(200);

      expect(response.headers['content-type']).toContain('video/mp4');
      expect(response.headers['cache-control']).toBe('public, max-age=86400');
    });

    test('falls back to video segment when no preview clips exist', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: null,
        preview_generation_status: 'pending'
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(206);

      expect(response.headers['accept-ranges']).toBe('bytes');
    });

    test('redirects to CDN when configured', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(302);

      expect(response.headers.location).toBe('https://cdn.example.com/previews/test_10s.mp4');
    });

    test('returns 404 when preview file is missing', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      fs.promises.access.mockRejectedValue(new Error('not found'));

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(404);

      expect(response.body.error).toBe('Preview file not found');
    });
  });
});
