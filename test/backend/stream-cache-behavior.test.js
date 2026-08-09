const request = require('supertest');
const fs = require('fs');
const { Readable } = require('stream');
const { issueSessionToken } = require('../../lib/security-tokens');

const FIXED_STREAM_SEGMENT_SIZE = 2 * 1024 * 1024;

const mockVideoCache = {
  updateConfig: jest.fn(),
  recordAccess: jest.fn(),
  getCachedSegment: jest.fn(),
  cacheSegmentFromFile: jest.fn().mockResolvedValue(true)
};

const mockCdnManager = {
  initCdn: jest.fn(),
  shouldUseCdn: jest.fn().mockReturnValue(false),
  getCdnUrl: jest.fn()
};

jest.mock('../../lib/cache', () => mockVideoCache);
jest.mock('../../lib/cdn', () => mockCdnManager);

const { getVideoById } = require('../../db/database');
const { app } = require('../../server');

describe('Stream route cache behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app.locals.db = {};
    getVideoById.mockResolvedValue({
      id: 1,
      path: '/test-videos/test-video-1.mp4'
    });

    jest.spyOn(fs.promises, 'stat').mockResolvedValue({
      size: FIXED_STREAM_SEGMENT_SIZE * 3,
      mtime: new Date('2026-01-01T00:00:00Z')
    });

    jest.spyOn(fs, 'createReadStream').mockImplementation((_filePath, options = {}) => {
      const start = Number.isInteger(options.start) ? options.start : 0;
      const end = Number.isInteger(options.end) ? options.end : start;
      return Readable.from(Buffer.alloc((end - start) + 1));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('serves non-canonical single-segment ranges from cached canonical buffer', async () => {
    mockVideoCache.getCachedSegment.mockReturnValue(Buffer.alloc(FIXED_STREAM_SEGMENT_SIZE, 3));

    const response = await request(app)
      .get('/api/videos/1/stream')
      .set('Cookie', `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}`)
      .set('Range', 'bytes=100-199')
      .expect(206);

    expect(response.headers['content-length']).toBe('100');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(mockCdnManager.shouldUseCdn).not.toHaveBeenCalled();
    expect(mockVideoCache.recordAccess).toHaveBeenCalledWith(1, { namespace: 'stream' });
    expect(mockVideoCache.getCachedSegment).toHaveBeenCalledWith(1, 0, {
      namespace: 'stream',
      quality: 'fixed_2mb',
      startByte: 0,
      endByte: FIXED_STREAM_SEGMENT_SIZE - 1
    });
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect(mockVideoCache.cacheSegmentFromFile).not.toHaveBeenCalled();
  });

  test('falls back to file stream for cross-segment ranges', async () => {
    mockVideoCache.getCachedSegment.mockReturnValue(Buffer.alloc(FIXED_STREAM_SEGMENT_SIZE, 3));

    const start = FIXED_STREAM_SEGMENT_SIZE - 100;
    const end = FIXED_STREAM_SEGMENT_SIZE + 100;

    await request(app)
      .get('/api/videos/1/stream')
      .set('Cookie', `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}`)
      .set('Range', `bytes=${start}-${end}`)
      .expect(206);

    expect(fs.createReadStream).toHaveBeenCalledWith('/test-videos/test-video-1.mp4', { start, end });
    expect(mockVideoCache.cacheSegmentFromFile).not.toHaveBeenCalled();
  });
});
