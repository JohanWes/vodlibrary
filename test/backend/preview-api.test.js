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

    test('returns 400 for a malformed video id', async () => {
      const { getVideoById } = require('../../db/database');

      const response = await request(app)
        .get('/api/videos/not-a-number/preview-info')
        .expect(400);

      expect(response.body.error).toBe('Invalid video id');
      expect(getVideoById).not.toHaveBeenCalled();
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
      expect(response.headers['cache-control']).toBe('private, max-age=86400');

      const servedPath = fs.createReadStream.mock.calls[0][0];
      expect(servedPath).toMatch(/[\\/]previews[\\/]test_10s\.mp4$/);
      expect(servedPath).not.toBe(testVideoData.path);
    });

    test.each([
      ['bytes=100-199', 100, 199, 'bytes 100-199/524288'],
      ['bytes=524280-', 524280, 524287, 'bytes 524280-524287/524288'],
      ['bytes=-8', 524280, 524287, 'bytes 524280-524287/524288'],
      ['bytes=524280-999999', 524280, 524287, 'bytes 524280-524287/524288']
    ])('serves a single range for %s', async (rangeHeader, start, end, contentRange) => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', rangeHeader)
        .expect(206);

      expect(response.headers['content-range']).toBe(contentRange);
      expect(response.headers['content-length']).toBe(String((end - start) + 1));
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(fs.createReadStream.mock.calls[0][1]).toEqual({ start, end });
    });

    test.each([
      'items=0-1',
      'bytes=',
      'bytes=0-1,3-4',
      'bytes=-0',
      'bytes=524288-'
    ])('rejects invalid or unsatisfiable range %s', async (rangeHeader) => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', rangeHeader)
        .expect(416);

      expect(response.headers['content-range']).toBe('bytes */524288');
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });

    test('returns 404 when no preview clips exist instead of serving source bytes', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: null,
        preview_generation_status: 'pending'
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(404);

      expect(response.body.error).toBe('Preview clip not found');
      expect(fs.promises.access).not.toHaveBeenCalled();
      expect(fs.promises.stat).not.toHaveBeenCalled();
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });

    test('returns 404 for malformed preview data', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: '{not valid json',
        preview_generation_status: 'pending'
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(404);

      expect(response.body.error).toBe('Preview clip not found');
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });

    test('redirects to CDN when configured', async () => {
      const originalEnableAuth = process.env.ENABLE_AUTH;
      process.env.ENABLE_AUTH = 'false';
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      try {
        const response = await request(app)
          .get('/api/videos/1/preview/10')
          .expect(302);

        expect(response.headers.location).toBe('https://cdn.example.com/previews/test_10s.mp4');
      } finally {
        process.env.ENABLE_AUTH = originalEnableAuth;
      }
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

    test('returns 400 for a malformed video id', async () => {
      const { getVideoById } = require('../../db/database');

      const nonNumeric = await request(app)
        .get('/api/videos/not-a-number/preview/10')
        .expect(400);
      const nonCanonical = await request(app)
        .get('/api/videos/01/preview/10')
        .expect(400);

      expect(nonNumeric.body.error).toBe('Invalid video id');
      expect(nonCanonical.body.error).toBe('Invalid video id');
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 400 for a malformed timestamp', async () => {
      const { getVideoById } = require('../../db/database');

      const negative = await request(app)
        .get('/api/videos/1/preview/-5')
        .expect(400);
      const nonInteger = await request(app)
        .get('/api/videos/1/preview/12.5')
        .expect(400);

      expect(negative.body.error).toBe('Invalid timestamp');
      expect(nonInteger.body.error).toBe('Invalid timestamp');
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 404 for a traversal clip path instead of escaping previews dir', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({
          clips: [{ timestamp: 10, path: '/previews/../secret.mp4', duration: 5, size: 1024 }]
        })
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(404);

      expect(response.body.error).toBe('Preview file not found');
      expect(fs.promises.access).not.toHaveBeenCalled();
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });

    test('returns 404 for empty or dot clip basenames', async () => {
      const { getVideoById } = require('../../db/database');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({
          clips: [
            { timestamp: 10, path: '/previews/', duration: 5, size: 1024 },
            { timestamp: 20, path: '/previews/.', duration: 5, size: 1024 }
          ]
        })
      });

      const emptyBasename = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(404);
      const dotBasename = await request(app)
        .get('/api/videos/1/preview/20')
        .expect(404);

      expect(emptyBasename.body.error).toBe('Preview file not found');
      expect(dotBasename.body.error).toBe('Preview file not found');
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });
  });
});
