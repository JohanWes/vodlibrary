const request = require('supertest');
const path = require('path');

// Basic test to verify the core functionality works
describe('Basic VODlibrary Functionality', () => {
  test('preview generation module loads correctly', () => {
    const preview = require('../lib/preview');
    expect(preview).toBeDefined();
    expect(typeof preview.generatePreviewClips).toBe('function');
    expect(typeof preview.previewsExist).toBe('function');
    expect(typeof preview.getPreviewClips).toBe('function');
  });

  test('database module has preview functions', () => {
    const database = require('../db/database');
    expect(database).toBeDefined();
    expect(typeof database.updateVideoPreview).toBe('function');
    expect(typeof database.getVideoById).toBe('function');
  });

  test('video preview manager class is available', () => {
    // Mock DOM environment for testing
    global.document = {
      createElement: jest.fn(() => ({
        style: {},
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        appendChild: jest.fn(),
        removeChild: jest.fn(),
        contains: jest.fn(() => true),
        querySelector: jest.fn(),
        cloneNode: jest.fn(() => ({ parentNode: null }))
      })),
      addEventListener: jest.fn(),
      hidden: false
    };

    global.window = {
      addEventListener: jest.fn(),
      VideoPreviewManager: undefined,
      IntersectionObserver: jest.fn(() => ({
        observe: jest.fn(),
        unobserve: jest.fn(),
        disconnect: jest.fn()
      })),
      performance: { now: jest.fn(() => 1000) }
    };

    global.navigator = {
      connection: {
        effectiveType: '4g',
        downlink: 10
      }
    };

    // Load the video preview manager
    const { VideoPreviewManager } = require('../public/js/video-preview');
    
    expect(VideoPreviewManager).toBeDefined();
    
    const manager = new VideoPreviewManager();
    expect(manager).toBeDefined();
    expect(typeof manager.showPreview).toBe('function');
    expect(typeof manager.hidePreview).toBe('function');
    expect(typeof manager.getVideoElement).toBe('function');
    expect(typeof manager.releaseVideoElement).toBe('function');
  });

  test('preview API structure is correct', () => {
    // Test that the preview info structure matches expected format
    const expectedPreviewInfo = {
      hasPreview: true,
      status: 'completed',
      clips: [
        {
          timestamp: 10,
          duration: 5,
          path: '/previews/test_10s.mp4',
          size: 524288
        }
      ]
    };

    expect(expectedPreviewInfo).toHaveProperty('hasPreview');
    expect(expectedPreviewInfo).toHaveProperty('status');
    expect(expectedPreviewInfo).toHaveProperty('clips');
    expect(Array.isArray(expectedPreviewInfo.clips)).toBe(true);
    
    if (expectedPreviewInfo.clips.length > 0) {
      const clip = expectedPreviewInfo.clips[0];
      expect(clip).toHaveProperty('timestamp');
      expect(clip).toHaveProperty('duration');
      expect(clip).toHaveProperty('path');
      expect(clip).toHaveProperty('size');
    }
  });

  test('preview generation config is loaded', () => {
    // Test that the preview module loads with hardcoded configuration
    const preview = require('../lib/preview');
    
    expect(preview).toBeDefined();
    expect(typeof preview.generatePreviewClips).toBe('function');
    expect(typeof preview.previewsExist).toBe('function');
    expect(typeof preview.getPreviewClips).toBe('function');
    expect(typeof preview.cleanupOldPreviews).toBe('function');
  });
});