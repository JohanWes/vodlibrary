const request = require('supertest');
const express = require('express');
const fs = require('fs');
const { toVideoCard, toVideoDetail } = require('../../lib/client-video');
const { verifyShareToken, issueShareToken } = require('../../lib/security-tokens');

jest.mock('../../db/database', () => ({
  getVideosPaginated: jest.fn(),
  getVideoById: jest.fn(),
  getVideosWithMetadata: jest.fn()
}));

jest.mock('../../lib/llm', () => {
  class MockOpenRouterClient {
    isAvailable() {
      return MockOpenRouterClient.isAvailableMock();
    }
    searchVideos(query, videos) {
      return MockOpenRouterClient.searchVideosMock(query, videos);
    }
  }
  MockOpenRouterClient.isAvailableMock = jest.fn(() => false);
  MockOpenRouterClient.searchVideosMock = jest.fn(() => []);
  return MockOpenRouterClient;
});

const { getVideosPaginated, getVideoById, getVideosWithMetadata } = require('../../db/database');
const OpenRouterClient = require('../../lib/llm');
const apiRoutes = require('../../routes/api');

// Full row shaped like the videos table plus the fields that must never reach
// the client: absolute path, full metadata, preview internals.
const fullRow = {
  id: 42,
  title: 'Test Stream',
  path: '/mnt/media/vods/Test Stream.mp4',
  duration: 3725,
  width: 1920,
  height: 1080,
  added_date: '2026-08-01 12:00:00',
  thumbnail_path: '/data/thumbnails/42.jpg',
  death_timestamps: '[{"time": 120}, {"time": 900}]',
  preview_clips: '[{"start": 0, "end": 10}]',
  preview_generation_status: 'completed',
  preview_generation_date: '2026-08-01 12:05:00',
  metadata: '{"description": "internal enrichment"}',
  internal_secret: 'do-not-leak'
};

const ENV_KEYS = ['ENABLE_AUTH', 'SHARE_TOKEN_SECRET', 'SHARE_BASE_URL', 'BASE_PATH', 'ADVANCED_SEARCH_ENABLED'];
let savedEnv = {};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.locals.db = {};
  app.use('/api', apiRoutes);
  return app;
}

