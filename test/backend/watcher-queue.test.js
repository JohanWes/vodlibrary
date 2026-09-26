const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const database = require('../../db/database');
const watcher = require('../../lib/watcher');

describe('watcher queue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('coalesces rapid events for the same path', async () => {
    const queue = watcher.createWatcherQueue({ concurrency: 1, debounceMs: 10 });
    const events = [];
    queue.schedule('/tmp/file.mp4', async () => events.push('first'));
    queue.schedule('/tmp/file.mp4', async () => events.push('second'));

    jest.advanceTimersByTime(10);
    await queue.idle();

    expect(events).toEqual(['second']);
  });

  test('limits concurrent task execution', async () => {
    const queue = watcher.createWatcherQueue({ concurrency: 1, debounceMs: 0 });
    let active = 0;
    let maxActive = 0;
    const done = [];
    const task = (name) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      done.push(name);
    };
    queue.schedule('/tmp/a.mp4', task('a'));
    queue.schedule('/tmp/b.mp4', task('b'));
    queue.schedule('/tmp/c.mp4', task('c'));

    jest.advanceTimersByTime(0);
    await queue.idle();

    expect(done).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
  });

  test('shutdown clears pending timers and later schedules are ignored', async () => {
    const queue = watcher.createWatcherQueue({ concurrency: 1, debounceMs: 10 });
    const task = jest.fn();
    queue.schedule('/tmp/x.mp4', task);
    queue.shutdown();
    queue.schedule('/tmp/y.mp4', task);

    jest.runAllTimers();
    await queue.idle();

    expect(task).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('isIgnoredByWatcher', () => {
  const fileStats = { isFile: () => true };
  test.each([
    ['/lib/.Trash-1000', undefined, true],
    ['/lib/run.mp4', fileStats, false],
    ['/lib/run.json', fileStats, false],
    ['/lib/run.txt', fileStats, true],
    ['/lib/sub', undefined, false],
    ['/home/u/.hidden-root/run.mp4', fileStats, false]
  ])('%s (ignored: %#)', (filePath, stats, expected) => {
    expect(watcher.isIgnoredByWatcher(filePath, stats)).toBe(expected);
  });
});

describe('removeVideoFile unmount guard', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-unmount-'));
    jest.clearAllMocks();
    database.deleteVideo.mockResolvedValue(1);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ignores an unlink under an empty mount point', async () => {
    const video = path.join(root, 'gone.mp4');
    database.getVideoScanStateByPath.mockResolvedValue({ id: 9, path: video });
    await expect(watcher.removeVideoFile({}, video, [root])).resolves.toBeNull();
    expect(database.deleteVideo).not.toHaveBeenCalled();
  });

  test('stray entries on a bare mount point (lost+found, dot files) do not count as mounted', async () => {
    fs.mkdirSync(path.join(root, 'lost+found'));
    fs.mkdirSync(path.join(root, '.Trash-1000'));
    fs.writeFileSync(path.join(root, '.keep'), '');
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    const video = path.join(root, 'Warcraft', 'gone.mp4');
    database.getVideoScanStateByPath.mockResolvedValue({ id: 9, path: video });

    await expect(watcher.removeVideoFile({}, video, [root])).resolves.toBeNull();
    expect(database.deleteVideo).not.toHaveBeenCalled();
  });

  test('deletes the row when the root still holds other videos', async () => {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'other.mkv'), 'x');
    const video = path.join(root, 'gone.mp4');
    database.getVideoScanStateByPath.mockResolvedValue({ id: 9, path: video, preview_clips: null });

    await expect(watcher.removeVideoFile({}, video, [root])).resolves.toBe(9);
    expect(database.deleteVideo).toHaveBeenCalledWith({}, 9);
  });
});

const ffmpegAvailable = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
})();

(ffmpegAvailable ? describe : describe.skip)('startLibraryWatcher (real chokidar + ffmpeg in tmpdir)', () => {
  let tmp;
  let root;
  let handle;
  const saved = {};

  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('condition not met in time');
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-watch-'));
    root = path.join(tmp, 'library');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'keep.mp4'), 'x'); // the root must keep a video to count as mounted
    for (const key of ['THUMBNAIL_CACHE_DIR', 'ENABLE_PREVIEWS']) saved[key] = process.env[key];
    process.env.THUMBNAIL_CACHE_DIR = path.join(tmp, 'thumbs');
    process.env.ENABLE_PREVIEWS = 'false';
    jest.clearAllMocks();
    database.getVideoScanStateByPath.mockResolvedValue(undefined);
    database.addVideo.mockResolvedValue(42);
    database.updateVideoFields.mockResolvedValue(1);
    database.deleteVideo.mockResolvedValue(1);
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('adds new videos, refreshes sidecars, removes deleted videos, then closes', async () => {
    const onAdd = jest.fn();
    const onDelete = jest.fn();
    handle = watcher.startLibraryWatcher({}, { roots: [root], onAdd, onDelete, debounceMs: 10, stabilityThresholdMs: 200 });
    await new Promise((resolve) => handle.watcher.on('ready', resolve));

    const video = path.join(root, 'clip.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', video]);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'ignored');

    await waitFor(() => onAdd.mock.calls.length > 0);
    expect(onAdd).toHaveBeenCalledWith(video, 42);
    expect(database.addVideo).toHaveBeenCalledTimes(1);
    expect(database.addVideo.mock.calls[0][1]).toMatchObject({ path: video, width: 320, height: 240 });

    // Sidecar written after the video: metadata refreshed without a rescan.
    const row = { id: 42, path: video, metadata_mtime: 'none', preview_clips: null };
    database.getVideoScanStateByPath.mockResolvedValue(row);
    database.updateVideoFields.mockClear();
    fs.writeFileSync(path.join(root, 'clip.json'), JSON.stringify({ schema_version: 1, duration_ms: 1000, timeline: [{ kind: 'death', start_ms: 500, label: 'X' }] }));
    await waitFor(() => database.updateVideoFields.mock.calls.some((call) => call[2].death_timestamps === '[0.5]'));

    fs.unlinkSync(video);
    await waitFor(() => onDelete.mock.calls.length > 0);
    expect(database.deleteVideo).toHaveBeenCalledWith({}, 42);
    expect(onDelete).toHaveBeenCalledWith(42, video);

    await handle.close();
    expect(handle.watcher.closed).toBe(true);
    handle = null;
  }, 20000);
});
