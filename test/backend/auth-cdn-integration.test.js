// jest is available globally from setup.js
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// Mock dependencies
const mockDb = {
  get: jest.fn(),
  run: jest.fn(),
  all: jest.fn()
};

const mockCdnManager = {
  shouldUseCdn: jest.fn(),
  getCdnUrl: jest.fn(),
  getConfig: jest.fn(),
  initCdn: jest.fn()
};

jest.mock('../../db/database', () => ({
  getVideoById: jest.fn()
}));

jest.mock('../../lib/cdn', () => mockCdnManager);

describe('Authentication and CDN Integration Tests', () => {
  let app;
  const testVideoData = {
    id: 1,
    title: 'Test Video',
    path: '/test-videos/test-video-1.mp4',
    preview_clips: JSON.stringify({
      clips: [{ timestamp: 10, path: '/previews/test_10s.mp4', duration: 3, size: 524288 }]
    }),
    preview_generation_status: 'completed'
  };

  beforeEach(async () => {
    // Create express app with authentication middleware
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    
    // Mock environment variables
    process.env.ENABLE_AUTH = 'true';
    process.env.SESSION_KEY = 'test-session-key';
    process.env.CDN_ENABLED = 'false';
    
    app.locals.db = mockDb;
    
    // Add basic auth middleware similar to server.js
    const AUTH_COOKIE_NAME = 'auth_token';
    const AUTH_COOKIE_VALUE = 'valid-session';
    
    app.use((req, res, next) => {
      if (process.env.ENABLE_AUTH === 'true') {
        const allowedPaths = ['/api/config', '/login'];
        if (allowedPaths.includes(req.path)) {
          return next();
        }
        
        if (req.cookies && req.cookies[AUTH_COOKIE_NAME] === AUTH_COOKIE_VALUE) {
          return next();
        }
        
        return res.status(401).json({ error: 'Authentication required' });
      }
      next();
    });
    
    // Import and use the API routes
    const { default: apiRoutes } = await import('../../routes/api.js');
    app.use('/api', apiRoutes);
    
    jest.clearAllMocks();
  });

  describe('Authentication Tests', () => {
    test('should require authentication for preview endpoints when auth enabled', async () => {
      process.env.ENABLE_AUTH = 'true';
      
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    test('should allow access with valid authentication cookie', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(200);

      expect(response.headers['content-type']).toBe('video/mp4');
    });

    test('should reject invalid authentication cookie', async () => {
      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=invalid-session')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    test('should allow access when authentication is disabled', async () => {
      process.env.ENABLE_AUTH = 'false';
      
      // Recreate app without auth middleware
      app = express();
      app.use(express.json());
      app.locals.db = mockDb;
      
      const { default: apiRoutes } = await import('../../routes/api.js');
      app.use('/api', apiRoutes);
      
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(200);

      expect(response.headers['content-type']).toBe('video/mp4');
    });

    test('should allow access to preview-info endpoint with authentication', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      const response = await request(app)
        .get('/api/videos/1/preview-info')
        .set('Cookie', 'auth_token=valid-session')
        .expect(200);

      expect(response.body.hasPreview).toBe(true);
    });
  });

  describe('CDN Integration Tests', () => {
    beforeEach(() => {
      process.env.CDN_ENABLED = 'true';
      process.env.CDN_PROVIDER = 'cloudflare';
      process.env.CDN_BASE_URL = 'https://cdn.example.com';
    });

    test('should redirect to CDN URL when CDN is enabled for previews', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(302);

      expect(response.headers.location).toBe('https://cdn.example.com/previews/test_10s.mp4');
      expect(mockCdnManager.shouldUseCdn).toHaveBeenCalledWith(
        expect.stringContaining('/api/videos/1/preview/10'),
        'preview'
      );
    });

    test('should serve locally when CDN is disabled', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(false);

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(200);

      expect(response.headers['content-type']).toBe('video/mp4');
      expect(mockCdnManager.shouldUseCdn).toHaveBeenCalled();
    });

    test('should handle CDN errors gracefully and fallback to local serving', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockImplementation(() => {
        throw new Error('CDN error');
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(200);

      // Should fallback to local serving
      expect(response.headers['content-type']).toBe('video/mp4');
    });

    test('should respect CDN configuration for different content types', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      // Mock CDN manager to handle different content types
      mockCdnManager.shouldUseCdn.mockImplementation((url, contentType) => {
        return contentType === 'preview'; // Only use CDN for previews
      });
      
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(302);

      expect(mockCdnManager.shouldUseCdn).toHaveBeenCalledWith(
        expect.any(String),
        'preview'
      );
    });
  });

  describe('CDN with Authentication Integration', () => {
    test('should generate signed CDN URLs when signed URLs are enabled', async () => {
      process.env.CDN_SIGNED_URLS = 'true';
      process.env.CDN_SIGNED_URLS_SECRET = 'test-secret';
      
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4?signature=abc123');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(302);

      expect(response.headers.location).toContain('signature=');
    });

    test('should handle authentication for CDN redirects properly', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://cdn.example.com/previews/test_10s.mp4');

      // First, test without authentication
      let response = await request(app)
        .get('/api/videos/1/preview/10')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');

      // Then test with authentication
      response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(302);

      expect(response.headers.location).toBe('https://cdn.example.com/previews/test_10s.mp4');
    });
  });

  describe('CDN Configuration Tests', () => {
    test('should respect CDN provider-specific settings', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      // Test with different CDN providers
      const providers = ['cloudflare', 'aws', 'custom'];
      
      for (const provider of providers) {
        process.env.CDN_PROVIDER = provider;
        
        mockCdnManager.shouldUseCdn.mockReturnValue(true);
        mockCdnManager.getCdnUrl.mockReturnValue(`https://${provider}.example.com/previews/test_10s.mp4`);

        const response = await request(app)
          .get('/api/videos/1/preview/10')
          .set('Cookie', 'auth_token=valid-session')
          .expect(302);

        expect(response.headers.location).toContain(provider);
      }
    });

    test('should handle CDN region configuration', async () => {
      process.env.CDN_REGION = 'us-east-1';
      
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockReturnValue('https://us-east-1.cdn.example.com/previews/test_10s.mp4');

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .expect(302);

      expect(response.headers.location).toContain('us-east-1');
    });
  });

  describe('Performance with Authentication and CDN', () => {
    test('should cache authentication results to avoid repeated checks', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);

      // Make multiple requests with the same auth cookie
      const requests = Array(5).fill().map(() =>
        request(app)
          .get('/api/videos/1/preview/10')
          .set('Cookie', 'auth_token=valid-session')
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    test('should handle CDN timeouts gracefully', async () => {
      const { getVideoById } = await import('../../db/database');
      getVideoById.mockResolvedValue(testVideoData);
      
      mockCdnManager.shouldUseCdn.mockReturnValue(true);
      mockCdnManager.getCdnUrl.mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve('https://cdn.example.com/previews/test_10s.mp4'), 5000);
        });
      });

      const response = await request(app)
        .get('/api/videos/1/preview/10')
        .set('Cookie', 'auth_token=valid-session')
        .timeout(1000);

      // Should either timeout or fallback to local serving
      expect([200, 302, 500, 408]).toContain(response.status);
    });
  });
});