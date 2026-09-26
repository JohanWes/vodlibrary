/**
 * Range/HEAD/conditional-request contract for GET /api/videos/:id/stream on the
 * real server.js app, backed by a real in-memory SQLite database and real
 * files in a temp dir.
 */
jest.unmock('../../db/database');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const request = require('supertest');
const { issueSessionToken } = require('../../lib/security-tokens');
const { initializeDatabase, closeDatabase, addVideo } = require('../../db/database');
const { app } = require('../../server');

const SIZE = 10000;

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('video stream route (real app, real SQLite, real files)', () => {
  let tmpDir;
  let db;
  let content;
  const ids = {};
  const cookie = () => `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}`;
  const get = (url) => request(app).get(url).set('Cookie', cookie()).buffer(true).parse(binaryParser);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-stream-'));
    content = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i += 1) {
      content[i] = i % 256;
    }

    const files = {
      mp4: path.join(tmpDir, 'video.mp4'),
      mkv: path.join(tmpDir, 'video.mkv'),
      webm: path.join(tmpDir, 'video.webm'),
      odd: path.join(tmpDir, 'Run 100% #1 ü.mp4'),
      big: path.join(tmpDir, 'big.mp4')
    };
    for (const [key, file] of Object.entries(files)) {
      fs.writeFileSync(file, key === 'big' ? Buffer.alloc(8 * 1024 * 1024) : content);
    }
    fs.mkdirSync(path.join(tmpDir, 'directory.mp4'));
    fs.mkdirSync(path.join(tmpDir, '.hidden-dir'));
    fs.writeFileSync(path.join(tmpDir, '.hidden-dir', 'inside.mp4'), content);

    db = await initializeDatabase(':memory:');
    app.locals.db = db;
    const rows = {
      ...files,
      missing: path.join(tmpDir, 'missing.mp4'),
      directory: path.join(tmpDir, 'directory.mp4'),
      dotdir: path.join(tmpDir, '.hidden-dir', 'inside.mp4')
    };
    for (const [key, file] of Object.entries(rows)) {
      ids[key] = await addVideo(db, { title: key, path: file, duration: 10, added_date: '2026-01-01T00:00:00.000Z' });
    }
  });

  afterAll(async () => {
    await closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no Range: 200 with full body, length, ranges and private caching', async () => {
    const res = await get(`/api/videos/${ids.mp4}/stream`).expect(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.etag).toBeDefined();
    expect(res.body.equals(content)).toBe(true);
  });

  test.each([
    ['bytes=0-', 0, SIZE - 1],
    ['bytes=100-199', 100, 199],
    ['bytes=-500', SIZE - 500, SIZE - 1],
    ['bytes=9000-99999999999', 9000, SIZE - 1]
  ])('%s -> 206 %i-%i', async (range, start, end) => {
    const res = await get(`/api/videos/${ids.mp4}/stream`).set('Range', range).expect(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${SIZE}`);
    expect(res.headers['content-length']).toBe(String(end - start + 1));
    expect(res.body.equals(content.subarray(start, end + 1))).toBe(true);
  });

  test.each(['bytes=5-2', `bytes=${SIZE}-`, 'bytes=-0', 'bytes=abc'])(
    '%s -> 416 with Content-Range: bytes */size and no caching headers',
    async (range) => {
      const res = await get(`/api/videos/${ids.mp4}/stream`).set('Range', range).expect(416);
      expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers.etag).toBeUndefined();
      expect(res.headers['last-modified']).toBeUndefined();
    }
  );

  test.each(['items=0-5', 'bytes=0-1,5-9'])('%s (unsupported) is ignored -> 200 full body', async (range) => {
    const res = await get(`/api/videos/${ids.mp4}/stream`).set('Range', range).expect(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.headers['content-range']).toBeUndefined();
  });

  test('HEAD returns headers without reading the file', async () => {
    const spy = jest.spyOn(fs, 'createReadStream');
    const res = await request(app).head(`/api/videos/${ids.mp4}/stream`).set('Cookie', cookie()).expect(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(spy).not.toHaveBeenCalled();
  });

  test('If-None-Match with the current ETag -> 304; stale If-Range -> 200 full body', async () => {
    const first = await get(`/api/videos/${ids.mp4}/stream`).expect(200);
    await request(app)
      .get(`/api/videos/${ids.mp4}/stream`)
      .set('Cookie', cookie())
      .set('If-None-Match', first.headers.etag)
      .expect(304);

    const stale = await get(`/api/videos/${ids.mp4}/stream`)
      .set('Range', 'bytes=0-9')
      .set('If-Range', 'W/"stale"')
      .expect(200);
    expect(stale.headers['content-length']).toBe(String(SIZE));

    await get(`/api/videos/${ids.mp4}/stream`)
      .set('Range', 'bytes=0-9')
      .set('If-Range', first.headers.etag)
      .expect(206);
  });

  test.each([
    ['mkv', 'video/x-matroska'],
    ['webm', 'video/webm']
  ])('.%s is served as %s', async (key, type) => {
    const res = await get(`/api/videos/${ids[key]}/stream`).expect(200);
    expect(res.headers['content-type']).toBe(type);
  });

  test('file names with spaces, %, # and non-ASCII characters stream correctly', async () => {
    const res = await get(`/api/videos/${ids.odd}/stream`).set('Range', 'bytes=0-9').expect(206);
    expect(res.body.equals(content.subarray(0, 10))).toBe(true);
  });

  test('videos inside dot-directories of the library still stream', async () => {
    await get(`/api/videos/${ids.dotdir}/stream`).expect(200);
  });

  test.each(['missing', 'directory'])('%s file -> 404 JSON without caching headers (no crash)', async (key) => {
    const res = await request(app).get(`/api/videos/${ids[key]}/stream`).set('Cookie', cookie()).expect(404);
    expect(res.body).toEqual({ error: 'Video file not found' });
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['content-range']).toBeUndefined();
  });

  (process.getuid && process.getuid() === 0 ? test.skip : test)(
    'unreadable file -> GET and HEAD both 500 without caching headers',
    async () => {
      const file = path.join(tmpDir, 'unreadable.mp4');
      fs.writeFileSync(file, content);
      fs.chmodSync(file, 0o000);
      const id = await addVideo(db, { title: 'unreadable', path: file, duration: 10, added_date: '2026-01-01T00:00:00.000Z' });
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).get(`/api/videos/${id}/stream`).set('Cookie', cookie()).expect(500);
      expect(res.body).toEqual({ error: 'Failed to stream video' });
      const head = await request(app).head(`/api/videos/${id}/stream`).set('Cookie', cookie()).expect(500);
      expect(head.headers['content-type']).toMatch(/application\/json/);
      for (const r of [res, head]) {
        expect(r.headers['cache-control']).toBeUndefined();
      }
    }
  );

  test('unknown id -> 404', async () => {
    const res = await request(app).get('/api/videos/999999/stream').set('Cookie', cookie()).expect(404);
    expect(res.body).toEqual({ error: 'Video not found' });
  });

  test.each(['1.0', '%201', '01', '-1', '1e0', '9007199254740993'])('non-canonical id %s -> 400', async (id) => {
    const res = await request(app).get(`/api/videos/${id}/stream`).set('Cookie', cookie()).expect(400);
    expect(res.body).toEqual({ error: 'Invalid video id' });
  });

  const fdsOpenOn = (file) => {
    let count = 0;
    for (const fd of fs.readdirSync('/proc/self/fd')) {
      try {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === file) {
          count += 1;
        }
      } catch (_error) {
        // fd closed while iterating
      }
    }
    return count;
  };

  (fs.existsSync('/proc/self/fd') ? test : test.skip)('aborted requests release their file descriptors', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const bigFile = path.join(tmpDir, 'big.mp4');

    try {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => {
          const req = http.get({
            host: '127.0.0.1',
            port,
            path: `/api/videos/${ids.big}/stream`,
            headers: { Cookie: cookie(), Range: 'bytes=0-' }
          }, (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          });
          req.on('error', resolve);
        });
      }

      const deadline = Date.now() + 3000;
      while (fdsOpenOn(bigFile) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fdsOpenOn(bigFile)).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('CDN redirect (auth disabled, BASE_PATH set)', () => {
  test('redirects to the CDN once, without doubling BASE_PATH or trusting Host', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      ENABLE_AUTH: 'false',
      BASE_PATH: '/vods',
      CDN_ENABLED: 'true',
      CDN_PROVIDER: 'custom',
      CDN_BASE_URL: 'https://cdn.example.com'
    });

    try {
      let isolatedApp;
      let database;
      jest.isolateModules(() => {
        ({ app: isolatedApp } = require('../../server'));
        database = require('../../db/database');
      });
      const db = await database.initializeDatabase(':memory:');
      isolatedApp.locals.db = db;
      const id = await database.addVideo(db, { title: 'v', path: '/nonexistent/v.mp4', duration: 1, added_date: 'x' });

      const res = await request(isolatedApp)
        .get(`/vods/api/videos/${id}/stream`)
        .set('Host', 'attacker.example')
        .expect(302);
      expect(res.headers.location).toBe(`https://cdn.example.com/vods/api/videos/${id}/stream`);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      await database.closeDatabase(db);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, saved);
    }
  });
});
