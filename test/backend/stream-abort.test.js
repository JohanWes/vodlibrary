// A client that disconnects before the stream starts is routine (seeking,
// closing a tab) and must not be logged as a server error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { getVideoStreamInfo } = require('../../db/database');
const { issueSessionToken } = require('../../lib/security-tokens');
const { app } = require('../../server');

describe('stream aborted before the response starts', () => {
  let tmpDir;
  let server;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-abort-'));
    fs.writeFileSync(path.join(tmpDir, 'v.mp4'), Buffer.alloc(1024));
    app.locals.db = {};
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('is not logged as an error and does not attempt a 500', async () => {
    let releaseLookup;
    let lookupStarted;
    const started = new Promise((resolve) => { lookupStarted = resolve; });
    getVideoStreamInfo.mockImplementationOnce(() => {
      lookupStarted();
      return new Promise((resolve) => { releaseLookup = resolve; });
    });

    const originalSendFile = app.response.sendFile;
    let sendFileDone;
    const sendFileResult = new Promise((resolve) => { sendFileDone = resolve; });
    jest.spyOn(app.response, 'sendFile').mockImplementation(function sendFile(file, options, callback) {
      return originalSendFile.call(this, file, options, (err) => {
        callback(err);
        sendFileDone({ err, statusCode: this.statusCode });
      });
    });

    const serverSawClose = new Promise((resolve) => {
      server.once('request', (_req, res) => res.once('close', resolve));
    });
    const req = http.get({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/api/videos/1/stream',
      headers: { Cookie: `auth_token=${issueSessionToken(process.env.SESSION_SECRET)}` }
    });
    req.on('error', () => {});
    await started;
    req.destroy();
    await serverSawClose;
    console.error.mockClear();
    releaseLookup({ id: 1, title: 'v', path: path.join(tmpDir, 'v.mp4'), width: 1, height: 1 });

    const { err, statusCode } = await sendFileResult;
    expect(err && err.code).toBe('ECONNABORTED');
    expect(statusCode).not.toBe(500);
    expect(console.error).not.toHaveBeenCalled();
  });
});
