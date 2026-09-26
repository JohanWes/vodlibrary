// stopMediaPipeline(): aborts a running scan (killing a hung ffprobe),
// never prunes on abort, and resolves once scanner DB work is finished.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('stopMediaPipeline', () => {
  let tmp;
  const saved = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-stop-'));
    for (const key of ['VIDEO_LIBRARY', 'FFPROBE_PATH', 'THUMBNAIL_CACHE_DIR', 'ENABLE_PREVIEWS']) saved[key] = process.env[key];
    const fakeProbe = path.join(tmp, 'hung-ffprobe');
    fs.writeFileSync(fakeProbe, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    fs.mkdirSync(path.join(tmp, 'lib'));
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) fs.writeFileSync(path.join(tmp, 'lib', name), 'x');
    Object.assign(process.env, {
      VIDEO_LIBRARY: path.join(tmp, 'lib'),
      FFPROBE_PATH: fakeProbe,
      THUMBNAIL_CACHE_DIR: path.join(tmp, 'thumbs'),
      ENABLE_PREVIEWS: 'false'
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('aborts a scan stuck in ffprobe without pruning', async () => {
    let scanner;
    let database;
    let ffmpeg;
    jest.isolateModules(() => {
      database = require('../../db/database');
      ffmpeg = require('../../lib/ffmpeg');
      scanner = require('../../lib/scanner');
    });
    database.getVideosForScan.mockResolvedValue([{ id: 1, path: path.join(tmp, 'lib', 'old.mp4') }]);
    database.getVideoScanStateByPath.mockResolvedValue(undefined);
    database.deleteVideo.mockClear();

    const scan = scanner.scanLibrary({});
    while (ffmpeg.getActiveProcessCount() === 0) { // until the first file's (hung) ffprobe runs
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(scanner.getScanStatus().status).toBe('running');
    expect(ffmpeg.getActiveProcessCount()).toBe(1);

    const started = Date.now();
    await scanner.stopMediaPipeline();
    await scan;
    expect(Date.now() - started).toBeLessThan(3000);

    expect(scanner.getScanStatus()).toMatchObject({ status: 'failed', message: expect.stringContaining('shutting down') });
    expect(database.deleteVideo).not.toHaveBeenCalled();
    expect(ffmpeg.getActiveProcessCount()).toBe(0);

    // Later scans are no-ops.
    await scanner.scanLibrary({});
    expect(scanner.getScanStatus().status).toBe('failed');
  });
});
