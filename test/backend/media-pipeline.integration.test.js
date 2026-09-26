// End-to-end: real SQLite (:memory:), real ffmpeg/ffprobe, everything in a
// tmpdir. Proves card-sized thumbnails, temp+rename preview clips, sidecar
// parsing for both formats, no re-parse on rescans and media removal for
// deleted videos.
jest.unmock('../../db/database');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ffmpegAvailable = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-e2e-'));
const root = path.join(tmp, 'library');
const thumbs = path.join(tmp, 'thumbs');
const previews = path.join(tmp, 'previews');
const saved = {};
for (const key of ['VIDEO_LIBRARY', 'THUMBNAIL_CACHE_DIR', 'PREVIEWS_CACHE_DIR', 'PREVIEW_DURATION', 'PREVIEW_QUALITY', 'ENABLE_PREVIEWS', 'PREVIEW_MAX_CONCURRENT']) {
  saved[key] = process.env[key];
}
Object.assign(process.env, {
  VIDEO_LIBRARY: root,
  THUMBNAIL_CACHE_DIR: thumbs,
  PREVIEWS_CACHE_DIR: previews,
  PREVIEW_DURATION: '2',
  ENABLE_PREVIEWS: 'true',
  PREVIEW_MAX_CONCURRENT: '2'
});
delete process.env.PREVIEW_QUALITY;

const { initializeDatabase, closeDatabase } = require('../../db/database');
const scanner = require('../../lib/scanner');
const preview = require('../../lib/preview');
const { generateVideoHash } = require('../../lib/thumbnail');
const { ffprobe } = require('../../lib/ffmpeg');

async function imageSize(file) {
  const { streams } = await ffprobe(file);
  return { width: streams[0].width, height: streams[0].height };
}

