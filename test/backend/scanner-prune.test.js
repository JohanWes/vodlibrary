// Scanner pruning safety: a missing/unmounted/unreadable library root must
// never cause the DB rows under it to be deleted.
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
  nonEmptyFileSize: jest.fn().mockResolvedValue(0)
}));
jest.mock('../../lib/preview', () => ({
  queuePreviewGeneration: jest.fn().mockResolvedValue({ status: 'skipped' }),
  isPreviewQueued: jest.fn().mockReturnValue(false),
  getPreviewFilePaths: jest.fn(() => []),
  getConfig: jest.fn(() => ({ previewDir: '/nonexistent-previews' })),
  stop: jest.fn()
}));

const database = require('../../db/database');

const { scanLibrary, getScanStatus } = require('../../lib/scanner');

function setRows(rows) {
  const full = rows.map((row) => ({
    title: path.basename(row.path),
    duration: 120,
    width: 1920,
    height: 1080,
    thumbnail_path: '/thumbnails/x.jpg',
    death_timestamps: null,
    preview_clips: null,
    preview_generation_status: 'completed',
    metadata_mtime: 'none',
    preview_attempts: 0,
    preview_source_mtime: null,
    ...row
  }));
  database.getVideosForScan.mockResolvedValue(full);
  database.getVideoScanStateByPath.mockImplementation(async (_db, p) => full.find((row) => row.path === p));
}

describe('scanLibrary pruning safety', () => {
  let tmp;
  let previousLibrary;
  let previousPreviews;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-prune-'));
    previousLibrary = process.env.VIDEO_LIBRARY;
    previousPreviews = process.env.ENABLE_PREVIEWS;
    process.env.ENABLE_PREVIEWS = 'false';
    jest.clearAllMocks();
    database.updateVideoFields.mockResolvedValue(1);
    database.deleteVideo.mockResolvedValue(1);
    database.addVideo.mockResolvedValue(99);
  });

  afterEach(() => {
    process.env.VIDEO_LIBRARY = previousLibrary;
    if (previousPreviews === undefined) delete process.env.ENABLE_PREVIEWS;
    else process.env.ENABLE_PREVIEWS = previousPreviews;
    try { fs.chmodSync(path.join(tmp, 'rootA', 'locked'), 0o755); } catch (_e) { /* not created */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeRootA() {
    const rootA = path.join(tmp, 'rootA');
    fs.mkdirSync(rootA);
    fs.writeFileSync(path.join(rootA, 'a.mp4'), 'x');
    return rootA;
  }

  test('does not prune rows under a missing root, prunes vanished files under a scanned root', async () => {
    const rootA = makeRootA();
    const rootB = path.join(tmp, 'unmounted', 'Warcraft Recorder');
    process.env.VIDEO_LIBRARY = `${rootA}/,${rootB}/`;
    setRows([
      { id: 1, path: path.join(rootA, 'a.mp4') },
      { id: 2, path: path.join(rootA, 'gone.mp4') },
      { id: 3, path: path.join(rootB, 'b.mp4') },
      { id: 4, path: path.join(rootB, 'sub', 'c.mp4') }
    ]);

    await scanLibrary({});

    const deletedIds = database.deleteVideo.mock.calls.map((call) => call[1]);
    expect(deletedIds).toEqual([2]);
    expect(getScanStatus().status).toBe('completed');
    expect(getScanStatus().removedCount).toBe(1);
  });

  test('prunes nothing when every root is missing', async () => {
    const rootB = path.join(tmp, 'missing');
    process.env.VIDEO_LIBRARY = rootB;
    setRows([{ id: 3, path: path.join(rootB, 'b.mp4') }]);

    await scanLibrary({});

    expect(database.deleteVideo).not.toHaveBeenCalled();
    expect(getScanStatus().removedCount).toBe(0);
  });

  test('treats an existing but empty root with known rows as unmounted', async () => {
    const mountPoint = path.join(tmp, 'mnt');
    fs.mkdirSync(mountPoint);
    process.env.VIDEO_LIBRARY = mountPoint;
    setRows([{ id: 5, path: path.join(mountPoint, 'v.mp4') }]);

    await scanLibrary({});

    expect(database.deleteVideo).not.toHaveBeenCalled();
  });

  test('a broken symlink does not abort the scan', async () => {
    const rootA = makeRootA();
    fs.symlinkSync(path.join(tmp, 'does-not-exist.mp4'), path.join(rootA, 'broken.mp4'));
    fs.symlinkSync(path.join(tmp, 'does-not-exist-dir'), path.join(rootA, 'broken-dir'));
    process.env.VIDEO_LIBRARY = rootA;
    setRows([
      { id: 1, path: path.join(rootA, 'a.mp4') },
      { id: 2, path: path.join(rootA, 'gone.mp4') },
      { id: 7, path: path.join(rootA, 'broken.mp4') }, // target on a drive that is gone
      { id: 8, path: path.join(rootA, 'broken-dir', 'x.mp4') }
    ]);

    await scanLibrary({});

    expect(getScanStatus().status).toBe('completed');
    expect(database.deleteVideo.mock.calls.map((call) => call[1])).toEqual([2]);
  });

  test('rows stored under a second symlink to an already-walked directory are kept', async () => {
    const rootA = makeRootA();
    const recordings = path.join(tmp, 'recordings');
    fs.mkdirSync(recordings);
    fs.writeFileSync(path.join(recordings, 'r.mp4'), 'x');
    fs.symlinkSync(recordings, path.join(rootA, 'A'));
    fs.symlinkSync(recordings, path.join(rootA, 'B'));
    process.env.VIDEO_LIBRARY = rootA;
    setRows([
      { id: 1, path: path.join(rootA, 'a.mp4') },
      { id: 2, path: path.join(rootA, 'A', 'r.mp4') },
      { id: 3, path: path.join(rootA, 'B', 'r.mp4') }, // indexed by the old scanner via the alias
      { id: 4, path: path.join(rootA, 'gone.mp4') }
    ]);

    await scanLibrary({});

    expect(getScanStatus().status).toBe('completed');
    expect(database.deleteVideo.mock.calls.map((call) => call[1])).toEqual([4]);
  });

  test('rows under an unreadable subdirectory are kept', async () => {
    if (process.getuid && process.getuid() === 0) {
      return; // root can read everything; nothing to test
    }
    const rootA = makeRootA();
    const locked = path.join(rootA, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.mp4'), 'x');
    fs.chmodSync(locked, 0o000);
    process.env.VIDEO_LIBRARY = rootA;
    setRows([
      { id: 1, path: path.join(rootA, 'a.mp4') },
      { id: 6, path: path.join(locked, 'hidden.mp4') }
    ]);

    await scanLibrary({});

    expect(getScanStatus().status).toBe('completed');
    expect(database.deleteVideo).not.toHaveBeenCalled();
  });
});
