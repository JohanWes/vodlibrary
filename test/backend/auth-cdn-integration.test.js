const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { Readable } = require('stream');
const { issueSessionToken, verifySessionToken } = require('../../lib/security-tokens');

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

describe('Public Preview Auth + CDN Integration', () => {
  let app;

  const testVideoData = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test-video-1.mp4',
    duration: 120,
    preview_clips: JSON.stringify({
      clips: [{ timestamp: 10, path: '/previews/test_10s.mp4', duration: 5, size: 524288 }]
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.locals.db = mockDb;

    const publicApiRoutes = require('../../routes/public-api');
    app.use('/api', publicApiRoutes);

    app.use('/api', (req, res, next) => {
      if (req.path.startsWith('/videos/') && req.path.includes('/preview')) {
        return next();
      }

      if (verifySessionToken(req.cookies && req.cookies.auth_token, process.env.SESSION_SECRET)) {
        return next();
      }

      return res.status(401).json({ error: 'Authentication required' });
    });

    app.get('/api/protected', (_req, res) => {
      res.json({ ok: true });
    });

    mockCdnManager.shouldUseCdn.mockReturnValue(false);

    jest.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 524288 });
    jest.spyOn(fs, 'createReadStream').mockImplementation((_path, opts) => {
      const start = opts && Number.isInteger(opts.start) ? opts.start : 0;
      const end = opts && Number.isInteger(opts.end) ? opts.end : 524287;
      return Readable.from(Buffer.alloc((end - start) + 1));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('keeps preview endpoints public without auth cookie', async () => {
    const { getVideoById } = require('../../db/database');
    getVideoById.mockResolvedValue(testVideoData);

    const response = await request(app)
      .get('/api/videos/1/preview/10')
      .expect(200);

    expect(response.headers['content-type']).toContain('video/mp4');
  });

  test('still protects non-preview API endpoints', async () => {
    const response = await request(app)
      .get('/api/protected')
      .expect(401);

    expect(response.body.error).toBe('Authentication required');
  });

  test('allows protected endpoint with valid auth cookie', async () => {
    const response = await request(app)
      .get('/api/protected')
      .set('Cookie', `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}`)
      .expect(200);

    expect(response.body.ok).toBe(true);
  });

  test('redirects preview requests to CDN when enabled', async () => {
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
});