function makeVideo(file, size, seconds = 4) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=10`, '-pix_fmt', 'yuv420p', file]);
}

function allRows(db) {
  return new Promise((resolve, reject) => db.all('SELECT * FROM videos ORDER BY path', (err, rows) => (err ? reject(err) : resolve(rows))));
}

async function waitForPreviews(db) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const rows = await allRows(db);
    const stats = preview.getQueueStats();
    if (stats.active === 0 && stats.waiting === 0 && rows.every((row) => row.preview_generation_status !== 'generating')) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('previews did not finish');
}

(ffmpegAvailable ? describe : describe.skip)('media pipeline (real ffmpeg, tmpdir)', () => {
  let db;
  const wide = path.join(root, 'wide run.mp4');
  const small = path.join(root, 'sub', 'small.mp4');

  beforeAll(async () => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    makeVideo(wide, '1280x720');
    makeVideo(small, '320x240');
    fs.writeFileSync(path.join(root, 'wide run.json'), JSON.stringify({
      category: 'Mythic+', zoneID: 2441, keystoneLevel: 10, start: 1757626649000, duration: 4,
      deaths: [{ name: 'A', timestamp: 1.5 }, { name: 'B', timestamp: 3.25 }], combatants: [{ _name: 'A' }]
    }));
    fs.writeFileSync(path.join(root, 'sub', 'small.json'), JSON.stringify({
      schema_version: 1, start_unix_ms: 1790160663350, duration_ms: 4000, combatants: [],
      timeline: [{ kind: 'bloodlust', start_ms: 0 }, { kind: 'death', start_ms: 2500, label: 'C' }],
      meter: { fights: [{ actors: new Array(1000).fill({ damage: 12345 }) }] }
    }));
    db = await initializeDatabase(':memory:');
  }, 30000);

  afterAll(async () => {
    await scanner.stopMediaPipeline();
    if (db) await closeDatabase(db);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('first scan: rows, card-sized thumbnails, previews via temp+rename, sidecars', async () => {
    const renameSpy = jest.spyOn(fs.promises, 'rename');
    await scanner.scanLibrary(db);
    expect(scanner.getScanStatus()).toMatchObject({ status: 'completed', newCount: 2, removedCount: 0 });

    const rows = await waitForPreviews(db);
    expect(rows.map((row) => row.path)).toEqual([small, wide]);

    for (const row of rows) {
      const thumbFile = path.join(thumbs, `${generateVideoHash(row.path)}.jpg`);
      expect(row.thumbnail_path).toBe(`/thumbnails/${generateVideoHash(row.path)}.jpg`);
      const size = await imageSize(thumbFile);
      expect(size.width).toBeLessThanOrEqual(640);
      expect(size.width).toBe(row.path === wide ? 640 : 320); // scaled down, never up
      expect(size.height).toBe(row.path === wide ? 360 : 240);

      expect(row.preview_generation_status).toBe('completed');
      const info = JSON.parse(row.preview_clips);
      const clipFile = path.join(previews, path.basename(info.clips[0].path));
      expect(fs.statSync(clipFile).size).toBe(info.clips[0].size);
      expect(info.clips[0].size).toBeGreaterThan(0);
      const probe = await ffprobe(clipFile);
      const stream = probe.streams.find((candidate) => candidate.codec_type === 'video');
      expect(stream.codec_name).toBe('h264');
      expect(stream.width).toBe(row.path === wide ? 640 : 320);
      expect(Number(probe.format.duration)).toBeLessThanOrEqual(2.2);
    }

    // Every preview/thumbnail landed via rename from a .partial temp file.
    const renames = renameSpy.mock.calls.map(([from, to]) => [path.basename(from), path.basename(to)]);
    expect(renames.filter(([from, to]) => /_0s\.mp4\.partial-\d+-\d+$/.test(from) && to.endsWith('_0s.mp4'))).toHaveLength(2);
    expect(renames.filter(([from, to]) => /\.jpg\.partial-\d+-\d+$/.test(from) && to.endsWith('.jpg'))).toHaveLength(2);
    expect(fs.readdirSync(previews).filter((name) => name.includes('.partial-'))).toEqual([]);
    expect(fs.readdirSync(thumbs).filter((name) => name.includes('.partial-'))).toEqual([]);
    renameSpy.mockRestore();

    const wideRow = rows.find((row) => row.path === wide);
    const smallRow = rows.find((row) => row.path === small);
    expect(JSON.parse(wideRow.death_timestamps)).toEqual([1.5, 3.25]);
    expect(JSON.parse(smallRow.death_timestamps)).toEqual([2.5]);
    expect(JSON.parse(smallRow.metadata)).toEqual({ slim: 1, start: 1790160663350, duration: 4, deaths: [{ name: 'C', timestamp: 2.5 }] });
    expect(wideRow.metadata_mtime).toMatch(/^\d+:\d+$/);
  }, 60000);

  test('rescan: no sidecar re-parse, no updates; zero-byte clip is regenerated', async () => {
    const before = await allRows(db);
    const wideRow = before.find((row) => row.path === wide);
    const clipFile = path.join(previews, path.basename(JSON.parse(wideRow.preview_clips).clips[0].path));
    fs.truncateSync(clipFile, 0);

    const readSpy = jest.spyOn(fs.promises, 'readFile');
    await scanner.scanLibrary(db);
    expect(readSpy.mock.calls.filter(([file]) => String(file).endsWith('.json'))).toHaveLength(0);
    readSpy.mockRestore();
    expect(scanner.getScanStatus()).toMatchObject({ status: 'completed', newCount: 0, updatedCount: 0, removedCount: 0 });

    const after = await waitForPreviews(db);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id)); // ids stable
    expect(fs.statSync(clipFile).size).toBeGreaterThan(0);
    expect(JSON.parse(after.find((row) => row.path === wide).preview_clips).clips[0].size).toBe(fs.statSync(clipFile).size);
  }, 60000);

  test('a deleted video loses its row, thumbnail and preview; a missing root keeps its rows', async () => {
    fs.unlinkSync(small);
    await scanner.scanLibrary(db);
    expect(scanner.getScanStatus()).toMatchObject({ status: 'completed', removedCount: 1 });
    expect((await allRows(db)).map((row) => row.path)).toEqual([wide]);
    expect(fs.existsSync(path.join(thumbs, `${generateVideoHash(small)}.jpg`))).toBe(false);
    expect(fs.existsSync(path.join(previews, `${generateVideoHash(small)}_0s.mp4`))).toBe(false);

    // Simulate the drive disappearing.
    fs.renameSync(root, `${root}-unmounted`);
    await scanner.scanLibrary(db);
    expect(scanner.getScanStatus()).toMatchObject({ status: 'completed', removedCount: 0 });
    expect((await allRows(db)).map((row) => row.path)).toEqual([wide]);
    fs.renameSync(`${root}-unmounted`, root);
  }, 60000);
});
