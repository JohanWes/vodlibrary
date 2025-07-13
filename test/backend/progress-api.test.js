const request = require('supertest');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const express = require('express');

// Import the actual API routes
const apiRoutes = require('../../routes/api');

describe('Progress Tracking API', () => {
  let app;
  let db;
  const testDbPath = path.join(__dirname, '..', 'progress-api.db');
  
  // Enable console for debugging
  const originalLog = console.log;
  beforeAll(() => {
    console.log = originalLog;
  });

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

    // Setup Express app with real database
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api', apiRoutes);
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

  describe('Progress API Endpoints', () => {
    const testSession = 'test-session-456';

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
      expect(response.body.video_id).toBe(1);
      expect(response.body.current_time).toBe(240);
    });

    test('GET /api/videos/:id/progress should return progress', async () => {
      // First create some progress
      const putResponse = await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send({ current_time: 420, duration: 3600 });
      
      console.log('PUT response:', putResponse.status, putResponse.body);

      // Check database directly
      const dbCheck = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM video_progress', (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
      console.log('Database contents after PUT:', dbCheck);

      const response = await request(app)
        .get('/api/videos/1/progress')
        .set('X-Session-ID', testSession);

      console.log('GET response:', response.status, response.body);

      expect(response.status).toBe(200);
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

    test('PUT /api/videos/:id/progress should update existing progress', async () => {
      // Create initial progress
      await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send({ current_time: 100, duration: 3600 });

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
      expect(response.body.current_time).toBe(600);
    });

    test('DELETE /api/videos/:id/progress should remove progress', async () => {
      // Add progress first
      await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send({ current_time: 300, duration: 3600 });

      await request(app)
        .delete('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .expect(200);

      // Verify deletion
      await request(app)
        .get('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .expect(404);
    });

    test('GET /api/videos/progress/batch should return multiple progress records', async () => {
      // Add progress for multiple videos
      await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send({ current_time: 180, duration: 3600 });

      await request(app)
        .put('/api/videos/3/progress')
        .set('X-Session-ID', testSession)
        .send({ current_time: 3600, duration: 7200 });

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

    test('should handle missing session ID', async () => {
      await request(app)
        .get('/api/videos/1/progress')
        .expect(400);
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

    test('should handle 100% completion correctly', async () => {
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

    test('should handle edge case where current_time exceeds duration', async () => {
      const invalidData = {
        current_time: 4000, // More than 3600 duration
        duration: 3600
      };

      await request(app)
        .put('/api/videos/1/progress')
        .set('X-Session-ID', testSession)
        .send(invalidData)
        .expect(400);
    });

    test('should handle batch request with no video IDs', async () => {
      await request(app)
        .get('/api/videos/progress/batch')
        .set('X-Session-ID', testSession)
        .expect(400);
    });

    test('should handle batch request with empty video IDs', async () => {
      const response = await request(app)
        .get('/api/videos/progress/batch?video_ids=')
        .set('X-Session-ID', testSession)
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });
});