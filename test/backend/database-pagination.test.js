/**
 * db/database.js against a real SQLite database (in-memory or a temp file).
 */
jest.unmock('../../db/database');

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const database = require('../../db/database');

const {
  initializeDatabase,
  closeDatabase,
  addVideo,
  getVideoById,
  getVideosPaginated,
  getVideosByIds,
  getVideosWithMetadata,
  getVideoScanStateByPath,
  updateVideoFields
} = database;

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function rowByPath(db, videoPath) {
  return (await query(db, 'SELECT * FROM videos WHERE path = ?', [videoPath]))[0];
}

function video(overrides) {
  return {
    title: 'Video',
    path: `/library/${overrides.title || 'video'}.mp4`,
    duration: 60,
    width: 1920,
    height: 1080,
    thumbnail_path: null,
    added_date: '2026-01-01T00:00:00.000Z',
    death_timestamps: null,
    metadata: JSON.stringify({ big: 'x'.repeat(1000) }),
    ...overrides
  };
}

describe('db/database.js on real SQLite', () => {
  let db;

  beforeEach(async () => {
    db = await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  test('exports no dead helpers', () => {
    for (const name of ['getAllVideos', 'getVideoByPath', 'updateVideo', 'getAllVideoPaths', 'updateVideoThumbnail', 'updateVideoPreview', 'ensureScannerColumns']) {
      expect(database[name]).toBeUndefined();
    }
  });

  test('getVideosWithMetadata skips NULL and empty metadata', async () => {
    await addVideo(db, video({ title: 'with' }));
    await addVideo(db, video({ title: 'null', metadata: null }));
    await addVideo(db, video({ title: 'empty', metadata: '' }));
    expect((await getVideosWithMetadata(db)).map((row) => row.title)).toEqual(['with']);
  });

  test.each([
    ['recorded_desc', ['c', 'b2', 'b1', 'a']],
    ['recorded_asc', ['a', 'b1', 'b2', 'c']],
    ['title_asc', ['a', 'b1', 'b2', 'c']],
    ['title_desc', ['c', 'b2', 'b1', 'a']],
    ['not-a-sort; DROP TABLE videos', ['c', 'b2', 'b1', 'a']]
  ])('sort %s is stable across pages (id breaks ties)', async (sort, expected) => {
    await addVideo(db, video({ title: 'a', added_date: '2026-01-01' }));
    await addVideo(db, video({ title: 'b1', added_date: '2026-01-02' }));
    await addVideo(db, video({ title: 'b2', added_date: '2026-01-02' }));
    await addVideo(db, video({ title: 'c', added_date: '2026-01-03' }));
    if (sort.startsWith('title')) {
      // Same title (case-insensitively) for the tie pair.
      await query(db, "UPDATE videos SET title = 'B' WHERE title = 'b1'");
      await query(db, "UPDATE videos SET title = 'b' WHERE title = 'b2'");
    }

    const pages = [];
    for (let page = 1; page <= 4; page += 1) {
      const result = await getVideosPaginated(db, page, 1, null, sort);
      expect(result.totalCount).toBe(4);
      pages.push(...result.videos.map((row) => row.id));
    }
    const titleById = { 1: 'a', 2: 'b1', 3: 'b2', 4: 'c' };
    expect(pages.map((id) => titleById[id])).toEqual(expected);
    expect((await query(db, 'SELECT COUNT(*) AS n FROM videos'))[0].n).toBe(4);
  });

  test('search filters both the page and the total, case-insensitively', async () => {
    await addVideo(db, video({ title: 'Mythic M+ run' }));
    await addVideo(db, video({ title: 'another m+ RUN' }));
    await addVideo(db, video({ title: 'raid' }));

    const result = await getVideosPaginated(db, 1, 1, 'm+ run', 'title_asc');
    expect(result.totalCount).toBe(2);
    expect(result.videos.map((row) => row.title)).toEqual(['another m+ RUN']);
  });

  test('search treats %, _ and \\ literally, still case-insensitive substring', async () => {
    for (const title of ['boss_kill', 'BOSS KILL', '100% run', 'plain', 'C:\\path']) {
      await addVideo(db, video({ title }));
    }
    const titles = async (term) =>
      (await getVideosPaginated(db, 1, 50, term, 'title_asc')).videos.map((row) => row.title);

    expect(await titles('_')).toEqual(['boss_kill']);
    expect(await titles('%')).toEqual(['100% run']);
    expect(await titles('\\')).toEqual(['C:\\path']);
    expect((await getVideosPaginated(db, 1, 50, '_', 'title_asc')).totalCount).toBe(1);
    expect(await titles('BOSS')).toEqual(['BOSS KILL', 'boss_kill']);
    expect(await titles('ss_K')).toEqual(['boss_kill']);
  });

  test('addVideo on an existing path keeps the id and only refreshes file-derived columns', async () => {
    const id = await addVideo(db, video({
      title: 'orig',
      path: '/library/same.mp4',
      added_date: '2026-01-01T00:00:00.000Z',
      death_timestamps: '[1.5]',
      metadata: '{"slim":1}',
      metadata_mtime: '1:2'
    }));
    await updateVideoFields(db, id, {
      thumbnail_path: '/thumbnails/same.jpg',
      preview_clips: '{"clips":[{"timestamp":0}]}',
      preview_generation_status: 'completed',
      preview_generation_date: '2026-01-05',
      preview_attempts: 1,
      preview_source_mtime: 123
    });
    await addVideo(db, video({ title: 'other', path: '/library/other.mp4' }));

    const again = await addVideo(db, video({
      title: 'renamed',
      path: '/library/same.mp4',
      duration: 99,
      width: 1280,
      height: 720,
      added_date: '2030-01-01T00:00:00.000Z',
      death_timestamps: null,
      metadata: null,
      metadata_mtime: null
    }));

    expect(again).toBe(id);
    expect(await rowByPath(db, '/library/same.mp4')).toMatchObject({
      id,
      title: 'renamed',
      duration: 99,
      width: 1280,
      height: 720,
      added_date: '2026-01-01T00:00:00.000Z',
      death_timestamps: '[1.5]',
      metadata: '{"slim":1}',
      metadata_mtime: '1:2',
      thumbnail_path: '/thumbnails/same.jpg',
      preview_clips: '{"clips":[{"timestamp":0}]}',
      preview_generation_status: 'completed',
      preview_generation_date: '2026-01-05',
      preview_attempts: 1,
      preview_source_mtime: 123
    });
    expect((await query(db, 'SELECT COUNT(*) AS n FROM videos'))[0].n).toBe(2);

    await addVideo(db, video({ path: '/library/same.mp4', thumbnail_path: '/thumbnails/new.jpg' }));
    expect((await rowByPath(db, '/library/same.mp4')).thumbnail_path).toBe('/thumbnails/new.jpg');
  });

  test('addVideo stores the sidecar signature with a new row', async () => {
    await addVideo(db, video({ title: 'sig', metadata_mtime: '10:20' }));
    expect((await getVideoScanStateByPath(db, '/library/sig.mp4')).metadata_mtime).toBe('10:20');
  });

  test('addVideo returns the new id for a new path', async () => {
    const first = await addVideo(db, video({ title: 'one' }));
    const second = await addVideo(db, video({ title: 'two' }));
    expect(second).toBe(first + 1);
  });

  test('getVideosByIds skips the database for an empty page', async () => {
    const fakeDb = { all: jest.fn() };
    await expect(getVideosByIds(fakeDb, [])).resolves.toEqual([]);
    expect(fakeDb.all).not.toHaveBeenCalled();
  });
});

describe('initializeDatabase on a file', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-db-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('enables WAL, synchronous=NORMAL and a busy timeout', async () => {
    const db = await initializeDatabase(path.join(tmpDir, 'videos.db'));
    try {
      expect((await query(db, 'PRAGMA journal_mode'))[0].journal_mode).toBe('wal');
      expect((await query(db, 'PRAGMA synchronous'))[0].synchronous).toBe(1);
      expect((await query(db, 'PRAGMA busy_timeout'))[0].timeout).toBe(5000);
    } finally {
      await closeDatabase(db);
    }
  });

  test('migrates the original schema, keeping rows', async () => {
    const file = path.join(tmpDir, 'legacy.db');
    const legacy = new sqlite3.Database(file);
    // The first committed schema; `path` has been UNIQUE since then.
    await new Promise((resolve, reject) => legacy.exec(`
      CREATE TABLE videos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        duration INTEGER, added_date TEXT DEFAULT CURRENT_TIMESTAMP, thumbnail_path TEXT, death_timestamps TEXT);
      INSERT INTO videos (title, path, duration, added_date) VALUES ('old', '/library/old.mp4', 5, '2020');
    `, (err) => (err ? reject(err) : resolve())));
    await new Promise((resolve) => legacy.close(resolve));

    const db = await initializeDatabase(file);
    try {
      const columns = (await query(db, 'PRAGMA table_info(videos)')).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining([
        'death_timestamps', 'width', 'height', 'preview_clips', 'preview_generation_status', 'preview_generation_date', 'metadata',
        'metadata_mtime', 'preview_attempts', 'preview_source_mtime'
      ]));

      const id = await addVideo(db, video({ title: 'new title', path: '/library/old.mp4' }));
      expect(id).toBe(1);
      expect(await getVideoById(db, 1)).toMatchObject({ title: 'new title', added_date: '2020' });
    } finally {
      await closeDatabase(db);
    }

    // Re-running the migrations is a no-op.
    const reopened = await initializeDatabase(file);
    await closeDatabase(reopened);
  });
});
