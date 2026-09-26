// When the scanner (re)queues preview generation, and how outcomes are
// recorded. DB errors while recording must not become unhandled rejections.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../lib/thumbnail', () => ({
  generateThumbnail: jest.fn().mockResolvedValue('/thumbnails/x.jpg'),
  thumbnailExists: jest.fn().mockReturnValue(true),
  getThumbnailPath: jest.fn().mockReturnValue('/thumbnails/x.jpg'),
  getThumbnailFilePath: jest.fn(() => '/nonexistent-thumbs/x.jpg')
}));
jest.mock('../../lib/ffmpeg', () => ({
  probeVideo: jest.fn().mockResolvedValue({ duration: 120, width: 1920, height: 1080 }),
  nonEmptyFileSize: jest.requireActual('../../lib/ffmpeg').nonEmptyFileSize
}));
jest.mock('../../lib/preview', () => ({
  queuePreviewGeneration: jest.fn(),
  isPreviewQueued: jest.fn().mockReturnValue(false),
  getPreviewFilePaths: jest.fn(() => []),
  getConfig: jest.fn(),
  stop: jest.fn()
}));

const database = require('../../db/database');
const preview = require('../../lib/preview');
const { scanLibrary } = require('../../lib/scanner');

// A scheduled job records 'generating' before the scan returns; its outcome
// is the next update with any other status.
const scheduled = () => database.updateVideoFields.mock.calls.some((call) => call[2].preview_generation_status === 'generating');
const outcome = () => new Promise((resolve) => {
  database.updateVideoFields.mockImplementation(async (_db, _id, fields) => {
    if (fields.preview_generation_status !== 'generating') resolve(fields);
    return 1;
  });
});

describe('scanner preview scheduling', () => {
  let tmp;
  let clipDir;
  let video;
  let mtime;
  const saved = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-policy-'));
    clipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-policy-clips-'));
    video = path.join(tmp, 'v.mp4');
    fs.writeFileSync(video, 'x');
    mtime = Math.trunc(fs.statSync(video).mtimeMs);
    for (const key of ['VIDEO_LIBRARY', 'ENABLE_PREVIEWS', 'PREVIEW_MAX_ATTEMPTS']) saved[key] = process.env[key];
    process.env.VIDEO_LIBRARY = tmp;
    delete process.env.ENABLE_PREVIEWS;
    delete process.env.PREVIEW_MAX_ATTEMPTS;
    jest.clearAllMocks();
    preview.getConfig.mockReturnValue({ previewDir: clipDir });
    preview.queuePreviewGeneration.mockResolvedValue({ status: 'completed', previewInfo: { clips: [{ timestamp: 0, path: '/previews/p.mp4', size: 5 }], total_size: 5 } });
    database.updateVideoFields.mockResolvedValue(1);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(clipDir, { recursive: true, force: true });
  });

  function row(overrides) {
    return {
      id: 1, title: 'v', path: video, duration: 120, width: 1920, height: 1080,
      thumbnail_path: '/thumbnails/x.jpg', death_timestamps: null, metadata_mtime: 'none',
      preview_clips: null, preview_generation_status: null, preview_attempts: 0, preview_source_mtime: null,
      ...overrides
    };
  }

  async function scanWith(state) {
    database.updateVideoFields.mockClear();
    database.getVideosForScan.mockResolvedValue([row(state)]);
    await scanLibrary({});
    return scheduled();
  }

  test('pending/null and stale generating rows are queued', async () => {
    expect(await scanWith({ preview_generation_status: null })).toBe(true);
    jest.clearAllMocks();
    expect(await scanWith({ preview_generation_status: 'generating' })).toBe(true);
  });

  test('rows already queued in this process are not queued again', async () => {
    preview.isPreviewQueued.mockReturnValueOnce(true);
    expect(await scanWith({ preview_generation_status: 'generating' })).toBe(false);
  });

  test('completed rows are only requeued when the clip is missing or empty', async () => {
    const clips = JSON.stringify({ clips: [{ timestamp: 0, path: '/previews/p.mp4', size: 5 }] });
    fs.writeFileSync(path.join(clipDir, 'p.mp4'), 'clip!');
    expect(await scanWith({ preview_generation_status: 'completed', preview_clips: clips })).toBe(false);
    fs.writeFileSync(path.join(clipDir, 'p.mp4'), '');
    expect(await scanWith({ preview_generation_status: 'completed', preview_clips: clips })).toBe(true);
  });

  test('failed rows: bounded retries, retried again only after the file changes', async () => {
    expect(await scanWith({ preview_generation_status: 'failed', preview_attempts: 1, preview_source_mtime: mtime })).toBe(true);
    jest.clearAllMocks();
    expect(await scanWith({ preview_generation_status: 'failed', preview_attempts: 2, preview_source_mtime: mtime })).toBe(false);
    expect(await scanWith({ preview_generation_status: 'failed', preview_attempts: 5, preview_source_mtime: mtime - 1000 })).toBe(true);
  });

  test('skipped (too short) rows are not retried unless the file changes', async () => {
    expect(await scanWith({ preview_generation_status: 'skipped', preview_source_mtime: mtime })).toBe(false);
    expect(await scanWith({ preview_generation_status: 'skipped', preview_source_mtime: mtime - 1000 })).toBe(true);
  });

  test('failure increments attempts and records the source mtime', async () => {
    preview.queuePreviewGeneration.mockResolvedValue({ status: 'failed', error: 'boom' });
    const final = outcome();
    await scanWith({ preview_generation_status: 'failed', preview_attempts: 1, preview_source_mtime: mtime });
    expect(await final).toMatchObject({ preview_generation_status: 'failed', preview_attempts: 2, preview_source_mtime: mtime, preview_clips: null });
  });

  test('success stores preview_clips and resets attempts', async () => {
    const final = outcome();
    await scanWith({ preview_generation_status: 'failed', preview_attempts: 1, preview_source_mtime: mtime });
    const fields = await final;
    expect(fields.preview_generation_status).toBe('completed');
    expect(JSON.parse(fields.preview_clips).clips[0].size).toBe(5);
    expect(fields.preview_attempts).toBe(0);
  });

  test('a DB error while recording the outcome is logged, not an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const logged = new Promise((resolve) => {
        console.error.mockImplementation((message) => {
          if (String(message).startsWith('Error recording preview result')) resolve();
        });
      });
      database.updateVideoFields.mockRejectedValue(new Error('SQLITE_BUSY'));
      await scanWith({ preview_generation_status: null });
      await logged;
      await new Promise((resolve) => setImmediate(resolve)); // let Node report unhandled rejections
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      console.error.mockReset();
    }
  });

  test('ENABLE_PREVIEWS=false disables scheduling', async () => {
    process.env.ENABLE_PREVIEWS = 'false';
    expect(await scanWith({ preview_generation_status: null })).toBe(false);
  });
});
