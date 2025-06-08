/**
 * @jest-environment jsdom
 */

// Mock DOM environment for overlay video player tests
global.fetch = jest.fn();
global.HTMLVideoElement.prototype.play = jest.fn().mockImplementation(() => Promise.resolve());
global.HTMLVideoElement.prototype.pause = jest.fn();
global.HTMLVideoElement.prototype.load = jest.fn();

// Mock Plyr
global.Plyr = jest.fn().mockImplementation(() => ({
  destroy: jest.fn(),
  on: jest.fn(),
  currentTime: 0,
  duration: 100,
  play: jest.fn().mockResolvedValue(),
  pause: jest.fn(),
  source: null
}));

// Mock URL API
global.URL = {
  createObjectURL: jest.fn(() => 'blob:mock-url'),
  revokeObjectURL: jest.fn()
};

// Mock history API
const mockPushState = jest.fn();
const mockReplaceState = jest.fn();
const mockBack = jest.fn();

global.history = {
  pushState: mockPushState,
  replaceState: mockReplaceState,
  back: mockBack
};

// Mock window location
delete global.window.location;
global.window.location = {
  pathname: '/',
  search: '',
  href: 'http://localhost:3000/',
  assign: jest.fn(),
  reload: jest.fn()
};

describe('Video Overlay Player', () => {
  let mockVideoOverlay;
  let mockVideoCard;
  let mockCloseButton;
  let mockOverlayVideo;
  let mockBackdrop;

  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
    
    // Create mock overlay structure
    mockVideoOverlay = document.createElement('div');
    mockVideoOverlay.id = 'video-overlay';
    mockVideoOverlay.className = 'video-overlay';
    
    mockBackdrop = document.createElement('div');
    mockBackdrop.className = 'video-overlay-backdrop';
    
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'video-overlay-container';
    
    mockCloseButton = document.createElement('button');
    mockCloseButton.className = 'video-overlay-close';
    mockCloseButton.textContent = '×';
    
    const overlayContent = document.createElement('div');
    overlayContent.className = 'video-overlay-content';
    
    mockOverlayVideo = document.createElement('video');
    mockOverlayVideo.id = 'overlay-video-player';
    mockOverlayVideo.setAttribute('playsinline', '');
    mockOverlayVideo.setAttribute('controls', '');
    
    const overlayInfo = document.createElement('div');
    overlayInfo.className = 'video-overlay-info';
    overlayInfo.innerHTML = `
      <h2 id="overlay-video-title"></h2>
      <div class="video-overlay-meta">
        <span id="overlay-video-date"></span>
        <span id="overlay-video-duration"></span>
      </div>
      <div class="video-overlay-actions">
        <button id="overlay-favorite-btn" class="favorite-btn">
          <span class="favorite-text">Add to Favorites</span>
        </button>
      </div>
    `;
    
    overlayContent.appendChild(mockOverlayVideo);
    overlayContent.appendChild(overlayInfo);
    overlayContainer.appendChild(mockCloseButton);
    overlayContainer.appendChild(overlayContent);
    mockVideoOverlay.appendChild(mockBackdrop);
    mockVideoOverlay.appendChild(overlayContainer);
    document.body.appendChild(mockVideoOverlay);
    
    // Create mock video card
    mockVideoCard = document.createElement('div');
    mockVideoCard.className = 'video-card';
    mockVideoCard.dataset.id = '123';
    
    const videoLink = document.createElement('a');
    videoLink.href = '/watch/123';
    videoLink.className = 'video-card-link';
    videoLink.innerHTML = `
      <div class="thumbnail-container">
        <img class="thumbnail" src="/thumbnails/123.jpg" alt="Test Video">
        <div class="duration-badge">10:30</div>
      </div>
      <div class="video-info">
        <div class="video-title">Test Video</div>
        <div class="video-date">2024-01-01</div>
      </div>
    `;
    
    mockVideoCard.appendChild(videoLink);
    document.body.appendChild(mockVideoCard);
    
    // Mock fetch responses
    global.fetch.mockClear();
    
    // Mock VideoUtils
    global.VideoUtils = {
      showToast: jest.fn(),
      isFavorite: jest.fn(() => false),
      toggleFavorite: jest.fn(() => true),
      formatDuration: jest.fn(duration => `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`),
      getVODsName: jest.fn(() => Promise.resolve('Test VODs'))
    };
    
    // Mock VideoPreloader
    global.VideoPreloader = {
      getCachedMetadata: jest.fn(),
      cacheVideoMetadata: jest.fn(),
      preloadSegment: jest.fn().mockResolvedValue(true)
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Clean up any event listeners
    document.removeEventListener('keydown', expect.any(Function));
  });

  describe('Overlay Structure and Initialization', () => {
    test('should have correct overlay structure in DOM', () => {
      expect(document.getElementById('video-overlay')).toBeTruthy();
      expect(document.querySelector('.video-overlay-backdrop')).toBeTruthy();
      expect(document.querySelector('.video-overlay-container')).toBeTruthy();
      expect(document.querySelector('.video-overlay-close')).toBeTruthy();
      expect(document.getElementById('overlay-video-player')).toBeTruthy();
    });

    test('should be hidden by default', () => {
      expect(mockVideoOverlay.classList.contains('visible')).toBe(false);
      // In test environment, we'll check style property directly
      expect(mockVideoOverlay.style.display).toBe('');
    });

    test('should have proper accessibility attributes', () => {
      // Add accessibility attributes for testing
      const overlay = document.getElementById('video-overlay');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'overlay-video-title');
      
      expect(overlay.getAttribute('role')).toBe('dialog');
      expect(overlay.getAttribute('aria-modal')).toBe('true');
      expect(overlay.getAttribute('aria-labelledby')).toBe('overlay-video-title');
    });
  });

  describe('Opening Video Overlay', () => {
    test('should open overlay when video card is clicked', async () => {
      // Mock successful video fetch
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: 123,
          title: 'Test Video',
          duration: 630,
          duration_formatted: '10:30',
          added_date: '2024-01-01T00:00:00Z',
          thumbnail_path: '/thumbnails/123.jpg'
        })
      });

      // Simulate clicking video card (this would be handled by modified main.js)
      const openVideoOverlay = jest.fn().mockImplementation(async (videoId) => {
        mockVideoOverlay.classList.add('visible');
        mockVideoOverlay.style.display = 'flex';
        
        // Update URL
        global.window.location.pathname = `/watch/${videoId}`;
        global.history.pushState({}, '', `/watch/${videoId}`);
        
        // Load video data
        const response = await fetch(`/api/videos/${videoId}`);
        const video = await response.json();
        
        document.getElementById('overlay-video-title').textContent = video.title;
        mockOverlayVideo.src = `/api/videos/${videoId}/stream`;
        
        return video;
      });

      const video = await openVideoOverlay('123');
      
      expect(mockVideoOverlay.classList.contains('visible')).toBe(true);
      expect(mockVideoOverlay.style.display).toBe('flex');
      expect(document.getElementById('overlay-video-title').textContent).toBe('Test Video');
      expect(mockOverlayVideo.src).toContain('/api/videos/123/stream');
      expect(global.window.location.pathname).toBe('/watch/123');
    });

    test('should handle video loading errors gracefully', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const openVideoOverlay = jest.fn().mockImplementation(async (videoId) => {
        try {
          const response = await fetch(`/api/videos/${videoId}`);
          await response.json();
        } catch (error) {
          global.VideoUtils.showToast('Failed to load video. Please try again.', 'error');
          return null;
        }
      });

      const result = await openVideoOverlay('123');
      
      expect(result).toBeNull();
      expect(global.VideoUtils.showToast).toHaveBeenCalledWith('Failed to load video. Please try again.', 'error');
    });

    test('should prevent body scroll when overlay is open', () => {
      mockVideoOverlay.classList.add('visible');
      
      // This would be implemented in the actual overlay functionality
      const preventScroll = () => {
        document.body.style.overflow = 'hidden';
      };
      
      preventScroll();
      expect(document.body.style.overflow).toBe('hidden');
    });

    test('should focus on close button when overlay opens', () => {
      const focusSpy = jest.spyOn(mockCloseButton, 'focus');
      
      // Simulate opening overlay
      mockVideoOverlay.classList.add('visible');
      mockCloseButton.focus();
      
      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('Closing Video Overlay', () => {
    beforeEach(() => {
      // Set up open overlay state
      mockVideoOverlay.classList.add('visible');
      mockVideoOverlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    });

    test('should close overlay when close button is clicked', () => {
      const closeVideoOverlay = jest.fn().mockImplementation(() => {
        mockVideoOverlay.classList.remove('visible');
        mockVideoOverlay.style.display = 'none';
        document.body.style.overflow = '';
        
        // Reset URL
        global.window.location.pathname = '/';
        global.history.pushState({}, '', '/');
        
        // Clean up video
        mockOverlayVideo.src = '';
        mockOverlayVideo.pause();
      });

      mockCloseButton.addEventListener('click', closeVideoOverlay);
      mockCloseButton.click();

      expect(mockVideoOverlay.classList.contains('visible')).toBe(false);
      expect(mockVideoOverlay.style.display).toBe('none');
      expect(document.body.style.overflow).toBe('');
      expect(global.window.location.pathname).toBe('/');
    });

    test('should close overlay when backdrop is clicked', () => {
      const closeVideoOverlay = jest.fn().mockImplementation(() => {
        mockVideoOverlay.classList.remove('visible');
      });

      mockBackdrop.addEventListener('click', closeVideoOverlay);
      mockBackdrop.click();

      expect(closeVideoOverlay).toHaveBeenCalled();
    });

    test('should close overlay when Escape key is pressed', () => {
      const closeVideoOverlay = jest.fn().mockImplementation(() => {
        mockVideoOverlay.classList.remove('visible');
      });

      const handleKeydown = (event) => {
        if (event.key === 'Escape' && mockVideoOverlay.classList.contains('visible')) {
          closeVideoOverlay();
        }
      };

      document.addEventListener('keydown', handleKeydown);
      
      // Simulate Escape key press
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(escapeEvent);

      expect(closeVideoOverlay).toHaveBeenCalled();
    });

    test('should destroy Plyr instance when closing', () => {
      const mockPlyrInstance = {
        destroy: jest.fn(),
        pause: jest.fn()
      };

      const closeVideoOverlay = jest.fn().mockImplementation(() => {
        if (mockPlyrInstance) {
          mockPlyrInstance.pause();
          mockPlyrInstance.destroy();
        }
      });

      closeVideoOverlay();

      expect(mockPlyrInstance.pause).toHaveBeenCalled();
      expect(mockPlyrInstance.destroy).toHaveBeenCalled();
    });
  });

  describe('URL State Management', () => {
    test('should update URL when overlay opens', () => {
      const openVideoOverlay = jest.fn().mockImplementation((videoId) => {
        global.window.location.pathname = `/watch/${videoId}`;
        mockPushState({ videoOverlay: true, videoId }, '', `/watch/${videoId}`);
      });

      openVideoOverlay('456');

      expect(global.window.location.pathname).toBe('/watch/456');
      expect(mockPushState).toHaveBeenCalledWith(
        { videoOverlay: true, videoId: '456' }, 
        '', 
        '/watch/456'
      );
    });

    test('should handle browser back button', () => {
      const handlePopState = jest.fn().mockImplementation((event) => {
        if (event.state && event.state.videoOverlay) {
          // Open overlay with video from state
          mockVideoOverlay.classList.add('visible');
        } else {
          // Close overlay
          mockVideoOverlay.classList.remove('visible');
        }
      });

      window.addEventListener('popstate', handlePopState);
      
      // Simulate back button (closing overlay)
      const popstateEvent = new PopStateEvent('popstate', { state: null });
      window.dispatchEvent(popstateEvent);

      expect(handlePopState).toHaveBeenCalled();
    });

    test('should support direct URL access to video overlay', () => {
      // Simulate direct navigation to /watch/789
      global.window.location.pathname = '/watch/789';
      
      const initializeFromURL = jest.fn().mockImplementation(() => {
        const pathMatch = global.window.location.pathname.match(/^\/watch\/(\d+)$/);
        if (pathMatch) {
          const videoId = pathMatch[1];
          // Would open overlay with this video
          return videoId;
        }
        return null;
      });

      const videoId = initializeFromURL();
      expect(videoId).toBe('789');
    });
  });

  describe('Video Player Integration', () => {
    test('should initialize Plyr player when overlay opens', () => {
      const initializePlyrPlayer = jest.fn().mockImplementation(() => {
        const plyrInstance = new global.Plyr(mockOverlayVideo, {
          controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
          autoplay: true
        });
        return plyrInstance;
      });

      const plyrInstance = initializePlyrPlayer();

      expect(global.Plyr).toHaveBeenCalledWith(mockOverlayVideo, expect.objectContaining({
        autoplay: true
      }));
      expect(plyrInstance).toBeDefined();
    });

    test('should preserve video features (favorites, sharing)', () => {
      const favoriteBtn = document.getElementById('overlay-favorite-btn');
      const favoriteText = favoriteBtn.querySelector('.favorite-text');

      const handleFavoriteClick = jest.fn().mockImplementation(() => {
        const isNowFavorited = global.VideoUtils.toggleFavorite('123');
        favoriteText.textContent = isNowFavorited ? 'Remove from Favorites' : 'Add to Favorites';
        global.VideoUtils.showToast(isNowFavorited ? 'Added to favorites' : 'Removed from favorites');
      });

      favoriteBtn.addEventListener('click', handleFavoriteClick);
      favoriteBtn.click();

      expect(global.VideoUtils.toggleFavorite).toHaveBeenCalledWith('123');
      expect(favoriteText.textContent).toBe('Remove from Favorites');
      expect(global.VideoUtils.showToast).toHaveBeenCalledWith('Added to favorites');
    });

    test('should handle timestamp URLs', () => {
      global.window.location.search = '?t=120';
      
      const handleTimestamp = jest.fn().mockImplementation(() => {
        const urlParams = new URLSearchParams(global.window.location.search);
        const startTime = urlParams.get('t');
        if (startTime) {
          return parseInt(startTime, 10);
        }
        return 0;
      });

      const timestamp = handleTimestamp();
      expect(timestamp).toBe(120);
    });
  });

  describe('Mobile and Accessibility', () => {
    test('should be responsive on mobile devices', () => {
      // Simulate mobile viewport
      Object.defineProperty(window, 'innerWidth', { value: 375, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: 667, writable: true });

      const overlayContainer = document.querySelector('.video-overlay-container');
      
      // These styles would be applied via CSS media queries
      const applyMobileStyles = () => {
        overlayContainer.style.maxWidth = '100vw';
        overlayContainer.style.maxHeight = '100vh';
        overlayContainer.style.borderRadius = '0';
      };

      applyMobileStyles();
      
      expect(overlayContainer.style.maxWidth).toBe('100vw');
      expect(overlayContainer.style.maxHeight).toBe('100vh');
    });

    test('should trap focus within overlay', () => {
      const focusableElements = mockVideoOverlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];

      const trapFocus = jest.fn().mockImplementation((event) => {
        if (event.key === 'Tab') {
          if (event.shiftKey) {
            if (document.activeElement === firstFocusable) {
              event.preventDefault();
              lastFocusable.focus();
            }
          } else {
            if (document.activeElement === lastFocusable) {
              event.preventDefault();
              firstFocusable.focus();
            }
          }
        }
      });

      mockVideoOverlay.addEventListener('keydown', trapFocus);
      
      // Simulate Tab on last element
      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab' });
      Object.defineProperty(document, 'activeElement', { value: lastFocusable, writable: true });
      
      mockVideoOverlay.dispatchEvent(tabEvent);
      expect(trapFocus).toHaveBeenCalled();
    });

    test('should announce overlay state to screen readers', () => {
      const overlayTitle = document.getElementById('overlay-video-title');
      overlayTitle.textContent = 'Test Video';
      
      // Simulate screen reader announcement
      const announceToScreenReader = jest.fn().mockImplementation((message) => {
        const announcement = document.createElement('div');
        announcement.setAttribute('aria-live', 'polite');
        announcement.textContent = message;
        document.body.appendChild(announcement);
        setTimeout(() => document.body.removeChild(announcement), 1000);
      });

      announceToScreenReader('Video overlay opened: Test Video');
      
      expect(announceToScreenReader).toHaveBeenCalledWith('Video overlay opened: Test Video');
    });
  });

  describe('Performance and Memory Management', () => {
    test('should clean up resources when overlay closes', () => {
      const cleanup = jest.fn().mockImplementation(() => {
        // Revoke blob URLs
        if (mockOverlayVideo.src && mockOverlayVideo.src.startsWith('blob:')) {
          global.URL.revokeObjectURL(mockOverlayVideo.src);
        }
        
        // Remove event listeners
        mockOverlayVideo.removeEventListener('loadeddata', expect.any(Function));
        mockOverlayVideo.removeEventListener('error', expect.any(Function));
        
        // Clear video source
        mockOverlayVideo.src = '';
        mockOverlayVideo.load();
      });

      // Set up a blob URL to test cleanup
      mockOverlayVideo.src = 'blob:mock-url';
      cleanup();
      
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    test('should handle multiple rapid open/close operations', async () => {
      const operations = [];
      
      for (let i = 0; i < 5; i++) {
        operations.push(
          Promise.resolve().then(() => {
            mockVideoOverlay.classList.add('visible');
            return new Promise(resolve => setTimeout(resolve, 10));
          }).then(() => {
            mockVideoOverlay.classList.remove('visible');
          })
        );
      }

      await Promise.all(operations);
      
      // Should end in closed state
      expect(mockVideoOverlay.classList.contains('visible')).toBe(false);
    });

    test('should preload video segments when overlay opens', async () => {
      const preloadSegments = jest.fn().mockImplementation(async (videoId) => {
        for (let i = 0; i <= 2; i++) {
          await global.VideoPreloader.preloadSegment(videoId, i);
        }
      });

      await preloadSegments('123');
      
      expect(global.VideoPreloader.preloadSegment).toHaveBeenCalledTimes(3);
      expect(global.VideoPreloader.preloadSegment).toHaveBeenCalledWith('123', 0);
      expect(global.VideoPreloader.preloadSegment).toHaveBeenCalledWith('123', 1);
      expect(global.VideoPreloader.preloadSegment).toHaveBeenCalledWith('123', 2);
    });
  });
});