describe('API security and validation', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    getVideosPaginated.mockResolvedValue({ videos: [], totalCount: 0 });
    getVideoById.mockResolvedValue(null);
    getVideosWithMetadata.mockResolvedValue([]);
    OpenRouterClient.isAvailableMock.mockReturnValue(true);
    OpenRouterClient.searchVideosMock.mockResolvedValue([]);
    app = buildApp();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('GET /api/videos', () => {
    test('returns mapped cards with default page and limit', async () => {
      getVideosPaginated.mockResolvedValue({ videos: [fullRow], totalCount: 1 });

      const response = await request(app).get('/api/videos').expect(200);

      expect(response.body.videos[0]).toEqual(toVideoCard(fullRow));
      expect(response.body.totalCount).toBe(1);
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(20);
      expect(getVideosPaginated).toHaveBeenCalledWith(app.locals.db, 1, 20, null, 'date_added_desc');
    });

    test('passes validated page, limit, search, and sort', async () => {
      await request(app).get('/api/videos?page=2&limit=50&search=epic&sort=title_asc').expect(200);

      expect(getVideosPaginated).toHaveBeenCalledWith(app.locals.db, 2, 50, 'epic', 'title_asc');
    });

    test('treats an empty search as no filter', async () => {
      await request(app).get('/api/videos?search=').expect(200);

      expect(getVideosPaginated).toHaveBeenCalledWith(app.locals.db, 1, 20, null, 'date_added_desc');
    });

    test('rejects invalid page values before DB', async () => {
      for (const page of ['abc', '0', '-1', '1.5', '01', '9007199254740992']) {
        const response = await request(app).get(`/api/videos?page=${page}`).expect(400);
        expect(response.body.error).toBe('Page must be a canonical positive integer');
      }
      await request(app).get('/api/videos?page=1&page=2').expect(400);
      expect(getVideosPaginated).not.toHaveBeenCalled();
    });

    test('rejects invalid or oversized limit values before DB', async () => {
      for (const limit of ['abc', '0', '01', '101', '1.5']) {
        const response = await request(app).get(`/api/videos?limit=${limit}`).expect(400);
        expect(response.body.error).toBe('Limit must be a canonical positive integer of at most 100');
      }
      expect(getVideosPaginated).not.toHaveBeenCalled();
    });

    test('rejects search over 500 characters before DB', async () => {
      const response = await request(app)
        .get(`/api/videos?search=${'a'.repeat(501)}`)
        .expect(400);

      expect(response.body.error).toBe('Search must be a string of at most 500 characters');
      expect(getVideosPaginated).not.toHaveBeenCalled();
    });

    test('rejects non-string search values before DB', async () => {
      await request(app).get('/api/videos?search=a&search=b').expect(400);

      expect(getVideosPaginated).not.toHaveBeenCalled();
    });

    test('never spreads DB rows into list responses', async () => {
      getVideosPaginated.mockResolvedValue({ videos: [fullRow], totalCount: 1 });

      const response = await request(app).get('/api/videos').expect(200);
      const card = response.body.videos[0];

      expect(card).toEqual(toVideoCard(fullRow));
      for (const key of ['path', 'metadata', 'preview_clips', 'preview_generation_status', 'preview_generation_date', 'internal_secret']) {
        expect(card).not.toHaveProperty(key);
      }
    });
  });

  describe('POST /api/videos/advanced-search', () => {
    beforeEach(() => {
      process.env.ADVANCED_SEARCH_ENABLED = 'true';
    });

    test('rejects missing, empty, or oversized query before DB/LLM', async () => {
      const missing = await request(app).post('/api/videos/advanced-search').send({}).expect(400);
      expect(missing.body.error).toBe('Query is required and must be a non-empty string');

      const empty = await request(app).post('/api/videos/advanced-search').send({ query: '' }).expect(400);
      expect(empty.body.error).toBe('Query is required and must be a non-empty string');

      const whitespace = await request(app).post('/api/videos/advanced-search').send({ query: '   ' }).expect(400);
      expect(whitespace.body.error).toBe('Query is required and must be a non-empty string');

      const oversized = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'a'.repeat(501) })
        .expect(400);
      expect(oversized.body.error).toBe('Query must be at most 500 characters');

      expect(getVideosWithMetadata).not.toHaveBeenCalled();
      expect(OpenRouterClient.searchVideosMock).not.toHaveBeenCalled();
    });

    test('rejects invalid page and limit values before DB/LLM', async () => {
      for (const page of [0, -1, 1.5, '1', 9007199254740992]) {
        const response = await request(app)
          .post('/api/videos/advanced-search')
          .send({ query: 'priory', page })
          .expect(400);
        expect(response.body.error).toBe('Page must be a positive safe integer');
      }
      for (const limit of [0, -5, 101, '20']) {
        const response = await request(app)
          .post('/api/videos/advanced-search')
          .send({ query: 'priory', limit })
          .expect(400);
        expect(response.body.error).toBe('Limit must be a positive safe integer of at most 100');
      }
      expect(getVideosWithMetadata).not.toHaveBeenCalled();
      expect(OpenRouterClient.searchVideosMock).not.toHaveBeenCalled();
    });

    test('returns 400 before DB/LLM when advanced search is disabled', async () => {
      delete process.env.ADVANCED_SEARCH_ENABLED;

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory' })
        .expect(400);

      expect(response.body.error).toBe('Advanced search is not enabled');
      expect(getVideosWithMetadata).not.toHaveBeenCalled();
      expect(OpenRouterClient.searchVideosMock).not.toHaveBeenCalled();
    });

    test('returns 503 before DB when the LLM is unavailable', async () => {
      OpenRouterClient.isAvailableMock.mockReturnValue(false);

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory' })
        .expect(503);

      expect(response.body.error).toBe('Advanced search temporarily unavailable - OpenRouter API key not configured');
      expect(getVideosWithMetadata).not.toHaveBeenCalled();
      expect(OpenRouterClient.searchVideosMock).not.toHaveBeenCalled();
    });

    test('returns an empty result set when no metadata exists', async () => {
      getVideosWithMetadata.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory' })
        .expect(200);

      expect(response.body).toEqual({
        videos: [],
        totalCount: 0,
        page: 1,
        limit: 20,
        message: 'No videos with metadata available for advanced search'
      });
    });

    test('projects only safe cards and drops untrusted LLM fields', async () => {
      const metadataRows = [{ id: 42, metadata: '{"start": "2026-08-01T00:00:00Z"}' }];
      getVideosWithMetadata.mockResolvedValue(metadataRows);
      getVideoById.mockResolvedValue(fullRow);
      OpenRouterClient.searchVideosMock.mockResolvedValue([
        { id: 42, searchReason: 'best match', path: '/llm/hallucinated.mp4', evil: 'injected' }
      ]);

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory run' })
        .expect(200);

      const card = response.body.videos[0];
      expect(card).toEqual(toVideoCard(fullRow));
      for (const key of ['searchReason', 'path', 'evil', 'metadata', 'preview_clips', 'preview_generation_status', 'internal_secret']) {
        expect(card).not.toHaveProperty(key);
      }
      expect(response.body.totalCount).toBe(1);
      expect(response.body.searchType).toBe('advanced');
      expect(response.body.query).toBe('priory run');
      expect(OpenRouterClient.searchVideosMock).toHaveBeenCalledWith('priory run', metadataRows);
    });

    test('skips matches that cannot be enriched instead of leaking LLM objects', async () => {
      getVideoById.mockResolvedValue(null);
      getVideosWithMetadata.mockResolvedValue([{ id: 999, metadata: '{}' }]);
      OpenRouterClient.searchVideosMock.mockResolvedValue([
        { id: 999, path: '/llm/fake.mp4', evil: 'injected' }
      ]);

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory' })
        .expect(200);

      expect(response.body.videos).toEqual([]);
      expect(response.body.totalCount).toBe(0);
      expect(getVideoById).toHaveBeenCalledWith(app.locals.db, 999);
    });

    test('paginates enriched results', async () => {
      const rows = {
        1: { id: 1, title: 'One', path: '/mnt/1.mp4' },
        2: { id: 2, title: 'Two', path: '/mnt/2.mp4' },
        3: { id: 3, title: 'Three', path: '/mnt/3.mp4' }
      };
      getVideosWithMetadata.mockResolvedValue(Object.keys(rows).map((id) => ({ id: Number(id), metadata: '{}' })));
      getVideoById.mockImplementation((_db, id) => Promise.resolve(rows[id] || null));
      OpenRouterClient.searchVideosMock.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

      const response = await request(app)
        .post('/api/videos/advanced-search')
        .send({ query: 'priory', page: 2, limit: 2 })
        .expect(200);

      expect(response.body.videos).toEqual([toVideoCard(rows[3])]);
      expect(response.body.totalCount).toBe(3);
      expect(response.body.page).toBe(2);
      expect(response.body.limit).toBe(2);
    });
  });

  describe('GET /api/videos/:id', () => {
    test('rejects non-canonical ids before DB', async () => {
      for (const id of ['abc', '0', '-1', '01', '1.5', '9007199254740992']) {
        const response = await request(app).get(`/api/videos/${id}`).expect(400);
        expect(response.body.error).toBe('Invalid video id');
      }
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 404 for a missing video', async () => {
      const response = await request(app).get('/api/videos/42').expect(404);

      expect(response.body.error).toBe('Video not found');
    });

    test('returns the detail projection without DB row fields', async () => {
      getVideoById.mockResolvedValue(fullRow);

      const response = await request(app).get('/api/videos/42').expect(200);

      expect(response.body).toEqual(toVideoDetail(fullRow));
      for (const key of ['path', 'metadata', 'preview_clips', 'preview_generation_status', 'preview_generation_date', 'internal_secret']) {
        expect(response.body).not.toHaveProperty(key);
      }
      expect(getVideoById).toHaveBeenCalledWith(app.locals.db, 42);
    });
  });

  describe('GET /api/share/:id', () => {
    const shareRow = { id: 5, title: 'Five', path: '/mnt/five.mp4' };

    test('rejects non-canonical ids before DB', async () => {
      for (const id of ['abc', '0', '-1', '01', '1.5', '9007199254740992']) {
        const response = await request(app).get(`/api/share/${id}`).expect(400);
        expect(response.body.error).toBe('Invalid video id');
      }
      expect(getVideoById).not.toHaveBeenCalled();
    });

    test('returns 404 for a missing video', async () => {
      const response = await request(app).get('/api/share/5').expect(404);

      expect(response.body.error).toBe('Video not found');
    });

    test('returns 503 without exposing config when auth enabled and secret missing', async () => {
      process.env.ENABLE_AUTH = 'true';
      delete process.env.SHARE_TOKEN_SECRET;
      process.env.SHARE_BASE_URL = 'https://shares.example.com';
      getVideoById.mockResolvedValue(shareRow);

      const response = await request(app).get('/api/share/5').expect(503);

      expect(response.body).toEqual({ error: 'Sharing is not configured' });
      expect(response.body).not.toHaveProperty('shareLink');
    });

    test('issues a token bound to the requested video, not another', async () => {
      process.env.ENABLE_AUTH = 'true';
      process.env.SHARE_TOKEN_SECRET = 'test-share-secret';
      process.env.SHARE_BASE_URL = 'https://shares.example.com';
      process.env.BASE_PATH = '';
      getVideoById.mockResolvedValue(shareRow);

      const response = await request(app).get('/api/share/5').expect(200);
      expect(response.headers['cache-control']).toBe('no-store');

      expect(response.body.shareLink).toMatch(/^https:\/\/shares\.example\.com\/s\/[^/]+$/);
      const token = response.body.shareLink.split('/s/')[1];
      expect(token).toBeTruthy();
      expect(verifyShareToken(token, 'test-share-secret')).toEqual({
        videoId: 5,
        expiresAt: expect.any(Number)
      });
      expect(verifyShareToken(token, 'wrong-secret')).toBeNull();

      const otherToken = issueShareToken(6, 'test-share-secret');
      expect(otherToken).not.toBe(token);
      expect(verifyShareToken(otherToken, 'test-share-secret').videoId).toBe(6);
    });

    test('share link never contains the legacy password', async () => {
      process.env.ENABLE_AUTH = 'true';
      process.env.SHARE_TOKEN_SECRET = 'test-share-secret';
      process.env.SHARE_BASE_URL = 'https://shares.example.com';
      process.env.SESSION_KEY = 'super-secret-password';
      getVideoById.mockResolvedValue(shareRow);

      const response = await request(app).get('/api/share/5').expect(200);

      expect(response.body.shareLink).not.toContain('super-secret-password');
      expect(response.body.shareLink).not.toContain('test-session-key');
      expect(response.body.shareLink).not.toContain('session');
    });

    test('returns 500 for a missing or invalid public base without exposing config', async () => {
      process.env.ENABLE_AUTH = 'true';
      process.env.SHARE_TOKEN_SECRET = 'test-share-secret';
      getVideoById.mockResolvedValue(shareRow);

      delete process.env.SHARE_BASE_URL;
      const missing = await request(app).get('/api/share/5').expect(500);
      expect(missing.body.error).toBe('Failed to generate share link');

      process.env.SHARE_BASE_URL = 'ftp://shares.example.com';
      const badScheme = await request(app).get('/api/share/5').expect(500);
      expect(badScheme.body.error).toBe('Failed to generate share link');

      process.env.SHARE_BASE_URL = 'https://shares.example.com/vods';
      const nonRoot = await request(app).get('/api/share/5').expect(500);
      expect(nonRoot.body.error).toBe('Failed to generate share link');

      expect(JSON.stringify(missing.body)).not.toContain('shares.example.com');
      expect(JSON.stringify(badScheme.body)).not.toContain('shares.example.com');
      expect(JSON.stringify(nonRoot.body)).not.toContain('shares.example.com');
    });

    test('returns a clean watch link without a token when auth is disabled', async () => {
      process.env.ENABLE_AUTH = 'false';
      process.env.SHARE_BASE_URL = 'https://shares.example.com';
      process.env.BASE_PATH = '/vods';
      getVideoById.mockResolvedValue(shareRow);

      const response = await request(app).get('/api/share/5').expect(200);

      expect(response.body.shareLink).toBe('https://shares.example.com/vods/watch/5');
      expect(response.body.shareLink).not.toContain('/s/');
      expect(response.body.shareLink).not.toContain('test-share-secret');
    });

    test('fails closed when auth is disabled but the public base is missing', async () => {
      process.env.ENABLE_AUTH = 'false';
      delete process.env.SHARE_BASE_URL;
      getVideoById.mockResolvedValue(shareRow);

      const response = await request(app).get('/api/share/5').expect(500);

      expect(response.body.error).toBe('Failed to generate share link');
    });

    test('appends BASE_PATH exactly once', async () => {
      process.env.ENABLE_AUTH = 'false';
      process.env.BASE_PATH = '/vods';
      getVideoById.mockResolvedValue(shareRow);

      // Base URL that already carries the base path is rejected (non-root).
      process.env.SHARE_BASE_URL = 'https://shares.example.com/vods';
      await request(app).get('/api/share/5').expect(500);

      process.env.SHARE_BASE_URL = 'https://shares.example.com';
      const response = await request(app).get('/api/share/5').expect(200);
      expect(response.body.shareLink).toBe('https://shares.example.com/vods/watch/5');
    });
  });

  describe('route code hygiene', () => {
    test('api route code never references the legacy SESSION_KEY', () => {
      const source = fs.readFileSync(require.resolve('../../routes/api'), 'utf8');
      expect(source).not.toMatch(/SESSION_KEY/);
    });
  });
});
