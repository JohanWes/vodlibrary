const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');
const { recordedAt } = require('../lib/video-facts');

const defaultDbDir = process.env.DB_DIR || path.join(__dirname, '..', 'data', 'db');
const defaultDbPath = path.join(defaultDbDir, 'videos.db');

// Columns added after the original schema. Applied idempotently at startup.
const MIGRATION_COLUMNS = [
  ['death_timestamps', 'TEXT'],
  ['width', 'INTEGER'],
  ['height', 'INTEGER'],
  ['preview_clips', 'TEXT'],
  ['preview_generation_status', "TEXT DEFAULT 'pending'"],
  ['preview_generation_date', 'TEXT'],
  ['metadata', 'TEXT'],
  ['metadata_mtime', 'TEXT'], // "<mtimeMs>:<size>" of the sidecar last parsed, 'none' = no sidecar
  ['preview_attempts', 'INTEGER DEFAULT 0'], // failed automatic attempts for this file version
  ['preview_source_mtime', 'INTEGER'], // video mtimeMs when the preview status was recorded
  ['recorded_at', 'TEXT'] // when the recording started (lib/video-facts.js recordedAt)
];

// The columns a video's detail view needs (`metadata` is the slim sidecar, lib/sidecar.js).
const ROW_COLUMNS = [
  'id',
  'title',
  'path',
  'duration',
  'width',
  'height',
  'added_date',
  'thumbnail_path',
  'death_timestamps',
  'preview_clips',
  'preview_generation_status',
  'preview_generation_date',
  'recorded_at',
  'metadata'
].join(', ');

// Exactly the columns lib/client-video.js toVideoCard reads.
const CARD_COLUMNS = [
  'id',
  'title',
  'duration',
  'width',
  'height',
  'added_date',
  'thumbnail_path',
  'death_timestamps',
  'preview_clips',
  'preview_generation_status',
  'recorded_at',
  'metadata'
].join(', ');

// Whitelisted ORDER BY clauses. `id` breaks ties so pagination is stable.
const ORDER_BY = {
  title_asc: 'ORDER BY title COLLATE NOCASE ASC, id ASC',
  title_desc: 'ORDER BY title COLLATE NOCASE DESC, id DESC',
  recorded_asc: 'ORDER BY recorded_at ASC, id ASC',
  recorded_desc: 'ORDER BY recorded_at DESC, id DESC',
  duration_asc: 'ORDER BY duration ASC, id ASC',
  duration_desc: 'ORDER BY duration DESC, id DESC'
};

/** @returns {Promise<number>} changed rows */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      return err ? reject(err) : resolve(this.changes);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Open the database, apply connection PRAGMAs and bring the schema up to date.
 * @param {string} [filename] - SQLite filename; defaults to $DB_DIR/videos.db.
 *   Tests pass ':memory:'.
 */
