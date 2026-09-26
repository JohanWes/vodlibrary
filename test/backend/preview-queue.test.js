// lib/preview.js queue semantics with a controllable fake ffmpeg.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../lib/ffmpeg', () => {
  const actual = jest.requireActual('../../lib/ffmpeg');
  return { ...actual, runFfmpeg: jest.fn() };
});

const ffmpeg = require('../../lib/ffmpeg');

function outputOf(args) {
  return args[args.length - 1];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('preview queue', () => {
  let tmp;
  let preview;
  const saved = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-preview-q-'));
    for (const key of ['PREVIEWS_CACHE_DIR', 'PREVIEW_DURATION', 'PREVIEW_MAX_CONCURRENT', 'PREVIEW_QUALITY', 'PREVIEW_TIMEOUT_SECONDS', 'FFMPEG_PATH']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PREVIEWS_CACHE_DIR = tmp;
    process.env.PREVIEW_DURATION = '2';
    process.env.PREVIEW_MAX_CONCURRENT = '1';
    ffmpeg.runFfmpeg.mockReset();
    jest.isolateModules(() => {
      preview = require('../../lib/preview');
    });
  });

  afterEach(() => {
    preview.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('default preset is card-sized H.264 (<= 640 px wide)', () => {
    const config = preview.getConfig();
    expect(config.previewQuality).toBe('card');
    expect(preview.qualityPresets.card).toMatchObject({ encoders: ['libx264'], width: 640 });
    process.env.PREVIEW_QUALITY = 'high';
    expect(preview.getConfig().previewQuality).toBe('high');
  });

  test('writes to a temp file and renames it into place', async () => {
    ffmpeg.runFfmpeg.mockImplementation(async (args) => {
      expect(outputOf(args)).toMatch(/_0s\.mp4\.partial-\d+-\d+$/);
      expect(args).toEqual(expect.arrayContaining(['-vf', "scale=w='min(640,iw)':h=-2", '-c:v', 'libx264']));
      fs.writeFileSync(outputOf(args), 'video-bytes');
    });

    const result = await preview.queuePreviewGeneration('/videos/a.mp4', 1, 60);

    expect(result.status).toBe('completed');
    const finalPath = preview.getPreviewPathForVideo('/videos/a.mp4');
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('video-bytes');
    expect(result.previewInfo.clips[0]).toMatchObject({ timestamp: 0, duration: 2, path: `/previews/${path.basename(finalPath)}`, size: 11 });
    expect(fs.readdirSync(tmp)).toEqual([path.basename(finalPath)]);
  });

  test('zero-byte output is a failure and leaves no file behind', async () => {
    ffmpeg.runFfmpeg.mockImplementation(async (args) => {
      fs.writeFileSync(outputOf(args), '');
    });
    const result = await preview.queuePreviewGeneration('/videos/empty.mp4', 2, 60);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/empty/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test('ffmpeg failure removes the partial file and falls back to the next encoder', async () => {
    process.env.PREVIEW_QUALITY = 'high';
    const encoders = [];
    ffmpeg.runFfmpeg.mockImplementation(async (args) => {
      const encoder = args[args.indexOf('-c:v') + 1];
      encoders.push(encoder);
      fs.writeFileSync(outputOf(args), 'partial');
      if (encoder === 'libsvtav1') {
        throw new Error('encoder exploded');
      }
    });
    const result = await preview.queuePreviewGeneration('/videos/b.mp4', 3, 60);
    expect(encoders).toEqual(['libsvtav1', 'libx264']);
    expect(result.status).toBe('completed');
    expect(fs.readdirSync(tmp)).toEqual([path.basename(preview.getPreviewPathForVideo('/videos/b.mp4'))]);
  });

  test('an existing empty clip is not treated as done', async () => {
    fs.writeFileSync(preview.getPreviewPathForVideo('/videos/c.mp4'), '');
    ffmpeg.runFfmpeg.mockImplementation(async (args) => fs.writeFileSync(outputOf(args), 'ok'));
    const result = await preview.queuePreviewGeneration('/videos/c.mp4', 4, 60);
    expect(ffmpeg.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(result.previewInfo.clips[0].size).toBe(2);
  });

  test('de-duplicates by video path', async () => {
    const gate = deferred();
    ffmpeg.runFfmpeg.mockImplementation(async (args) => {
      if (ffmpeg.runFfmpeg.mock.calls.length === 1) {
        await gate.promise; // occupy the single slot
      }
      fs.writeFileSync(outputOf(args), 'new');
    });

    const first = preview.queuePreviewGeneration('/videos/d.mp4', 5, 60);
    const duplicate = preview.queuePreviewGeneration('/videos/d.mp4', 5, 60);
    const other = preview.queuePreviewGeneration('/videos/e.mp4', 6, 60);
    const duplicateWaiting = preview.queuePreviewGeneration('/videos/e.mp4', 6, 60);

    expect(duplicate).toBe(first);
    expect(duplicateWaiting).toBe(other);
    expect(preview.isPreviewQueued('/videos/d.mp4')).toBe(true);
    expect(preview.getQueueStats()).toEqual({ active: 1, waiting: 1 });

    gate.resolve();
    await Promise.all([first, other]);

    expect(ffmpeg.runFfmpeg).toHaveBeenCalledTimes(2);
    expect(preview.isPreviewQueued('/videos/d.mp4')).toBe(false);
  });

  test('respects PREVIEW_MAX_CONCURRENT', async () => {
    process.env.PREVIEW_MAX_CONCURRENT = '2';
    let active = 0;
    let maxActive = 0;
    ffmpeg.runFfmpeg.mockImplementation(async (args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      fs.writeFileSync(outputOf(args), 'x');
      active -= 1;
    });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((name, index) => preview.queuePreviewGeneration(`/videos/${name}.mp4`, index, 60)));
    expect(maxActive).toBe(2);
  });

  test('videos too short are skipped without running ffmpeg', async () => {
    const result = await preview.queuePreviewGeneration('/videos/short.mp4', 7, 2);
    expect(result.status).toBe('skipped');
    expect(ffmpeg.runFfmpeg).not.toHaveBeenCalled();
  });

  test('stop() cancels waiting jobs and later requests', async () => {
    const gate = deferred();
    const started = deferred();
    ffmpeg.runFfmpeg.mockImplementation(async () => {
      started.resolve();
      return gate.promise;
    });
    const running = preview.queuePreviewGeneration('/videos/r.mp4', 8, 60);
    const waiting = preview.queuePreviewGeneration('/videos/w.mp4', 9, 60);
    await started.promise;
    preview.stop();
    await expect(waiting).resolves.toEqual({ status: 'cancelled' });
    await expect(preview.queuePreviewGeneration('/videos/x.mp4', 10, 60)).resolves.toEqual({ status: 'cancelled' });
    const killed = new Error('killed'); killed.shutdown = true;
    gate.reject(killed);
    await expect(running).resolves.toEqual({ status: 'cancelled' });
  });
});

describe('ffmpeg process handling (real child processes)', () => {
  const actual = jest.requireActual('../../lib/ffmpeg');
  let tmp;
  let savedPath;
  let savedTimeout;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-ffmpeg-'));
    savedPath = process.env.FFMPEG_PATH;
    savedTimeout = process.env.PREVIEW_TIMEOUT_SECONDS;
    const fake = path.join(tmp, 'slow-ffmpeg');
    fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    process.env.FFMPEG_PATH = fake;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = savedPath;
    if (savedTimeout === undefined) delete process.env.PREVIEW_TIMEOUT_SECONDS; else process.env.PREVIEW_TIMEOUT_SECONDS = savedTimeout;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a hung ffmpeg is killed after the timeout', async () => {
    const started = Date.now();
    await expect(actual.runFfmpeg(['-i', 'x', 'y'], { timeoutMs: 300 })).rejects.toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(actual.getActiveProcessCount()).toBe(0);
  });

  test('killActiveProcesses() kills running children (shutdown)', async () => {
    const running = actual.runFfmpeg(['-i', 'x', 'y'], { timeoutMs: 60000 });
    expect(actual.getActiveProcessCount()).toBe(1);
    actual.killActiveProcesses();
    await expect(running).rejects.toMatchObject({ shutdown: true });
    expect(actual.getActiveProcessCount()).toBe(0);
  });
});
