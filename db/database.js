const sqlite3 = require('sqlite3');
const { open } = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure the db directory exists
const dbDir = process.env.DB_DIR || path.join(__dirname, '..', 'data', 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'videos.db');

/**
 * Initialize the database and create tables if they don't exist
 */
async function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        return reject(err);
      }

      // Use db.serialize to ensure sequential execution
      db.serialize(() => {
        // Create videos table
        db.run(`
          CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            duration INTEGER,
            added_date TEXT DEFAULT CURRENT_TIMESTAMP,
            thumbnail_path TEXT,
            death_timestamps TEXT -- Added column for JSON death timestamps
          )
        `, (err) => {
          if (err) return reject(err);

          // Create title index
          db.run(`CREATE INDEX IF NOT EXISTS idx_videos_title ON videos (title);`, (err) => {
            if (err) return reject(err);

            // Create added_date index
            db.run(`CREATE INDEX IF NOT EXISTS idx_videos_added_date ON videos (added_date);`, (err) => {
              if (err) return reject(err);

              // Attempt to add death_timestamps column (ignore duplicate error)
              db.run(`ALTER TABLE videos ADD COLUMN death_timestamps TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                  return reject(err);
                }
                // All steps completed successfully
                resolve(db);
              });
            });
          });
        });
      }); // End of db.serialize
    });
  });
}

/**
 * Get videos with pagination, optional search, and sorting
 */
function getVideosPaginated(db, page = 1, limit = 50, searchQuery = null, sort = 'date_added_desc') {
  return new Promise(async (resolve, reject) => {
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM videos';
    let countQuery = 'SELECT COUNT(*) as totalCount FROM videos';
    const params = [];
    const countParams = [];

    if (searchQuery) {
      const searchPattern = `%${searchQuery}%`;
      query += ' WHERE title LIKE ? COLLATE NOCASE';
      countQuery += ' WHERE title LIKE ? COLLATE NOCASE';
      params.push(searchPattern);
      countParams.push(searchPattern);
    }

    // Determine ORDER BY clause based on sort parameter
    let orderByClause = 'ORDER BY added_date DESC'; // Default sort
    switch (sort) {
      case 'title_asc':
        orderByClause = 'ORDER BY title COLLATE NOCASE ASC';
        break;
      case 'title_desc':
        orderByClause = 'ORDER BY title COLLATE NOCASE DESC';
        break;
      case 'date_added_asc':
        orderByClause = 'ORDER BY added_date ASC';
        break;
      case 'date_added_desc':
        orderByClause = 'ORDER BY added_date DESC';
        break;
      // Add more cases for other sorting options if needed
    }

    query += ` ${orderByClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      // Get total count first
      const countResult = await new Promise((resolveCount, rejectCount) => {
        db.get(countQuery, countParams, (err, row) => {
          if (err) {
            rejectCount(err);
          } else {
            resolveCount(row);
          }
        });
      });
      const totalCount = countResult.totalCount;

      // Then get the paginated results
      db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ videos: rows, totalCount });
      });
    } catch (err) {
      reject(err);
    }
  });
}


/**
 * Get all videos from the database (Deprecated by getVideosPaginated)
 */
function getAllVideos(db) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM videos ORDER BY added_date DESC', (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

/**
 * Get a video by ID
 */
function getVideoById(db, id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM videos WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

/**
 * Add a new video to the database
 */
function addVideo(db, video) {
  return new Promise((resolve, reject) => {
    // Destructure all expected fields, including the new one
    const { title, path, duration, thumbnail_path, added_date, death_timestamps } = video;
    
    db.run(
      'INSERT OR REPLACE INTO videos (title, path, duration, thumbnail_path, added_date, death_timestamps) VALUES (?, ?, ?, ?, ?, ?)',
      [title, path, duration, thumbnail_path, added_date, death_timestamps], // Add death_timestamps here
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.lastID);
      }
    );
  });
}

/**
 * Update a video's thumbnail path
 */
function updateVideoThumbnail(db, id, thumbnail_path) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE videos SET thumbnail_path = ? WHERE id = ?',
      [thumbnail_path, id],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.changes);
      }
    );
  });
}

/**
 * Delete all videos from the database
 */
function clearVideos(db) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM videos', function(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this.changes);
    });
  });
}

/**
 * Check if a video exists in the database by path
 */
function getVideoByPath(db, path) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM videos WHERE path = ?', [path], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

/**
 * Update an existing video in the database
 */
function updateVideo(db, id, video) {
  return new Promise((resolve, reject) => {
    // Destructure all expected fields, including the new one
    const { title, path, duration, thumbnail_path, added_date, death_timestamps } = video;
    
    db.run(
      'UPDATE videos SET title = ?, path = ?, duration = ?, thumbnail_path = ?, added_date = ?, death_timestamps = ? WHERE id = ?',
      [title, path, duration, thumbnail_path, added_date, death_timestamps, id], // Add death_timestamps here
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.changes);
      }
    );
  });
}

/**
 * Get all video paths from the database
 */
function getAllVideoPaths(db) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, path FROM videos', (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

/**
 * Delete a video by ID
 */
function deleteVideo(db, id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM videos WHERE id = ?', [id], function(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this.changes);
    });
  });
}

module.exports = {
  initializeDatabase,
  getAllVideos,
  getVideoById,
  addVideo,
  updateVideoThumbnail,
  clearVideos,
  getVideoByPath,
  updateVideo,
  getAllVideoPaths,
  deleteVideo,
  getVideosPaginated // Export the new function
};
