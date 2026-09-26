const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { closeDatabase, getVideoStreamInfo } = require('../../db/database');
const { issueSessionToken } = require('../../lib/security-tokens');
const { app, createShutdownHandler } = require('../../server');

describe('graceful shutdown', () => {
  function fakeServer() {
    return {
      close: jest.fn((callback) => setImmediate(callback)),
      closeAllConnections: jest.fn()
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('closes the HTTP server, stops the media pipeline and closes the database, then exits 0', async () => {
    const server = fakeServer();
    const stopPipeline = jest.fn().mockResolvedValue(undefined);
    const db = {};
    const exit = jest.fn();

    const shutdown = createShutdownHandler({ server, db, stopPipeline, exit });
    await shutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledWith(db);
    expect(closeDatabase.mock.invocationCallOrder[0]).toBeGreaterThan(stopPipeline.mock.invocationCallOrder[0]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('uses lib/scanner stopMediaPipeline by default', async () => {
    const scanner = require('../../lib/scanner');
    const spy = jest.spyOn(scanner, 'stopMediaPipeline').mockResolvedValue(undefined);
    let isolatedCreate;
    jest.isolateModules(() => {
      jest.doMock('../../lib/scanner', () => scanner);
      ({ createShutdownHandler: isolatedCreate } = require('../../server'));
    });
    const exit = jest.fn();
    await isolatedCreate({ server: fakeServer(), db: {}, exit })('SIGTERM');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    spy.mockRestore();
  });

  test('exits 1 when stopping the media pipeline fails, but still closes the database', async () => {
    const exit = jest.fn();
    const stopPipeline = jest.fn().mockRejectedValue(new Error('ffmpeg would not die'));
    await createShutdownHandler({ server: fakeServer(), db: {}, stopPipeline, exit })('SIGTERM');
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('is idempotent and exits 1 when closing the database fails', async () => {
    closeDatabase.mockRejectedValueOnce(new Error('busy'));
    const exit = jest.fn();
    const shutdown = createShutdownHandler({ server: fakeServer(), db: {}, stopPipeline: jest.fn(), exit });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGINT')]);

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('forces exit 1 when the server does not close in time, closing the database first', async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      const server = { close: jest.fn(), closeAllConnections: jest.fn() };
      const shutdown = createShutdownHandler({ server, db: {}, stopPipeline: jest.fn(), exit, timeoutMs: 10000 });

      shutdown('SIGTERM');
      await jest.advanceTimersByTimeAsync(9999);
      expect(exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('forced exit does not wait forever for a hung database close', async () => {
    jest.useFakeTimers();
    try {
      closeDatabase.mockReturnValueOnce(new Promise(() => {}));
      const exit = jest.fn();
      const server = { close: jest.fn(), closeAllConnections: jest.fn() };
      createShutdownHandler({ server, db: {}, stopPipeline: jest.fn(), exit, timeoutMs: 1000 })('SIGTERM');

      await jest.advanceTimersByTimeAsync(1000);
      expect(exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('graceful shutdown with a real paused video stream', () => {
  let tmpDir;
  let server;
  let response;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-shutdown-'));
    fs.writeFileSync(path.join(tmpDir, 'big.mp4'), Buffer.alloc(32 * 1024 * 1024));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (response) response.destroy();
    if (server && server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not wait for open media connections; closes the database and exits 0', async () => {
    jest.clearAllMocks();
    getVideoStreamInfo.mockResolvedValue({ id: 1, title: 'big', path: path.join(tmpDir, 'big.mp4'), width: 1, height: 1 });
    app.locals.db = {};
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    // A player that loaded the start of the video and paused: headers received, body not read.
    response = await new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/videos/1/stream',
        headers: { Cookie: `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}` }
      }, (res) => {
        res.pause();
        resolve(res);
      }).on('error', reject);
    });
    expect(response.statusCode).toBe(200);

    let exitCode;
    const exited = new Promise((resolve) => {
      exitCode = jest.fn(resolve);
    });
    const started = Date.now();
    createShutdownHandler({ server, db: {}, stopPipeline: jest.fn(), exit: exitCode, timeoutMs: 3000 })('SIGTERM');

    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  }, 10000);
});

describe('environment loading', () => {
  test('server.js does not load .env under NODE_ENV=test', () => {
    const spy = jest.spyOn(process, 'loadEnvFile');
    jest.isolateModules(() => {
      require('../../server');
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
