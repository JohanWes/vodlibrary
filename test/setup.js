// Test setup file
const { TextDecoder, TextEncoder } = require('util');
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.VIDEO_LIBRARY = './test-videos';
process.env.SESSION_KEY = 'test-session-key';
process.env.SESSION_SECRET = 'test-session-signing-secret';
process.env.SHARE_TOKEN_SECRET = 'test-share-signing-secret';
process.env.SHARE_BASE_URL = 'https://example.test';
process.env.ENABLE_AUTH = 'true';
process.env.CDN_ENABLED = 'false';

// Suppress console logs during tests unless DEBUG is set
if (!process.env.DEBUG) {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
}

// Mock database for tests
jest.mock('../db/database', () => ({
  initializeDatabase: jest.fn().mockResolvedValue({
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn()
  }),
  closeDatabase: jest.fn().mockResolvedValue(undefined),
  getVideoById: jest.fn(),
  getVideoStreamInfo: jest.fn(),
  getVideoCardByPath: jest.fn(),
  addVideo: jest.fn(),
  deleteVideo: jest.fn(),
  getVideosPaginated: jest.fn().mockResolvedValue({ videos: [], totalCount: 0 }),
  getVideosWithMetadata: jest.fn().mockResolvedValue([]),
  getVideosByIds: jest.fn().mockResolvedValue([]),
  getVideosForScan: jest.fn().mockResolvedValue([]),
  getVideoScanStateByPath: jest.fn().mockResolvedValue(undefined),
  updateVideoFields: jest.fn().mockResolvedValue(1)
}));