const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

// Import the actual module without mocking
jest.unmock('../../db/database');
const dbModule = require('../../db/database');

describe('Progress Tracking Integration', () => {
  let db;
  const testDbPath = path.join(__dirname, '..', 'progress-integration.db');

  beforeAll(async () => {
    // Remove test database if it exists
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Create test database directly
    db = new sqlite3.Database(testDbPath);
    
    // Create tables manually for testing
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        // Create videos table
        db.run(`
          CREATE TABLE videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            duration INTEGER,
            added_date TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
          
          // Create video_progress table
          db.run(`
            CREATE TABLE video_progress (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              video_id INTEGER NOT NULL,
              user_session TEXT NOT NULL,
              current_time REAL NOT NULL,
              duration REAL NOT NULL,
              progress_percentage REAL NOT NULL,
              is_completed BOOLEAN DEFAULT 0,
              last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(video_id, user_session)
            )
          `, (err) => {
            if (err) return reject(err);
            
            // Insert test video data
            db.run(
              `INSERT INTO videos (id, title, path, duration, added_date) VALUES 
               (1, 'Test Video 1', '/test/video1.mp4', 3600, '2024-01-01'),
               (2, 'Test Video 2', '/test/video2.mp4', 1800, '2024-01-02'),
               (3, 'Test Video 3', '/test/video3.mp4', 7200, '2024-01-03')`,
              function(err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        });
      });
    });
  }, 10000);

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await new Promise((resolve) => {
        db.close((err) => {
          if (err) console.error('Error closing database:', err);
          resolve();
        });
      });
    }
    
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }, 10000);

  beforeEach(async () => {
    // Clear progress data before each test
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM video_progress', function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  describe('Basic CRUD Operations', () => {
    const testSession = 'test-session-123';

    test('should create video progress record', async () => {
      const progressData = {
        video_id: 1,
        user_session: testSession,
        current_time: 150.5,
        duration: 3600,
        progress_percentage: 4.18
      };

      const result = await dbModule.addVideoProgress(db, progressData);
      expect(result).toBeDefined();
      expect(typeof result).toBe('number'); // Should return inserted ID
    });

    test('should retrieve video progress', async () => {
      // First add some progress
      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 300,
        duration: 3600,
        progress_percentage: 8.33
      });

      const progress = await dbModule.getVideoProgress(db, 1, testSession);
      expect(progress).toBeDefined();
      expect(progress.video_id).toBe(1);
      expect(progress.current_time).toBe(300);
      expect(progress.progress_percentage).toBeCloseTo(8.33);
    });

    test('should update existing video progress using addVideoProgress', async () => {
      // Add initial progress
      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      // Update progress using addVideoProgress (which does INSERT OR REPLACE)
      const updatedData = {
        video_id: 1,
        user_session: testSession,
        current_time: 500,
        duration: 3600,
        progress_percentage: 13.89
      };

      const result = await dbModule.addVideoProgress(db, updatedData);
      expect(result).toBeDefined();

      // Verify update
      const progress = await dbModule.getVideoProgress(db, 1, testSession);
      expect(progress.current_time).toBe(500);
      expect(progress.progress_percentage).toBeCloseTo(13.89);
    });

    test('should delete video progress', async () => {
      // Add progress
      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 200,
        duration: 3600,
        progress_percentage: 5.56
      });

      // Delete progress
      const result = await dbModule.deleteVideoProgress(db, 1, testSession);
      expect(result).toBeGreaterThan(0);

      // Verify deletion
      const progress = await dbModule.getVideoProgress(db, 1, testSession);
      expect(progress).toBe(undefined); // SQLite returns undefined, not null
    });

    test('should get batch video progress', async () => {
      // Add progress for multiple videos
      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      await dbModule.addVideoProgress(db, {
        video_id: 2,
        user_session: testSession,
        current_time: 900,
        duration: 1800,
        progress_percentage: 50.0
      });

      const batchProgress = await dbModule.getBatchVideoProgress(db, [1, 2, 3], testSession);
      expect(batchProgress).toHaveLength(2); // Only videos 1 and 2 have progress
      
      const video1Progress = batchProgress.find(p => p.video_id === 1);
      const video2Progress = batchProgress.find(p => p.video_id === 2);
      
      expect(video1Progress.progress_percentage).toBeCloseTo(2.78);
      expect(video2Progress.progress_percentage).toBe(50.0);
    });

    test('should mark as completed at 95% threshold', async () => {
      const progressData = {
        video_id: 1,
        user_session: testSession,
        current_time: 3420, // 95% of 3600
        duration: 3600,
        progress_percentage: 95.0
      };

      await dbModule.addVideoProgress(db, progressData);
      const progress = await dbModule.getVideoProgress(db, 1, testSession);
      expect(progress.is_completed).toBe(1); // SQLite uses 1 for true
    });

    test('should handle multiple sessions for same video', async () => {
      const session1 = 'session-1';
      const session2 = 'session-2';

      // Add progress for same video but different sessions
      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: session1,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      await dbModule.addVideoProgress(db, {
        video_id: 1,
        user_session: session2,
        current_time: 200,
        duration: 3600,
        progress_percentage: 5.56
      });

      const progress1 = await dbModule.getVideoProgress(db, 1, session1);
      const progress2 = await dbModule.getVideoProgress(db, 1, session2);

      expect(progress1.current_time).toBe(100);
      expect(progress2.current_time).toBe(200);
    });
  });
});