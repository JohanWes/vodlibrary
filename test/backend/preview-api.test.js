const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCdnManager = {
  shouldUseCdn: jest.fn(),
  getCdnUrl: jest.fn()
};

jest.mock('../../db/database', () => ({
  getVideoById: jest.fn(),
  getVideoStreamInfo: jest.fn()
}));

jest.mock('../../lib/cdn', () => mockCdnManager);

const { getVideoById } = require('../../db/database');

const CLIP_SIZE = 524288;

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('Preview API routes (router only; auth is covered by auth-matrix.test.js)', () => {
  let app;
  let tmpDir;
  let previewsDir;
  let originalPreviewsDir;

  const testVideoData = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test-video-1.mp4',
    duration: 120,
    preview_clips: JSON.stringify({
      clips: [
        { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: CLIP_SIZE },
        { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 618432 }
      ]
    }),
    preview_generation_status: 'completed'
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-previews-'));
    previewsDir = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewsDir);
    const clip = Buffer.alloc(CLIP_SIZE);
    for (let i = 0; i < CLIP_SIZE; i += 1) {
      clip[i] = i % 251;
    }
    fs.writeFileSync(path.join(previewsDir, 'test_10s.mp4'), clip);
    fs.writeFileSync(path.join(tmpDir, 'secret.mp4'), 'outside the previews dir');
    originalPreviewsDir = process.env.PREVIEWS_CACHE_DIR;
    process.env.PREVIEWS_CACHE_DIR = previewsDir;
  });

  afterAll(() => {
    if (originalPreviewsDir === undefined) {
      delete process.env.PREVIEWS_CACHE_DIR;
    } else {
      process.env.PREVIEWS_CACHE_DIR = originalPreviewsDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.locals.db = {};
    app.use('/api', require('../../routes/public-api'));
    mockCdnManager.shouldUseCdn.mockReturnValue(false);
    getVideoById.mockResolvedValue(testVideoData);
  });

  describe('GET /api/videos/:id/preview-info', () => {
    test('returns preview information', async () => {
      const response = await request(app).get('/api/videos/1/preview-info').expect(200);

      expect(response.body).toEqual({
        hasPreview: true,
        status: 'completed',
        clips: [
          { timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: CLIP_SIZE },
          { timestamp: 30, path: '/previews/test_30s.mp4', duration: 5, size: 618432 }
        ]
      });
    });

    test('returns 404 when video does not exist', async () => {
      getVideoById.mockResolvedValue(undefined);
      const response = await request(app).get('/api/videos/999/preview-info').expect(404);
      expect(response.body.error).toBe('Video not found');
    });

    test('returns 400 for a malformed video id', async () => {
      const response = await request(app).get('/api/videos/not-a-number/preview-info').expect(400);
      expect(response.body.error).toBe('Invalid video id');
      expect(getVideoById).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/videos/:id/preview/:timestamp', () => {
    test('serves the preview clip from the previews dir, never the source video', async () => {
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['cache-control']).toBe('private, max-age=86400');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-length']).toBe(String(CLIP_SIZE));
      expect(response.body.equals(fs.readFileSync(path.join(previewsDir, 'test_10s.mp4')))).toBe(true);
    });

    test.each([
      ['bytes=100-199', 100, 199],
      ['bytes=524280-', 524280, 524287],
      ['bytes=-8', 524280, 524287],
      ['bytes=524280-999999', 524280, 524287]
    ])('serves a single range for %s', async (rangeHeader, start, end) => {
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', rangeHeader)
        .buffer(true)
        .parse(binaryParser)
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${CLIP_SIZE}`);
      expect(response.headers['content-length']).toBe(String((end - start) + 1));
      expect(response.body.equals(fs.readFileSync(path.join(previewsDir, 'test_10s.mp4')).subarray(start, end + 1))).toBe(true);
    });

    test.each(['bytes=-0', 'bytes=524288-', 'bytes=9-3', 'bytes='])('rejects unsatisfiable range %s with 416', async (rangeHeader) => {
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', rangeHeader)
        .expect(416);

      expect(response.headers['content-range']).toBe(`bytes */${CLIP_SIZE}`);
      expect(response.headers['cache-control']).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
    });

    test.each(['items=0-1', 'bytes=0-1,3-4'])('ignores unsupported range %s and serves the whole clip', async (rangeHeader) => {
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Range', rangeHeader)
        .expect(200);

      expect(response.headers['content-length']).toBe(String(CLIP_SIZE));
      expect(response.headers['content-range']).toBeUndefined();
    });

    test('returns 404 when no preview clips exist instead of serving source bytes', async () => {
      getVideoById.mockResolvedValue({ ...testVideoData, preview_clips: null, preview_generation_status: 'pending' });
      const response = await request(app).get('/api/videos/1/preview/10').expect(404);
      expect(response.body.error).toBe('Preview clip not found');
    });

    test('returns 404 for malformed preview data', async () => {
      getVideoById.mockResolvedValue({ ...testVideoData, preview_clips: '{not valid json' });
      const response = await request(app).get('/api/videos/1/preview/10').expect(404);
      expect(response.body.error).toBe('Preview clip not found');
    });

    test('never redirects previews to a CDN, even with auth disabled', async () => {
      const originalEnableAuth = process.env.ENABLE_AUTH;
      process.env.ENABLE_AUTH = 'false';
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      try {
        const response = await request(app).get('/api/videos/1/preview/10').expect(200);
        expect(response.headers['cache-control']).toBe('public, max-age=86400');
        expect(mockCdnManager.getCdnUrl).not.toHaveBeenCalled();
      } finally {
        process.env.ENABLE_AUTH = originalEnableAuth;
      }
    });

    test('returns 404 without cache headers when the preview file is missing', async () => {
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({ clips: [{ timestamp: 10, path: '/previews/missing.mp4' }] })
      });

      const response = await request(app).get('/api/videos/1/preview/10').expect(404);
      expect(response.body.error).toBe('Preview file not found');
      expect(response.headers['cache-control']).toBeUndefined();
    });

    test('returns 404 for dotfile clip names', async () => {
      fs.writeFileSync(path.join(previewsDir, '.hidden.mp4'), 'x');
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({ clips: [{ timestamp: 10, path: '/previews/.hidden.mp4' }] })
      });

      const response = await request(app).get('/api/videos/1/preview/10').expect(404);
      expect(response.body.error).toBe('Preview file not found');
    });

    test('returns 400 for a malformed video id', async () => {
      const nonNumeric = await request(app).get('/api/videos/not-a-number/preview/10').expect(400);
      const nonCanonical = await request(app).get('/api/videos/01/preview/10').expect(400);

      expect(nonNumeric.body.error).toBe('Invalid video id');
      expect(nonCanonical.body.error).toBe('Invalid video id');
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 400 for a malformed timestamp', async () => {
      const negative = await request(app).get('/api/videos/1/preview/-5').expect(400);
      const nonInteger = await request(app).get('/api/videos/1/preview/12.5').expect(400);

      expect(negative.body.error).toBe('Invalid timestamp');
      expect(nonInteger.body.error).toBe('Invalid timestamp');
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 404 for a traversal clip path instead of escaping previews dir', async () => {
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({
          clips: [{ timestamp: 10, path: '/previews/../secret.mp4', duration: 5, size: 1024 }]
        })
      });

      const response = await request(app).get('/api/videos/1/preview/10').expect(404);
      expect(response.body.error).toBe('Preview file not found');
    });

    test('returns 404 for empty or dot clip basenames', async () => {
      getVideoById.mockResolvedValue({
        ...testVideoData,
        preview_clips: JSON.stringify({
          clips: [
            { timestamp: 10, path: '/previews/', duration: 5, size: 1024 },
            { timestamp: 20, path: '/previews/.', duration: 5, size: 1024 }
          ]
        })
      });

      const emptyBasename = await request(app).get('/api/videos/1/preview/10').expect(404);
      const dotBasename = await request(app).get('/api/videos/1/preview/20').expect(404);

      expect(emptyBasename.body.error).toBe('Preview file not found');
      expect(dotBasename.body.error).toBe('Preview file not found');
    });
  });
});
