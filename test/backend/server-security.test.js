const request = require('supertest');
const { issueShareToken } = require('../../lib/security-tokens');
const { issueSessionToken } = require('../../lib/security-tokens');
const { getVideoById, getVideoStreamInfo } = require('../../db/database');
const { app, parseTrustProxy, buildContentSecurityPolicy } = require('../../server');

describe('server security boundary', () => {
  const video = {
    id: 1,
    title: 'Test Video',
    duration: 60,
    width: 1920,
    height: 1080,
    added_date: '2026-08-01T00:00:00.000Z',
    death_timestamps: null,
    path: '/private/video.mp4',
    full_metadata: '{"secret":true}',
    preview_clips: null
  };

  beforeEach(() => {
    jest.clearAllMocks();
    app.locals.db = {};
    getVideoById.mockResolvedValue(video);
    getVideoStreamInfo.mockResolvedValue(video);
  });

  const sessionCookie = () => `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}`;

  test('rejects the legacy forged cookie and accepts a login-issued session', async () => {
    await request(app)
      .get('/')
      .set('Cookie', 'auth_token=valid-session')
      .expect(302)
      .expect('Location', '/login.html');

    const login = await request(app)
      .post('/login')
      .type('form')
      .send({ sessionKey: process.env.SESSION_KEY })
      .expect(302)
      .expect('Location', '/');

    const setCookie = login.headers['set-cookie'][0];
    expect(setCookie).toContain('auth_token=');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('valid-session');

    const cookie = setCookie.split(';', 1)[0];
    await request(app).get('/').set('Cookie', cookie).expect(200);
  });

  test('does not exchange the legacy master-password URL', async () => {
    const response = await request(app)
      .get(`/${process.env.SESSION_KEY}/watch/1`)
      .expect(302)
      .expect('Location', '/login.html');

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('exchanges a scoped share token for a clean cookie without escalating it', async () => {
    const token = issueShareToken(1, process.env.SHARE_TOKEN_SECRET);
    const exchange = await request(app)
      .get(`/s/${token}`)
      .expect(303)
      .expect('Location', '/watch/1');

    expect(exchange.headers['cache-control']).toBe('no-store');
    expect(exchange.headers['referrer-policy']).toBe('no-referrer');
    const setCookie = exchange.headers['set-cookie'][0];
    expect(setCookie).toContain('share_auth=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(exchange.headers.location).not.toContain(token);

    const cookie = setCookie.split(';', 1)[0];
    await request(app).get('/watch/1').set('Cookie', cookie).expect(200);

    const detail = await request(app)
      .get('/api/videos/1')
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.title).toBe('Test Video');
    expect(detail.body).not.toHaveProperty('path');
    expect(detail.body).not.toHaveProperty('full_metadata');

    for (const deniedPath of [
      '/api/videos',
      '/api/videos/2',
      '/api/share/1',
      '/api/refresh',
      '/api/updates',
      '/api/videos/1/preview-info',
      '/thumbnails/example.jpg'
    ]) {
      await request(app).get(deniedPath).set('Cookie', cookie).expect(401);
    }
  });

  test('escapes hostile titles and never trusts Host for watch metadata', async () => {
    getVideoStreamInfo.mockResolvedValue({
      ...video,
      title: '\"><svg onload="globalThis.pwned=true">'
    });

    const login = await request(app)
      .post('/login')
      .type('form')
      .send({ sessionKey: process.env.SESSION_KEY });
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0];

    const response = await request(app)
      .get('/watch/1')
      .set('Cookie', cookie)
      .set('Host', 'attacker.example')
      .expect(200);

    expect(response.text).not.toContain('<svg onload=');
    expect(response.text).toContain('&lt;svg onload=&quot;globalThis.pwned=true&quot;&gt;');
    expect(response.text).not.toContain('attacker.example');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  test('does not expand $-patterns from titles into the watch page', async () => {
    getVideoStreamInfo.mockResolvedValue({ ...video, title: "A$`B$&C$'D$$E" });

    const response = await request(app).get('/watch/1').set('Cookie', sessionCookie()).expect(200);

    expect(response.text).toContain('<title>A$`B$&amp;C$&#39;D$$E</title>');
    expect(response.text).toContain('<meta property="og:title" content="A$`B$&amp;C$&#39;D$$E" />');
    expect(response.text.match(/<head>/g)).toHaveLength(1);
    expect(response.text.match(/<\/head>/g)).toHaveLength(1);
  });

  test.each(['1.0', '%201', '01', 'abc'])('/watch/%s is not a canonical id -> 404 without a DB lookup', async (id) => {
    await request(app).get(`/watch/${id}`).set('Cookie', sessionCookie()).expect(404);
    expect(getVideoStreamInfo).not.toHaveBeenCalled();
  });

  test.each([
    ['public login page', '/login.html', null],
    ['401 API response', '/api/videos', null],
    ['authenticated page', '/', 'session']
  ])('sets baseline security headers on the %s', async (_label, url, auth) => {
    const req = request(app).get(url);
    if (auth) {
      req.set('Cookie', sessionCookie());
    }
    const response = await req;

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBe(buildContentSecurityPolicy());
    expect(response.headers['content-security-policy-report-only']).toBeUndefined();
  });

  test.each([
    ['/css/style.css', null, 'public, max-age=3600'],
    ['/js/utils.js', null, 'public, max-age=3600'],
    ['/js/player.js', null, 'public, max-age=3600'],
    ['/favicon.ico', null, 'public, max-age=3600'],
    ['/js/main.js', 'session', 'private, max-age=3600'],
    ['/js/video-preview.js', 'session', 'private, max-age=3600'],
    ['/login.html', null, 'no-cache'],
    ['/', 'session', 'no-cache'],
    ['/index.html', 'session', 'no-cache'],
    ['/player.html', 'session', 'no-cache'],
    ['/watch/1', 'session', 'no-cache']
  ])('%s is served with Cache-Control %s', async (url, auth, cacheControl) => {
    const req = request(app).get(url);
    if (auth) {
      req.set('Cookie', sessionCookie());
    }
    const response = await req.expect(200);
    expect(response.headers['cache-control']).toBe(cacheControl);
  });

  test('the Content-Security-Policy allows only same-origin resources', () => {
    const policy = buildContentSecurityPolicy();
    expect(policy).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
      + "media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
      + "base-uri 'self'; form-action 'self'; object-src 'none'"
    );
    expect(policy).not.toMatch(/https?:|unsafe-/);
  });

  describe('startup configuration (CSP, BASE_PATH)', () => {
    const KEYS = ['CSP_REPORT_ONLY', 'CDN_ENABLED', 'CDN_BASE_URL', 'BASE_PATH', 'VODS_NAME'];
    let saved;

    beforeEach(() => {
      saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    });

    afterEach(() => {
      for (const key of KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    });

    function loadApp(env) {
      Object.assign(process.env, env);
      let isolated;
      jest.isolateModules(() => {
        isolated = require('../../server');
      });
      isolated.app.locals.db = {};
      return isolated.app;
    }

    test('CSP_REPORT_ONLY=true sends the policy as Report-Only instead of enforcing it', async () => {
      const reportOnlyApp = loadApp({ CSP_REPORT_ONLY: 'true' });
      const response = await request(reportOnlyApp).get('/login.html').expect(200);
      expect(response.headers['content-security-policy-report-only']).toBe(buildContentSecurityPolicy());
      expect(response.headers['content-security-policy']).toBeUndefined();
    });

    test('an enabled CDN adds only its origin to media-src', async () => {
      const cdnApp = loadApp({ CDN_ENABLED: 'true', CDN_BASE_URL: 'https://cdn.example.test/vods/?x=1' });
      const response = await request(cdnApp).get('/login.html').expect(200);
      const policy = response.headers['content-security-policy'];
      expect(policy).toBe(buildContentSecurityPolicy('https://cdn.example.test'));
      expect(policy).toContain("media-src 'self' blob: https://cdn.example.test;");
      expect(policy.match(/cdn\.example\.test/g)).toHaveLength(1);
    });

    test('under BASE_PATH the pre-auth shell and share start times keep the prefix', async () => {
      const prefixed = loadApp({ BASE_PATH: '/vod' });
      await request(prefixed).get('/vod/vendor/plyr/plyr.js').expect(200);
      await request(prefixed).get('/vod/js/utils.js').expect(200);
      await request(prefixed).get('/vod/js/main.js').expect(302).expect('Location', '/vod/login.html');
      await request(prefixed).get('/vendor/plyr/plyr.js').expect(302).expect('Location', '/vod/login.html');

      const token = issueShareToken(1, process.env.SHARE_TOKEN_SECRET);
      await request(prefixed).get(`/vod/s/${token}?t=12.5`).expect(303).expect('Location', '/vod/watch/1?t=12.5');
      const api = await request(prefixed).get('/vod/API/videos').expect(401);
      expect(api.body).toEqual({ error: 'Authentication required' });
    });

    test('VODS_NAME is used verbatim in /api/config and the login page title (escaped)', async () => {
      const named = loadApp({ VODS_NAME: 'EvandisVods' });
      const config = await request(named).get('/api/config').expect(200);
      expect(config.body.vodsName).toBe('EvandisVods');
      const login = await request(named).get('/login.html').expect(200);
      expect(login.text).toContain('<title>Login - EvandisVods</title>');

      const hostile = await request(loadApp({ VODS_NAME: '<b>&' })).get('/login.html').expect(200);
      expect(hostile.text).toContain('<title>Login - &lt;b&gt;&amp;</title>');
    });

    test('a disabled CDN or an unusable CDN_BASE_URL adds no origin', async () => {
      for (const env of [
        { CDN_ENABLED: 'false', CDN_BASE_URL: 'https://cdn.example.test' },
        { CDN_ENABLED: 'true', CDN_BASE_URL: 'javascript:alert(1)' },
        { CDN_ENABLED: 'true', CDN_BASE_URL: 'not a url' }
      ]) {
        const response = await request(loadApp(env)).get('/login.html').expect(200);
        expect(response.headers['content-security-policy']).toBe(buildContentSecurityPolicy());
      }
    });
  });

  describe('GET /api/config', () => {
    const saved = process.env.ADVANCED_SEARCH_ENABLED;
    afterEach(() => {
      if (saved === undefined) {
        delete process.env.ADVANCED_SEARCH_ENABLED;
      } else {
        process.env.ADVANCED_SEARCH_ENABLED = saved;
      }
    });

    test.each([
      [undefined, false],
      ['false', false],
      ['1', false],
      ['true', true]
    ])('ADVANCED_SEARCH_ENABLED=%s -> advancedSearch %s, without authentication', async (value, expected) => {
      if (value === undefined) {
        delete process.env.ADVANCED_SEARCH_ENABLED;
      } else {
        process.env.ADVANCED_SEARCH_ENABLED = value;
      }
      const response = await request(app).get('/api/config').expect(200);
      expect(response.body).toEqual({ vodsName: expect.any(String), advancedSearch: expected });
    });
  });

  test.each(['/API/videos', '/Api/Videos/1', '/api/VIDEOS/1/stream', '/THUMBNAILS/t.jpg', '/Previews/p.mp4'])(
    'unauthenticated %s gets a 401 JSON response, not a login redirect',
    async (url) => {
      const response = await request(app).get(url).expect(401);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: 'Authentication required' });
    }
  );

  test('parseTrustProxy defaults to loopback and understands booleans, hop counts and lists', () => {
    expect(parseTrustProxy(undefined)).toBe('loopback');
    expect(parseTrustProxy('  ')).toBe('loopback');
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