async function initializeDatabase(filename = defaultDbPath) {
  if (filename === defaultDbPath) {
    fs.mkdirSync(defaultDbDir, { recursive: true });
  }

  const db = await openDatabase(filename);
  try {
    // busy_timeout first so the WAL switch itself waits for other connections.
    await exec(db, `
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);

    await exec(db, `
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        duration INTEGER,
        width INTEGER,
        height INTEGER,
        added_date TEXT DEFAULT CURRENT_TIMESTAMP,
        thumbnail_path TEXT,
        death_timestamps TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_videos_title ON videos (title);
      CREATE INDEX IF NOT EXISTS idx_videos_added_date ON videos (added_date);
    `);

    const existingColumns = new Set((await all(db, 'PRAGMA table_info(videos)')).map((column) => column.name));
    for (const [name, type] of MIGRATION_COLUMNS) {
      if (!existingColumns.has(name)) {
        await run(db, `ALTER TABLE videos ADD COLUMN ${name} ${type}`);
      }
    }
    await exec(db, 'CREATE INDEX IF NOT EXISTS idx_videos_recorded_at ON videos (recorded_at)');
    const undated = await all(db, 'SELECT id, title, metadata, added_date FROM videos WHERE recorded_at IS NULL');
    for (const row of undated) {
      await run(db, 'UPDATE videos SET recorded_at = ? WHERE id = ?', [recordedAt(row.title, row.metadata, row.added_date), row.id]);
    }

    return db;
  } catch (error) {
    await closeDatabase(db).catch(() => {});
    throw error;
  }
}

async function getVideosPaginated(db, page = 1, limit = 50, searchQuery = null, sort = 'recorded_desc') {
  const offset = (page - 1) * limit;
  // Escape LIKE wildcards so `%` and `_` in the search term match literally.
  const where = searchQuery ? " WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE" : '';
  const whereParams = searchQuery ? [`%${String(searchQuery).replace(/[\\%_]/g, '\\$&')}%`] : [];
  const orderBy = Object.hasOwn(ORDER_BY, sort) ? ORDER_BY[sort] : ORDER_BY.recorded_desc;

  const countRow = await get(db, `SELECT COUNT(*) AS totalCount FROM videos${where}`, whereParams);
  const videos = await all(
    db,
    `SELECT ${CARD_COLUMNS} FROM videos${where} ${orderBy} LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
  return { videos, totalCount: countRow.totalCount };
}

/** One video's detail row. */
function getVideoById(db, id) {
  return get(db, `SELECT ${ROW_COLUMNS} FROM videos WHERE id = ?`, [id]);
}

/** The few columns needed to stream a video or render its watch page. */
function getVideoStreamInfo(db, id) {
  return get(db, 'SELECT id, title, path, width, height, metadata FROM videos WHERE id = ?', [id]);
}

/**
 * Insert a video. If the path already exists, keep that row and its id (share
 * links) and refresh only what is derived from the video file itself (title,
 * duration, dimensions, and the thumbnail when one is passed); the date added,
 * sidecar-derived and preview columns are left alone.
 * @returns {Promise<number>} the row id
 */
async function addVideo(db, video) {
  const { title, path: videoPath, duration, width, height, thumbnail_path, added_date, death_timestamps, metadata, metadata_mtime } = video;
  const row = await get(
    db,
    `INSERT INTO videos (title, path, duration, width, height, thumbnail_path, added_date, death_timestamps, metadata, metadata_mtime, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       title = excluded.title,
       duration = excluded.duration,
       width = excluded.width,
       height = excluded.height,
       thumbnail_path = COALESCE(excluded.thumbnail_path, videos.thumbnail_path)
     RETURNING id`,
    [title, videoPath, duration, width, height, thumbnail_path, added_date, death_timestamps, metadata, metadata_mtime, recordedAt(title, metadata, added_date)]
  );
  return row.id;
}

/** Card-shaped row by path, for watcher updates. */
function getVideoCardByPath(db, videoPath) {
  return get(db, `SELECT ${CARD_COLUMNS} FROM videos WHERE path = ?`, [videoPath]);
}

function deleteVideo(db, id) {
  return run(db, 'DELETE FROM videos WHERE id = ?', [id]);
}

function getVideosByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return Promise.resolve([]);
  }
  const placeholders = ids.map(() => '?').join(', ');
  return all(db, `SELECT ${CARD_COLUMNS} FROM videos WHERE id IN (${placeholders})`, ids);
}

/** Rows with sidecar metadata, for advanced search. */
function getVideosWithMetadata(db) {
  return all(db, "SELECT id, title, path, duration, added_date, metadata FROM videos WHERE metadata IS NOT NULL AND metadata != ''");
}

// Scanner state for every row, without the metadata blob.
const SCAN_COLUMNS = [
  'id',
  'title',
  'path',
  'duration',
  'width',
  'height',
  'thumbnail_path',
  'death_timestamps',
  'preview_clips',
  'preview_generation_status',
  'metadata_mtime',
  'preview_attempts',
  'preview_source_mtime'
].join(', ');

const UPDATABLE_VIDEO_FIELDS = new Set([
  'title',
  'duration',
  'width',
  'height',
  'thumbnail_path',
  'death_timestamps',
  'metadata',
  'metadata_mtime',
  'preview_clips',
  'preview_generation_status',
  'preview_generation_date',
  'preview_attempts',
  'preview_source_mtime'
]);

function getVideosForScan(db) {
  return all(db, `SELECT ${SCAN_COLUMNS} FROM videos`);
}

function getVideoScanStateByPath(db, videoPath) {
  return get(db, `SELECT ${SCAN_COLUMNS} FROM videos WHERE path = ?`, [videoPath]);
}

/**
 * Update only the given (whitelisted) columns of one video; undefined values are skipped.
 * @returns {Promise<number>} changed rows
 */
async function updateVideoFields(db, id, fields) {
  const names = Object.keys(fields || {}).filter((name) => fields[name] !== undefined);
  for (const name of names) {
    if (!UPDATABLE_VIDEO_FIELDS.has(name)) {
      throw new Error(`updateVideoFields: column not allowed: ${name}`);
    }
  }
  if (names.length === 0) {
    return 0;
  }
  const assignments = names.map((name) => `${name} = ?`).join(', ');
  return run(db, `UPDATE videos SET ${assignments} WHERE id = ?`, [...names.map((name) => fields[name]), id]);
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  getVideoById,
  getVideoStreamInfo,
  addVideo,
  getVideoCardByPath,
  deleteVideo,
  getVideosPaginated,
  getVideosWithMetadata,
  getVideosByIds,
  getVideosForScan,
  getVideoScanStateByPath,
  updateVideoFields
};
