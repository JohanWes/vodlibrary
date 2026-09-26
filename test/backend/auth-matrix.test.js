/**
 * Auth boundary matrix on the real server.js app: every media/API route x every
 * credential kind, plus login failure handling and the per-IP login throttle.
 * Uses a real in-memory SQLite database and temp media files.
 */
jest.unmock('../../db/database');
jest.mock('../../lib/scanner', () => ({
  scanLibrary: jest.fn().mockResolvedValue(undefined),
  getScanStatus: jest.fn(() => ({ status: 'idle' })),
  processVideoFile: jest.fn(),
  isVideoFile: jest.fn(() => true)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const request = require('supertest');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-auth-'));
const thumbsDir = path.join(tmpDir, 'thumbs');
const previewsDir = path.join(tmpDir, 'previews');
fs.mkdirSync(thumbsDir);
fs.mkdirSync(previewsDir);
fs.writeFileSync(path.join(thumbsDir, 't1.jpg'), 'jpg');
fs.writeFileSync(path.join(previewsDir, 'p1_0s.mp4'), 'preview');
fs.writeFileSync(path.join(tmpDir, 'v1.mp4'), Buffer.alloc(4096));
fs.writeFileSync(path.join(tmpDir, 'v2.mp4'), Buffer.alloc(4096));

const savedEnv = { ...process.env };
process.env.THUMBNAIL_CACHE_DIR = thumbsDir;
process.env.PREVIEWS_CACHE_DIR = previewsDir;

const { issueSessionToken, issueShareToken } = require('../../lib/security-tokens');
const { initializeDatabase, closeDatabase, addVideo, updateVideoFields } = require('../../db/database');
const { app, resetLoginThrottle } = require('../../server');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SHARE_SECRET = process.env.SHARE_TOKEN_SECRET;
const EIGHT_DAYS_AGO = Date.now() - 8 * 24 * 60 * 60 * 1000;

const CREDENTIALS = {
  none: '',
  forgedCookie: 'auth_token=valid-session',
  wrongSecretSession: `auth_token=${issueSessionToken('some-other-secret')}`,
  expiredSession: `auth_token=${issueSessionToken(SESSION_SECRET, { now: EIGHT_DAYS_AGO })}`,
  validSession: `auth_token=${issueSessionToken(SESSION_SECRET)}`,
  shareRightVideo: `share_auth=${issueShareToken(1, SHARE_SECRET)}`,
  shareWrongVideo: `share_auth=${issueShareToken(2, SHARE_SECRET)}`,
  expiredShare: `share_auth=${issueShareToken(1, SHARE_SECRET, { now: EIGHT_DAYS_AGO })}`,
  sessionTokenAsShare: `share_auth=${issueSessionToken(SESSION_SECRET)}`,
  shareTokenAsSession: `auth_token=${issueShareToken(1, SHARE_SECRET)}`
};

// App-shell files served before checkAuth (login page and share viewers need
// them): the build's assets/ directory. Tests serve the web/ sources.
const PRE_AUTH_ASSETS = ['/assets/blank.mp4'];

// kind: 'page' denies with a redirect to the login page, 'api' with 401.
// share: reachable with a share cookie for video 1 (GET/HEAD only);
// shareVideo2: reachable with the share cookie for video 2 instead;
// public: reachable with any credential or none.
const ROUTES = [
  ...PRE_AUTH_ASSETS.map((assetPath) => ({ method: 'GET', path: assetPath, kind: 'page', ok: 200, public: true })),
  { method: 'HEAD', path: '/assets/blank.mp4', kind: 'page', ok: 200, public: true },
  { method: 'GET', path: '/', kind: 'page', ok: 200 },
  { method: 'GET', path: '/index.html', kind: 'page', ok: 200 },
  { method: 'GET', path: '/js/main.js', kind: 'page', ok: 200 },
  { method: 'GET', path: '/js/video-preview.js', kind: 'page', ok: 200 },
  { method: 'GET', path: '/player.html', kind: 'page', ok: 200 },
  { method: 'GET', path: '/watch/1', kind: 'page', ok: 200, share: true },
  { method: 'HEAD', path: '/watch/1', kind: 'page', ok: 200, share: true },
  { method: 'GET', path: '/api/videos', kind: 'api', ok: 200 },
  // Express routing is case-insensitive, so the 401 classification is too.
  { method: 'GET', path: '/API/videos', kind: 'api', ok: 200 },
  { method: 'GET', path: '/Thumbnails/t1.jpg', kind: 'api', ok: 200 },
  { method: 'GET', path: '/api/videos/1', kind: 'api', ok: 200, share: true },
  { method: 'GET', path: '/api/videos/1/stream', kind: 'api', ok: 200, share: true },
  { method: 'HEAD', path: '/api/videos/1/stream', kind: 'api', ok: 200, share: true },
  { method: 'GET', path: '/api/videos/2/stream', kind: 'api', ok: 200, shareVideo2: true },
  { method: 'GET', path: '/api/videos/1/preview-info', kind: 'api', ok: 200 },
  { method: 'GET', path: '/api/videos/1/preview/0', kind: 'api', ok: 200 },
  { method: 'GET', path: '/thumbnails/t1.jpg', kind: 'api', ok: 200 },
  { method: 'GET', path: '/previews/p1_0s.mp4', kind: 'api', ok: 200 },
  { method: 'GET', path: '/api/share/1', kind: 'api', ok: 200 },
  { method: 'GET', path: '/api/scan/status', kind: 'api', ok: 200 },
  { method: 'GET', path: '/api/updates', kind: 'api', ok: 200 },
  { method: 'POST', path: '/api/refresh', kind: 'api', ok: 202 },
  { method: 'POST', path: '/api/videos/advanced-search', kind: 'api', ok: 400 },
  // Share-scoped paths with a method a share cookie may not use.
  { method: 'POST', path: '/api/videos/1/stream', kind: 'api', ok: 404 },
  { method: 'POST', path: '/watch/1', kind: 'page', ok: 404 }
];

function expectedStatus(route, credential) {
  if (credential === 'validSession' || route.public) {
    return route.ok;
  }
  const readOnly = route.method === 'GET' || route.method === 'HEAD';
  if (readOnly && credential === 'shareRightVideo' && route.share) {
    return route.ok;
  }
  if (readOnly && credential === 'shareWrongVideo' && route.shareVideo2) {
    return route.ok;
  }
  return route.kind === 'page' ? 302 : 401;
}

let server;
let port;
let db;

// Raw request that resolves on the response head and then drops the
// connection, so long-lived responses (SSE, video) don't stall the test.
function probe(method, urlPath, cookie, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }
    }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  db = await initializeDatabase(':memory:');
  app.locals.db = db;
  const id1 = await addVideo(db, { title: 'one', path: path.join(tmpDir, 'v1.mp4'), duration: 5, added_date: '2026-01-01' });
  const id2 = await addVideo(db, { title: 'two', path: path.join(tmpDir, 'v2.mp4'), duration: 5, added_date: '2026-01-02' });
  expect([id1, id2]).toEqual([1, 2]);
  await updateVideoFields(db, 1, {
    preview_clips: JSON.stringify({ clips: [{ timestamp: 0, path: '/previews/p1_0s.mp4' }] }),
    preview_generation_status: 'completed'
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  ({ port } = server.address());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase(db);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = savedEnv;
});

describe('auth matrix', () => {
  const cases = [];
  for (const route of ROUTES) {
    for (const credential of Object.keys(CREDENTIALS)) {
      cases.push([route.method, route.path, credential, expectedStatus(route, credential), route.kind]);
    }
  }

  test.each(cases)('%s %s with %s -> %i', async (method, urlPath, credential, status, kind) => {
    const response = await probe(method, urlPath, CREDENTIALS[credential]);
    expect(response.status).toBe(status);
    if (status === 302) {
      expect(response.headers.location).toBe('/login.html');
    }
    if (status === 401 && kind === 'api' && method !== 'HEAD') {
      expect(response.headers['content-type']).toMatch(/application\/json/);
    }
  });
});

describe('pre-auth app shell', () => {
  test('assets are served to anonymous viewers as the real file', async () => {
    const response = await probe('GET', '/assets/blank.mp4', '');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^video\/mp4/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test.each([
    '/assets/../js/main.js',
    '/assets/%2e%2e/js/main.js',
    '/assets/..%2fjs/main.js',
    '/assets/%2e%2e/index.html'
  ])('%s cannot reach private files without credentials', async (urlPath) => {
    const response = await probe('GET', urlPath, '');
    expect(response.status).not.toBe(200);
  });

  test('a missing pre-auth path falls through to the auth check', async () => {
    const response = await probe('GET', '/assets/does-not-exist.js', '');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/login.html');
  });
});

describe('share link exchange', () => {
  test('valid token -> 303 to the watch page with a scoped, expiring cookie', async () => {
    const token = issueShareToken(1, SHARE_SECRET, { ttlMs: 60 * 60 * 1000 });
    const response = await probe('GET', `/s/${token}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/watch/1');
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toMatch(/Max-Age=(3599|3600);/);
    expect(cookie).toContain('HttpOnly');
  });

  test.each([
    ['?t=90', '/watch/1?t=90'],
    ['?t=90.5', '/watch/1?t=90.5'],
    ['?t=0', '/watch/1?t=0'],
    ['?t=090', '/watch/1?t=90'],
    ['?t=999999.999', '/watch/1?t=999999.999'],
    ['?t=1000000', '/watch/1'],
    ['?t=-5', '/watch/1'],
    ['?t=1e3', '/watch/1'],
    ['?t=abc', '/watch/1'],
    ['?t=', '/watch/1'],
    ['?t=90&t=91', '/watch/1'],
    ['?t=%2F%2Fevil.example', '/watch/1'],
    ['?t=90%0d%0aX-Evil:1', '/watch/1'],
    ['?start=90', '/watch/1']
  ])('%s is forwarded to the watch page only as a validated start time (-> %s)', async (query, location) => {
    const token = issueShareToken(1, SHARE_SECRET);
    const response = await probe('GET', `/s/${token}${query}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(location);
  });

  test.each([
    ['expired', issueShareToken(1, SHARE_SECRET, { now: EIGHT_DAYS_AGO })],
    ['wrong secret', issueShareToken(1, 'another-secret')],
    ['session token', issueSessionToken(SESSION_SECRET)],
    ['garbage', 'not-a-token']
  ])('%s token -> 404 without a cookie', async (_label, token) => {
    const response = await probe('GET', `/s/${token}`);
    expect(response.status).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('login', () => {
  const login = (sessionKey, ip = '203.0.113.10') => request(app)
    .post('/login')
    .set('X-Forwarded-For', ip)
    .type('form')
    .send(sessionKey === undefined ? {} : { sessionKey });

  beforeEach(() => {
    resetLoginThrottle();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('correct key -> redirect home with a session cookie', async () => {
    const response = await login(process.env.SESSION_KEY).expect(302);
    expect(response.headers.location).toBe('/');
    expect(response.headers['set-cookie'][0]).toMatch(/^auth_token=/);
  });

  test.each([
    ['wrong key', 'wrong-key'],
    ['key prefix', process.env.SESSION_KEY.slice(0, -1)],
    ['key with suffix', `${process.env.SESSION_KEY}x`],
    ['missing key', undefined],
    ['empty key', '']
  ])('%s -> redirect to the login page with an error and no cookie', async (_label, key) => {
    const response = await login(key).expect(302);
    expect(response.headers.location).toBe('/login.html?error=1');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('non-string key (JSON array) is rejected', async () => {
    const response = await request(app)
      .post('/login')
      .send({ sessionKey: [process.env.SESSION_KEY] })
      .expect(302);
    expect(response.headers.location).toBe('/login.html?error=1');
  });

  test('5 failures lock the client IP out for 15 minutes, even for the correct key', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login('wrong').expect(302);
    }

    const locked = await login(process.env.SESSION_KEY).expect(429);
    expect(locked.headers['set-cookie']).toBeUndefined();
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(890);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(900);

    // Other clients (distinct X-Forwarded-For via the trusted loopback proxy) are unaffected.
    await login(process.env.SESSION_KEY, '198.51.100.7').expect(302).expect('Location', '/');

    // The lockout expires.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 15 * 60 * 1000 + 1000);
    await login(process.env.SESSION_KEY).expect(302).expect('Location', '/');
  });

  test('IPv6 clients are throttled per /64, so rotating the interface id does not help', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await login('wrong', `2001:db8:1:2::${i}`).expect(302);
    }
    await login(process.env.SESSION_KEY, '2001:db8:1:2:ffff:ffff:ffff:ffff').expect(429);
    await login(process.env.SESSION_KEY, '2001:db8:1:3::1').expect(302).expect('Location', '/');
  });

  test('an IPv4-mapped IPv6 address shares the IPv4 bucket', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login('wrong', '203.0.113.20');
    }
    await login(process.env.SESSION_KEY, '::ffff:203.0.113.20').expect(429);
  });

  test('a successful login resets the failure count', async () => {
    for (let i = 0; i < 4; i += 1) {
      await login('wrong');
    }
    await login(process.env.SESSION_KEY).expect('Location', '/');
    for (let i = 0; i < 4; i += 1) {
      await login('wrong');
    }
    await login(process.env.SESSION_KEY).expect(302).expect('Location', '/');
  });

  test('TRUST_PROXY=false ignores X-Forwarded-For, so spoofed addresses share one bucket', async () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'false';
    let isolatedApp;
    try {
      jest.isolateModules(() => {
        ({ app: isolatedApp } = require('../../server'));
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }

    for (let i = 0; i < 5; i += 1) {
      await request(isolatedApp).post('/login').set('X-Forwarded-For', `192.0.2.${i}`).type('form').send({ sessionKey: 'wrong' });
    }
    await request(isolatedApp)
      .post('/login')
      .set('X-Forwarded-For', '192.0.2.99')
      .type('form')
      .send({ sessionKey: process.env.SESSION_KEY })
      .expect(429);
  });
});
