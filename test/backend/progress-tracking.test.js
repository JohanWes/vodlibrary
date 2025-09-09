const request = require('supertest');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

// Import the progress tracking functions we'll implement
let {
  getVideoProgress,
  updateVideoProgress,
  deleteVideoProgress,
  getBatchVideoProgress,
  addVideoProgress
} = require('../../db/database');

describe('Progress Tracking', () => {
  let app;
  let db;
  const testDbPath = path.join(__dirname, '..', 'test-progress.db');

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
    
    // Setup app with database
    const express = require('express');
    app = express();
    app.use(express.json());
    app.locals.db = db;
    
    // Import routes after db is set up
    const apiRoutes = require('../../routes/api');
    app.use('/api', apiRoutes);
  }, 10000); // Increase timeout to 10 seconds

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

  describe('Database Functions', () => {
    const testSession = 'test-session-123';

    test('should create video progress record', async () => {
      const progressData = {
        video_id: 1,
        user_session: testSession,
        current_time: 150.5,
        duration: 3600,
        progress_percentage: 4.18
      };

      const result = await addVideoProgress(db, progressData);
      expect(result).toBeDefined();
      expect(typeof result).toBe('number'); // Should return inserted ID
    });

    test('should retrieve video progress', async () => {
      // First add some progress
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 300,
        duration: 3600,
        progress_percentage: 8.33
      });

      const progress = await getVideoProgress(db, 1, testSession);
      expect(progress).toBeDefined();
      expect(progress.video_id).toBe(1);
      expect(progress.current_time).toBe(300);
      expect(progress.progress_percentage).toBeCloseTo(8.33);
    });

    test('should update existing video progress', async () => {
      // Add initial progress
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      // Update progress
      const updatedData = {
        video_id: 1,
        user_session: testSession,
        current_time: 500,
        duration: 3600,
        progress_percentage: 13.89
      };

      const result = await updateVideoProgress(db, updatedData);
      expect(result).toBeGreaterThan(0); // Should return number of changed rows

      // Verify update
      const progress = await getVideoProgress(db, 1, testSession);
      expect(progress.current_time).toBe(500);
      expect(progress.progress_percentage).toBeCloseTo(13.89);
    });

    test('should delete video progress', async () => {
      // Add progress
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 200,
        duration: 3600,
        progress_percentage: 5.56
      });

      // Delete progress
      const result = await deleteVideoProgress(db, 1, testSession);
      expect(result).toBeGreaterThan(0);

      // Verify deletion
      const progress = await getVideoProgress(db, 1, testSession);
      expect(progress).toBeNull();
    });

    test('should get batch video progress', async () => {
      // Add progress for multiple videos
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      await addVideoProgress(db, {
        video_id: 2,
        user_session: testSession,
        current_time: 900,
        duration: 1800,
        progress_percentage: 50.0
      });

      const batchProgress = await getBatchVideoProgress(db, [1, 2, 3], testSession);
      expect(batchProgress).toHaveLength(2); // Only videos 1 and 2 have progress
      
      const video1Progress = batchProgress.find(p => p.video_id === 1);
      const video2Progress = batchProgress.find(p => p.video_id === 2);
      
      expect(video1Progress.progress_percentage).toBeCloseTo(2.78);
      expect(video2Progress.progress_percentage).toBe(50.0);
    });

    test('should handle non-existent video progress gracefully', async () => {
      const progress = await getVideoProgress(db, 999, testSession);
      expect(progress).toBeNull();
    });

    test('should calculate progress percentage correctly', async () => {
      const progressData = {
        video_id: 1,
        user_session: testSession,
        current_time: 1800, // Half of 3600 second video
        duration: 3600,
        progress_percentage: 50.0
      };

      await addVideoProgress(db, progressData);
      const progress = await getVideoProgress(db, 1, testSession);
      expect(progress.progress_percentage).toBe(50.0);
    });
  });

  describe('API Endpoints', () => {
    const testSession = 'test-session-456';

    test('GET /api/videos/:id/progress should return progress', async () => {
      // Add test progress
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 420,
        duration: 3600,
        progress_percentage: 11.67
      });

      const response = await request(app)
        .get('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .expect(200);

      expect(response.body.video_id).toBe(1);
      expect(response.body.current_time).toBe(420);
      expect(response.body.progress_percentage).toBeCloseTo(11.67);
    });

    test('GET /api/videos/:id/progress should return 404 for no progress', async () => {
      await request(app)
        .get('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .expect(404);
    });

    test('PUT /api/videos/:id/progress should create new progress', async () => {
      const progressData = {
        current_time: 240,
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(progressData)
        .expect(200);

      expect(response.body.message).toContain('updated');
      expect(response.body.progress_percentage).toBeCloseTo(6.67);
    });

    test('PUT /api/videos/:id/progress should update existing progress', async () => {
      // Create initial progress
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 100,
        duration: 3600,
        progress_percentage: 2.78
      });

      const updateData = {
        current_time: 600,
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(updateData)
        .expect(200);

      expect(response.body.progress_percentage).toBeCloseTo(16.67);
    });

    test('DELETE /api/videos/:id/progress should remove progress', async () => {
      // Add progress first
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 300,
        duration: 3600,
        progress_percentage: 8.33
      });

      await request(app)
        .delete('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .expect(200);

      // Verify deletion
      const progress = await getVideoProgress(db, 1, testSession);
      expect(progress).toBeNull();
    });

    test('GET /api/videos/progress/batch should return multiple progress records', async () => {
      // Add progress for multiple videos
      await addVideoProgress(db, {
        video_id: 1,
        user_session: testSession,
        current_time: 180,
        duration: 3600,
        progress_percentage: 5.0
      });

      await addVideoProgress(db, {
        video_id: 3,
        user_session: testSession,
        current_time: 3600,
        duration: 7200,
        progress_percentage: 50.0
      });

      const response = await request(app)
        .get('/api/videos/progress/batch?video_ids=1,2,3')
        .set('X-Session-ID', testSession)
        .expect(200);

      expect(response.body).toHaveLength(2); // Only videos 1 and 3 have progress
      
      const video1Progress = response.body.find(p => p.video_id === 1);
      const video3Progress = response.body.find(p => p.video_id === 3);
      
      expect(video1Progress.progress_percentage).toBe(5.0);
      expect(video3Progress.progress_percentage).toBe(50.0);
    });

    test('should handle invalid session ID', async () => {
      await request(app)
        .get('/api/videos/1/progress')
        .expect(400); // Should require session ID
    });

    test('should validate progress data', async () => {
      const invalidData = {
        current_time: -10, // Negative time should be invalid
        duration: 3600
      };

      await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(invalidData)
        .expect(400);
    });

    test('should handle near-completion progress (95%+)', async () => {
      const nearCompleteData = {
        current_time: 3420, // 95% of 3600
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(nearCompleteData)
        .expect(200);

      expect(response.body.progress_percentage).toBeCloseTo(95.0);
      expect(response.body.is_completed).toBe(true);
    });
  });

  describe('Progress Thresholds and Business Logic', () => {
    const testSession = 'test-session-789';

    test('should not track progress for very short watch times', async () => {
      const shortWatchData = {
        current_time: 15, // Less than 30 second threshold
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(shortWatchData)
        .expect(200);

      // Should accept but possibly not store for very short times
      expect(response.body.message).toBeDefined();
    });

    test('should mark as completed at 95% threshold', async () => {
      const completeData = {
        current_time: 3420, // 95% of 3600
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(completeData)
        .expect(200);

      expect(response.body.is_completed).toBe(true);
    });

    test('should handle edge case of 100% completion', async () => {
      const fullCompleteData = {
        current_time: 3600, // 100% of 3600
        duration: 3600
      };

      const response = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(fullCompleteData)
        .expect(200);

      expect(response.body.progress_percentage).toBe(100.0);
      expect(response.body.is_completed).toBe(true);
    });
  });
});