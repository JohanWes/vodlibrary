const request = require('supertest');
const { issueShareToken } = require('../../lib/security-tokens');
const { getVideoById } = require('../../db/database');
const { app } = require('../../server');

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
  });

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
    getVideoById.mockResolvedValue({
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
});
