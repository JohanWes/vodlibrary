// Test setup file
const path = require('path');
const fs = require('fs');
const { TextDecoder, TextEncoder } = require('util');
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

// Load .env.test before setting hardcoded test variables
const envFile = path.join(__dirname, '..', '.env.test');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.VIDEO_LIBRARY = './test-videos';
process.env.SESSION_KEY = 'test-session-key';
process.env.SESSION_SECRET = 'test-session-signing-secret';
process.env.SHARE_TOKEN_SECRET = 'test-share-signing-secret';
process.env.SHARE_BASE_URL = 'https://example.test';
process.env.ENABLE_AUTH = 'true';
process.env.CDN_ENABLED = 'false';
// Preview settings are now hardcoded in lib/preview.js

// Global test helpers
global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Suppress console logs during tests unless DEBUG is set
if (!process.env.DEBUG) {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
}

// Mock FFmpeg for tests to avoid requiring actual video processing
jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = jest.fn(() => ({
    seekInput: jest.fn().mockReturnThis(),
    duration: jest.fn().mockReturnThis(),
    videoCodec: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation((event, callback) => {
      if (event === 'end') {
        setTimeout(() => callback(), 100); // Simulate successful processing
      }
      return mockFfmpeg();
    }),
    run: jest.fn()
  }));
  
  mockFfmpeg.ffprobe = jest.fn((filePath, callback) => {
    callback(null, {
      format: { duration: 120 },
      streams: [
        { codec_type: 'video', width: 1920, height: 1080 }
      ]
    });
  });
  return mockFfmpeg;
});

// Mock database for tests
jest.mock('../db/database', () => ({
  initializeDatabase: jest.fn().mockResolvedValue({
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn()
  }),
  getVideoById: jest.fn(),
  addVideo: jest.fn(),
  updateVideo: jest.fn(),
  updateVideoPreview: jest.fn(),
  updateVideoThumbnail: jest.fn(),
  getAllVideos: jest.fn(),
  getVideoByPath: jest.fn(),
  getAllVideoPaths: jest.fn(),
  deleteVideo: jest.fn(),
  getVideosPaginated: jest.fn().mockResolvedValue({ videos: [], totalCount: 0 }),
  getVideosWithMetadata: jest.fn().mockResolvedValue([]),
  getVideosByIds: jest.fn().mockResolvedValue([])
}));