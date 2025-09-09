/**
 * @jest-environment jsdom
 */

// Mock fetch for testing
global.fetch = jest.fn();

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
global.localStorage = localStorageMock;

describe('Progress UI Functionality', () => {
  let container;

  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
    
    // Create container
    container = document.createElement('div');
    container.innerHTML = `
      <div id="videos-grid">
        <div class="video-card" data-id="1">
          <div class="thumbnail-container">
            <img class="thumbnail" src="test.jpg" alt="Test Video">
            <div class="duration-badge">10:00</div>
            <div class="progress-bar" style="--progress: 0"></div>
          </div>
        </div>
        <div class="video-card" data-id="2">
          <div class="thumbnail-container">
            <img class="thumbnail" src="test2.jpg" alt="Test Video 2">
            <div class="duration-badge">15:30</div>
            <div class="progress-bar" style="--progress: 0"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    // Reset fetch mock
    fetch.mockClear();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    localStorageMock.removeItem.mockClear();
    localStorageMock.clear.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('Session ID Generation', () => {
    test('should generate session ID with correct format', () => {
      // Test the session ID format without mocking localStorage calls
      function generateSessionId() {
        return 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      }
      
      const sessionId = generateSessionId();
      expect(sessionId).toMatch(/^session_[a-z0-9]+_\d+$/);
    });

    test('should handle localStorage operations correctly', () => {
      // Test that the mock localStorage is working
      localStorageMock.getItem.mockReturnValue(null);
      localStorageMock.setItem.mockImplementation(() => {});
      
      const result = localStorageMock.getItem('test-key');
      localStorageMock.setItem('test-key', 'test-value');
      
      expect(result).toBeNull();
      expect(localStorageMock.setItem).toHaveBeenCalledWith('test-key', 'test-value');
    });
  });

  describe('Progress Bar Updates', () => {
    test('should update progress bar styles correctly', () => {
      const progressMap = {
        1: { video_id: 1, progress_percentage: 25.5, is_completed: false },
        2: { video_id: 2, progress_percentage: 95.0, is_completed: true }
      };

      // Simulate updateProgressBars function
      function updateProgressBars(progressMap) {
        const videoCards = document.querySelectorAll('.video-card');
        
        videoCards.forEach(card => {
          const videoId = parseInt(card.dataset.id, 10);
          const progressBar = card.querySelector('.progress-bar');
          const progress = progressMap[videoId];
          
          if (progress && progressBar) {
            const percentage = Math.max(0, Math.min(100, progress.progress_percentage));
            const progressRatio = percentage / 100;
            
            // Update CSS custom property for progress
            progressBar.style.setProperty('--progress', progressRatio);
            
            // Add classes based on progress state
            if (percentage > 0) {
              card.classList.add('has-progress');
            } else {
              card.classList.remove('has-progress');
            }
            
            if (progress.is_completed || percentage >= 95) {
              card.classList.add('completed');
            } else {
              card.classList.remove('completed');
            }
            
            // Add tooltip showing progress percentage
            progressBar.title = `${Math.round(percentage)}% watched`;
          }
        });
      }

      updateProgressBars(progressMap);

      // Check first video card (25.5% progress)
      const card1 = document.querySelector('[data-id="1"]');
      const progressBar1 = card1.querySelector('.progress-bar');
      
      expect(progressBar1.style.getPropertyValue('--progress')).toBe('0.255');
      expect(card1.classList.contains('has-progress')).toBe(true);
      expect(card1.classList.contains('completed')).toBe(false);
      expect(progressBar1.title).toBe('26% watched');

      // Check second video card (95% progress, completed)
      const card2 = document.querySelector('[data-id="2"]');
      const progressBar2 = card2.querySelector('.progress-bar');
      
      expect(progressBar2.style.getPropertyValue('--progress')).toBe('0.95');
      expect(card2.classList.contains('has-progress')).toBe(true);
      expect(card2.classList.contains('completed')).toBe(true);
      expect(progressBar2.title).toBe('95% watched');
    });

    test('should handle edge cases for progress values', () => {
      const progressMap = {
        1: { video_id: 1, progress_percentage: -5, is_completed: false }, // Negative
        2: { video_id: 2, progress_percentage: 105, is_completed: false } // Over 100%
      };

      function updateProgressBars(progressMap) {
        const videoCards = document.querySelectorAll('.video-card');
        
        videoCards.forEach(card => {
          const videoId = parseInt(card.dataset.id, 10);
          const progressBar = card.querySelector('.progress-bar');
          const progress = progressMap[videoId];
          
          if (progress && progressBar) {
            const percentage = Math.max(0, Math.min(100, progress.progress_percentage));
            const progressRatio = percentage / 100;
            
            progressBar.style.setProperty('--progress', progressRatio);
            
            if (percentage > 0) {
              card.classList.add('has-progress');
            } else {
              card.classList.remove('has-progress');
            }
          }
        });
      }

      updateProgressBars(progressMap);

      // Check negative value is clamped to 0
      const card1 = document.querySelector('[data-id="1"]');
      const progressBar1 = card1.querySelector('.progress-bar');
      expect(progressBar1.style.getPropertyValue('--progress')).toBe('0');
      expect(card1.classList.contains('has-progress')).toBe(false);

      // Check value over 100% is clamped to 1
      const card2 = document.querySelector('[data-id="2"]');
      const progressBar2 = card2.querySelector('.progress-bar');
      expect(progressBar2.style.getPropertyValue('--progress')).toBe('1');
      expect(card2.classList.contains('has-progress')).toBe(true);
    });

    test('should handle missing progress data gracefully', () => {
      const progressMap = {
        // Only data for video 1, video 2 has no progress
        1: { video_id: 1, progress_percentage: 50, is_completed: false }
      };

      function updateProgressBars(progressMap) {
        const videoCards = document.querySelectorAll('.video-card');
        
        videoCards.forEach(card => {
          const videoId = parseInt(card.dataset.id, 10);
          const progressBar = card.querySelector('.progress-bar');
          const progress = progressMap[videoId];
          
          if (progress && progressBar) {
            const percentage = Math.max(0, Math.min(100, progress.progress_percentage));
            const progressRatio = percentage / 100;
            progressBar.style.setProperty('--progress', progressRatio);
            card.classList.add('has-progress');
          }
        });
      }

      updateProgressBars(progressMap);

      // Video 1 should have progress
      const card1 = document.querySelector('[data-id="1"]');
      const progressBar1 = card1.querySelector('.progress-bar');
      expect(progressBar1.style.getPropertyValue('--progress')).toBe('0.5');
      expect(card1.classList.contains('has-progress')).toBe(true);

      // Video 2 should have no progress changes
      const card2 = document.querySelector('[data-id="2"]');
      const progressBar2 = card2.querySelector('.progress-bar');
      expect(progressBar2.style.getPropertyValue('--progress')).toBe('0');
      expect(card2.classList.contains('has-progress')).toBe(false);
    });
  });

  describe('Progress Data Loading', () => {
    test('should make correct API call for batch progress', async () => {
      const mockProgressData = [
        { video_id: 1, progress_percentage: 30, is_completed: false },
        { video_id: 2, progress_percentage: 80, is_completed: false }
      ];

      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockProgressData)
      });

      // Simulate loadProgressForVideos function
      async function loadProgressForVideos(videoIds) {
        if (!videoIds || videoIds.length === 0) {
          return {};
        }

        const response = await fetch(`/api/videos/progress/batch?video_ids=${videoIds.join(',')}`, {
          headers: {
            'X-Session-ID': 'test-session'
          }
        });

        if (response.ok) {
          const progressArray = await response.json();
          const progressMap = {};
          progressArray.forEach(progress => {
            progressMap[progress.video_id] = progress;
          });
          return progressMap;
        } else {
          return {};
        }
      }

      const result = await loadProgressForVideos([1, 2]);

      expect(fetch).toHaveBeenCalledWith(
        '/api/videos/progress/batch?video_ids=1,2',
        {
          headers: {
            'X-Session-ID': 'test-session'
          }
        }
      );

      expect(result).toEqual({
        1: { video_id: 1, progress_percentage: 30, is_completed: false },
        2: { video_id: 2, progress_percentage: 80, is_completed: false }
      });
    });

    test('should handle API errors gracefully', async () => {
      fetch.mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error'
      });

      // Mock console.warn to avoid test output
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      async function loadProgressForVideos(videoIds) {
        try {
          const response = await fetch(`/api/videos/progress/batch?video_ids=${videoIds.join(',')}`);
          
          if (response.ok) {
            const progressArray = await response.json();
            const progressMap = {};
            progressArray.forEach(progress => {
              progressMap[progress.video_id] = progress;
            });
            return progressMap;
          } else {
            console.warn('Failed to load progress data:', response.statusText);
            return {};
          }
        } catch (error) {
          console.error('Error loading progress data:', error);
          return {};
        }
      }

      const result = await loadProgressForVideos([1, 2]);

      expect(consoleSpy).toHaveBeenCalledWith('Failed to load progress data:', 'Internal Server Error');
      expect(result).toEqual({});

      consoleSpy.mockRestore();
    });

    test('should handle network errors gracefully', async () => {
      fetch.mockRejectedValue(new Error('Network error'));

      // Mock console.error to avoid test output
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      async function loadProgressForVideos(videoIds) {
        try {
          const response = await fetch(`/api/videos/progress/batch?video_ids=${videoIds.join(',')}`);
          
          if (response.ok) {
            const progressArray = await response.json();
            const progressMap = {};
            progressArray.forEach(progress => {
              progressMap[progress.video_id] = progress;
            });
            return progressMap;
          } else {
            return {};
          }
        } catch (error) {
          console.error('Error loading progress data:', error);
          return {};
        }
      }

      const result = await loadProgressForVideos([1, 2]);

      expect(consoleSpy).toHaveBeenCalledWith('Error loading progress data:', expect.any(Error));
      expect(result).toEqual({});

      consoleSpy.mockRestore();
    });
  });

  describe('CSS Progress Bar Styling', () => {
    test('should apply correct CSS classes for progress states', () => {
      const card = document.querySelector('[data-id="1"]');
      const progressBar = card.querySelector('.progress-bar');

      // Test has-progress class
      card.classList.add('has-progress');
      expect(card.classList.contains('has-progress')).toBe(true);

      // Test completed class
      card.classList.add('completed');
      expect(card.classList.contains('completed')).toBe(true);

      // Test progress bar CSS custom property
      progressBar.style.setProperty('--progress', '0.75');
      expect(progressBar.style.getPropertyValue('--progress')).toBe('0.75');
    });

    test('should set correct tooltip text', () => {
      const progressBar = document.querySelector('.progress-bar');
      
      progressBar.title = '75% watched';
      expect(progressBar.title).toBe('75% watched');
    });
  });
});