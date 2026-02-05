document.addEventListener('DOMContentLoaded', async () => {
  // Load utility functions
  const { showToast, getPlaceholderThumbnail, addUtilStyles, getVODsName, isFavorite, getFavorites } = window.VideoUtils;
  
  // Add utility styles
  addUtilStyles();
  
  // Apply reduced-effects mode before heavy DOM work
  applyLowEffectsModeIfNeeded();
  
  // Initialize video preview manager
  let videoPreviewManager;
  try {
    videoPreviewManager = new window.VideoPreviewManager();
    window.videoPreviewManager = videoPreviewManager;
    console.log('Video preview manager initialized successfully');
  } catch (error) {
    console.warn('Failed to initialize video preview manager:', error);
  }
  
  // Initialize video preloader
  try {
    await window.VideoPreloader.init();
    console.log('Video preloader initialized successfully');
  } catch (error) {
    console.warn('Failed to initialize video preloader:', error);
  }
  
  // Get the dynamic VODs name and update page elements
  const vodsName = await getVODsName();
  document.title = vodsName;
  document.getElementById('app-title').textContent = vodsName;
  document.getElementById('footer-text').textContent = `© ${vodsName} - A simple VOD sharing system`;
  
  // DOM Elements
  const videosGrid = document.getElementById('videos-grid');
  const refreshBtn = document.getElementById('refresh-btn');
  const sortSelect = document.getElementById('sort-select');
  const searchInput = document.getElementById('search-input');
  const searchButton = document.getElementById('search-button');
  const advancedSearchToggle = document.getElementById('advanced-search-toggle');
  const favoritesToggle = document.getElementById('favorites-toggle');
  const videosLoadSentinel = document.getElementById('videos-load-sentinel');
  const scanStatusElement = document.getElementById('scan-status'); // Get scan status element
  const loadingIndicator = document.createElement('div'); // Create loading indicator dynamically
  loadingIndicator.className = 'loading';
  loadingIndicator.style.display = 'none';
  videosGrid.parentNode.appendChild(loadingIndicator); // Append near the grid

  if (videosGrid) {
    videosGrid.addEventListener('click', handleVideoGridClick);
    videosGrid.addEventListener('auxclick', handleVideoGridAuxClick);
    videosGrid.addEventListener('mousedown', handleVideoGridMouseDown);
    videosGrid.addEventListener('pointermove', handleVideoGridPointerMove);
    videosGrid.addEventListener('pointerleave', handleVideoGridPointerLeave);
    videosGrid.addEventListener('pointerdown', handleVideoGridPointerDown);
    videosGrid.addEventListener('pointerup', handleVideoGridPointerUpOrCancel);
    videosGrid.addEventListener('pointercancel', handleVideoGridPointerUpOrCancel);
    window.addEventListener('scroll', clearActiveCardTilt, { passive: true });
    window.addEventListener('blur', clearActiveCardTilt);
    window.addEventListener('pointerup', clearTouchActiveCards);
    window.addEventListener('pointercancel', clearTouchActiveCards);
  }

  // State Variables
  let allVideos = []; // Holds all currently loaded videos across pages
  let sortBy = 'date_added_desc'; // Default sort by date added (newest)
  let searchQuery = '';
  let searchTimeout = null;
  let isLoading = false;
  let showOnlyFavorites = false;
  let useAdvancedSearch = false;
  let currentPage = 1;
  let totalPages = 1;
  let limit = 20; // Default limit, will be updated from API response - Reduced batch size for better scrolling performance
  let totalVideos = 0;
  let currentAbortController = null; // To cancel ongoing fetch requests
  let scanPollingInterval = null; // Interval ID for scan status polling
  let sseEventSource = null; // Variable to hold the EventSource instance
  let hasScanRunThisSession = false; // Flag to track if scan initiated in this session
  let pendingPage = null; // Track in-flight pagination requests
  let infiniteScrollObserver = null;
  let preloadObserver = null;
  let overlayOpenTimer = null;
  let overlayCloseTimer = null;
  const parsedCardTiltMax = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--card-hover-rotate-max'));
  const cardTiltMaxDegrees = Number.isFinite(parsedCardTiltMax) ? parsedCardTiltMax : 5;
  let activeTiltCard = null;
  let pendingTiltCard = null;
  let pendingTiltX = 0;
  let pendingTiltY = 0;
  let tiltAnimationFrameId = null;
  
  // Video overlay variables
  let overlayPlyrPlayer = null; // Plyr instance for overlay
  let overlayCurrentVideoId = null; // Current video ID in overlay
  let overlayVideoMetadata = null; // Current video metadata
  let overlayBaseShareUrl = null; // Base share URL for current video
  const OVERLAY_OPEN_TRANSITION_MS = 240;
  const OVERLAY_CLOSE_TRANSITION_MS = 180;

  /**
   * Debounce function
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function nextFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function isCoarsePointerDevice() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  }

  function canUseInteractiveCardTilt() {
    if (document.body.classList.contains('low-effects')) {
      return false;
    }
    return !isCoarsePointerDevice();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function resetCardTilt(card) {
    if (!card) return;
    card.style.setProperty('--card-rotate-x', '0deg');
    card.style.setProperty('--card-rotate-y', '0deg');
    card.classList.remove('is-tilting');
  }

  function clearActiveCardTilt() {
    if (tiltAnimationFrameId) {
      window.cancelAnimationFrame(tiltAnimationFrameId);
      tiltAnimationFrameId = null;
    }
    pendingTiltCard = null;
    if (activeTiltCard) {
      resetCardTilt(activeTiltCard);
      activeTiltCard = null;
    }
  }

  function updateCardTilt(card, clientX, clientY) {
    if (!card) return;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      resetCardTilt(card);
      return;
    }

    const normalizedX = clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    const normalizedY = clamp(((clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
    const rotateX = (-normalizedY * cardTiltMaxDegrees).toFixed(2);
    const rotateY = (normalizedX * cardTiltMaxDegrees).toFixed(2);

    card.style.setProperty('--card-rotate-x', `${rotateX}deg`);
    card.style.setProperty('--card-rotate-y', `${rotateY}deg`);
    card.classList.add('is-tilting');
  }

  function queueCardTilt(card, clientX, clientY) {
    pendingTiltCard = card;
    pendingTiltX = clientX;
    pendingTiltY = clientY;

    if (tiltAnimationFrameId) {
      return;
    }

    tiltAnimationFrameId = window.requestAnimationFrame(() => {
      tiltAnimationFrameId = null;
      if (!pendingTiltCard) {
        return;
      }

      if (activeTiltCard && activeTiltCard !== pendingTiltCard) {
        resetCardTilt(activeTiltCard);
      }

      activeTiltCard = pendingTiltCard;
      updateCardTilt(activeTiltCard, pendingTiltX, pendingTiltY);
    });
  }

  function clearTouchActiveCards() {
    if (!videosGrid) return;
    videosGrid.querySelectorAll('.video-card.is-touch-active').forEach((card) => {
      card.classList.remove('is-touch-active');
    });
  }

  function handleVideoGridPointerMove(event) {
    if (!videosGrid) return;
    if (!canUseInteractiveCardTilt()) {
      clearActiveCardTilt();
      return;
    }

    const card = event.target.closest('.video-card');
    if (!card || !videosGrid.contains(card)) {
      clearActiveCardTilt();
      return;
    }

    queueCardTilt(card, event.clientX, event.clientY);
  }

  function handleVideoGridPointerLeave(event) {
    if (!videosGrid) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget && videosGrid.contains(nextTarget)) {
      return;
    }
    clearActiveCardTilt();
  }

  function handleVideoGridPointerDown(event) {
    if (!videosGrid || !isCoarsePointerDevice()) {
      return;
    }

    const card = event.target.closest('.video-card');
    if (!card || !videosGrid.contains(card)) {
      return;
    }

    clearTouchActiveCards();
    card.classList.add('is-touch-active');
  }

  function handleVideoGridPointerUpOrCancel(event) {
    if (!videosGrid || !isCoarsePointerDevice()) {
      return;
    }

    const card = event.target.closest('.video-card');
    if (card && videosGrid.contains(card)) {
      card.classList.remove('is-touch-active');
    } else {
      clearTouchActiveCards();
    }
  }

  /**
   * Abort any ongoing fetch request
   */
  function abortPreviousFetch() {
    if (currentAbortController) {
      currentAbortController.abort();
      console.log('Aborted previous fetch request.');
    }
  }
  

  /**
   * Toggle low-effects mode based on user preference and media queries
   */
  function applyLowEffectsModeIfNeeded() {
    if (typeof window === 'undefined') {
      return;
    }

    const effectsConfig = window.VideoUIEffects || {};
    window.VideoUIEffects = effectsConfig;

    const supportsMatchMedia = typeof window.matchMedia === 'function';
    const reduceMotionQuery = supportsMatchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduceTransparencyQuery = null;
    if (supportsMatchMedia) {
      try {
        reduceTransparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');
      } catch (error) {
        reduceTransparencyQuery = null;
      }
    }

    const safeGetItem = (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch (storageError) {
        return null;
      }
    };

    const safeSetItem = (key, value) => {
      try {
        if (typeof value === 'string') {
          window.localStorage.setItem(key, value);
        } else {
          window.localStorage.removeItem(key);
        }
      } catch (storageError) {
        // Ignore storage failures (private mode, etc.)
      }
    };

    const updateLowEffectsClass = () => {
      const storedPreference = safeGetItem('vod-low-effects');
      let shouldEnable = false;

      if (storedPreference === 'true') {
        shouldEnable = true;
      } else if (storedPreference === 'false') {
        shouldEnable = false;
      } else {
        // Auto-enable when system preferences or device/network constraints suggest lower effects.
        const reduceMotion = reduceMotionQuery && reduceMotionQuery.matches;
        const reduceTransparency = reduceTransparencyQuery && reduceTransparencyQuery.matches;
        const hasNavigator = typeof navigator !== 'undefined';
        const lowMemoryDevice = hasNavigator && typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
        const constrainedConnection = hasNavigator &&
          navigator.connection &&
          (navigator.connection.saveData || ['slow-2g', '2g'].includes(navigator.connection.effectiveType));
        shouldEnable = Boolean(
          reduceMotion ||
          reduceTransparency ||
          effectsConfig.forceLowEffects ||
          (lowMemoryDevice && constrainedConnection)
        );
      }

      document.body.classList.toggle('low-effects', shouldEnable);
      effectsConfig.lowEffectsEnabled = shouldEnable;
    };

    /**
     * Enable low effects mode programmatically
     */
    const enableLowEffectsMode = () => {
      const effectsConfig = window.VideoUIEffects || {};
      if (!effectsConfig.lowEffectsEnabled) {
        safeSetItem('vod-low-effects', 'true');
        document.body.classList.add('low-effects');
        effectsConfig.lowEffectsEnabled = true;
        console.log('[Performance] Low effects mode enabled for better performance');
      }
    };

    // Make enableLowEffectsMode globally accessible
    window.enableLowEffectsMode = enableLowEffectsMode;

    const attachPreferenceListener = (query) => {
      if (!query) return;
      const listener = () => updateLowEffectsClass();
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', listener);
      } else if (typeof query.addListener === 'function') {
        query.addListener(listener);
      }
    };

    effectsConfig.setLowEffectsMode = (value) => {
      if (typeof value === 'boolean') {
        safeSetItem('vod-low-effects', value ? 'true' : 'false');
      } else {
        safeSetItem('vod-low-effects');
      }
      updateLowEffectsClass();
    };

    updateLowEffectsClass();
    attachPreferenceListener(reduceMotionQuery);
    attachPreferenceListener(reduceTransparencyQuery);
  }

  /**
   * Delegate click handling within the videos grid
   */
  function handleVideoGridClick(event) {
    if (!videosGrid) return;

    const favoriteIndicator = event.target.closest('.favorite-indicator-grid');
    if (favoriteIndicator && videosGrid.contains(favoriteIndicator)) {
      event.preventDefault();
      event.stopPropagation();

      const videoId = favoriteIndicator.dataset.videoId;
      if (!videoId || !window.VideoUtils || typeof window.VideoUtils.toggleFavorite !== 'function') {
        return;
      }

      const isNowFavorited = window.VideoUtils.toggleFavorite(videoId);
      favoriteIndicator.classList.toggle('favorited', isNowFavorited);

      const videoIndex = allVideos.findIndex(v => v.id.toString() === videoId);
      if (videoIndex > -1) {
        allVideos[videoIndex].is_favorite = isNowFavorited ? 1 : 0;
      }

      showToast(isNowFavorited ? 'Added to favorites' : 'Removed from favorites');
      return;
    }

    const link = event.target.closest('.video-card-link');
    if (!link || !videosGrid.contains(link)) {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      // Allow native browser behavior for modified clicks
      return;
    }

    const card = link.closest('.video-card');
    if (!card) {
      return;
    }

    const videoId = card.dataset.id;
    if (!videoId) {
      return;
    }

    event.preventDefault();
    openVideoOverlay(videoId, event);
  }

  /**
   * Handle auxiliary clicks (e.g., middle mouse button) on the videos grid
   */
  function handleVideoGridAuxClick(event) {
    if (event.button !== 1 || !videosGrid) {
      return;
    }

    const link = event.target.closest('.video-card-link');
    if (!link || !videosGrid.contains(link)) {
      return;
    }

    event.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  }

  /**
   * Prevent middle-click auto-scroll on card links
   */
  function handleVideoGridMouseDown(event) {
    if (event.button !== 1 || !videosGrid) {
      return;
    }

    const link = event.target.closest('.video-card-link');
    if (link && videosGrid.contains(link)) {
      event.preventDefault();
    }
  }


  /**
   * Load videos from the API with pagination
   */
  async function loadVideos(page = 1, append = false) {
    if (isLoading) return;
    if (append && pendingPage === page) return;
    
    abortPreviousFetch(); // Abort previous request if any
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    pendingPage = page;

    isLoading = true;
    loadingIndicator.style.display = 'block';
    if (!append) {
        videosGrid.innerHTML = ''; // Clear grid only if not appending (i.e., page 1 or new search/sort)
        allVideos = []; // Reset the local video cache
    }

    try {
      let response;
      
      if (useAdvancedSearch && searchQuery) {
        // Use advanced search endpoint
        response = await fetch('/api/videos/advanced-search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: searchQuery,
            page: page,
            limit: limit
          }),
          signal
        });
      } else {
        // Use regular search endpoint
        let url = `/api/videos?page=${page}&limit=${limit}&sort=${sortBy}`; // Include sort
        if (searchQuery) {
          url += `&search=${encodeURIComponent(searchQuery)}`;
        }
        response = await fetch(url, { signal });
      }
      
      if (!response.ok) {
        // Check if this is an advanced search failure that should fallback
        if (useAdvancedSearch && searchQuery && (response.status === 503 || response.status >= 500)) {
          try {
            const errorData = await response.json();
            if (errorData.fallback) {
              console.warn('Advanced search failed, falling back to regular search');
              // Retry with regular search
              useAdvancedSearch = false;
              if (advancedSearchToggle) advancedSearchToggle.checked = false;
              return loadVideos(page, append);
            }
          } catch (parseError) {
            // Continue with regular error handling
          }
        }
        
        if (response.status === 404 && searchQuery) { // Handle no search results gracefully
             if (!append) videosGrid.innerHTML = '<div class="loading">No videos found matching your search.</div>';
             totalPages = 0;
             totalVideos = 0;
             return; // Exit early
        }
        throw new Error(`Failed to fetch videos (status: ${response.status})`);
      }
      
      const data = await response.json();
      
      // Update state from response
      limit = data.limit;
      totalVideos = data.totalCount;
      totalPages = Math.ceil(totalVideos / limit);
      currentPage = data.page;
      
      const newVideos = data.videos;
      allVideos = append ? [...allVideos, ...newVideos] : newVideos; // Append or replace local cache

      if (allVideos.length === 0 && !append) {
         videosGrid.innerHTML = '<div class="loading">No videos found. Add videos to your library folder.</div>';
      } else {
         await renderVideos(newVideos, append); // Render only the newly fetched videos if appending
      }

    } catch (error) {
       if (error.name === 'AbortError') {
         console.log('Fetch aborted');
       } else {
         console.error('Error loading videos:', error);
         if (!append) videosGrid.innerHTML = '<div class="loading">Error loading videos. Please try again.</div>';
       }
    } finally {
      isLoading = false;
      pendingPage = null;
      loadingIndicator.style.display = 'none';
      currentAbortController = null; // Clear the controller
      updateInfiniteScrollObserverState();
    }
  }

  /**
   * Handle search input with debouncing
   */
  function handleSearchInput(event) {
    searchQuery = event.target.value.trim();
    
    // Skip auto-triggering for advanced search - require button press
    if (useAdvancedSearch) {
      return; // Don't auto-search in advanced mode
    }
    
    const searchIcon = document.querySelector('.search-icon');
    if (searchIcon) searchIcon.classList.add('searching');
    
    if (searchTimeout) clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(() => {
      currentPage = 1; // Reset to first page for new search
      loadVideos(currentPage, false).finally(() => { // Fetch page 1, don't append
         if (searchIcon) searchIcon.classList.remove('searching');
      });
    }, 300); // 300ms debounce
  }

  /**
   * Handle search button click (for advanced search)
   */
  function handleSearchButtonClick() {
    searchQuery = searchInput.value.trim();
    
    if (!searchQuery && !useAdvancedSearch) {
      // For regular search, allow empty query to show all videos
      searchQuery = '';
    }
    
    const searchIcon = document.querySelector('.search-icon');
    if (searchButton) searchButton.classList.add('searching');
    if (searchIcon) searchIcon.classList.add('searching');
    
    currentPage = 1; // Reset to first page for new search
    loadVideos(currentPage, false).finally(() => { // Fetch page 1, don't append
      if (searchButton) searchButton.classList.remove('searching');
      if (searchIcon) searchIcon.classList.remove('searching');
    });
  }

  /**
   * Update the scan status UI element
   */
  function updateScanStatusUI(statusData) {
    // Only update UI if a scan has been initiated in this session
    if (!hasScanRunThisSession) return; 
    
    if (!scanStatusElement) return;

    scanStatusElement.style.display = 'block'; // Make sure element is visible

    let statusText = '';
    let statusClass = '';

    switch (statusData.status) {
      case 'running':
        statusText = `Scanning... (${statusData.message || ''})`;
        statusClass = 'running';
        refreshBtn.disabled = true; // Disable refresh while running
        break;
      case 'completed':
        statusText = `Scan ${statusData.status}: ${statusData.message || 'Finished.'}`;
        statusClass = 'completed';
        resetRefreshButtonState(); // Re-enable button
        break;
      case 'failed':
        statusText = `Scan ${statusData.status}: ${statusData.message || 'An error occurred.'}`;
        statusClass = 'failed';
        resetRefreshButtonState(); // Re-enable button
        break;
      case 'idle':
      default:
        statusText = ''; // Hide if idle
        statusClass = 'idle';
        resetRefreshButtonState(); // Ensure button is enabled
        break;
    }

    scanStatusElement.textContent = statusText;
    scanStatusElement.className = `scan-status ${statusClass}`; // Update class for styling

    // Stop polling if completed or failed
    if ((statusData.status === 'completed' || statusData.status === 'failed') && scanPollingInterval) {
      clearInterval(scanPollingInterval);
      scanPollingInterval = null;
      console.log(`Scan status polling stopped (${statusData.status}).`);
      // Optionally reload videos after a successful scan completes
      if (statusData.status === 'completed') {
          showToast('Scan complete. Reloading video list...');
          setTimeout(() => {
              currentPage = 1;
              loadVideos(currentPage, false);
          }, 1500); // Short delay before reloading
      }
    }
  }

  /**
   * Poll the backend for scan status
   */
  async function pollScanStatus() {
    if (scanPollingInterval) {
      // Already polling
      return;
    }

    console.log('Starting scan status polling...');

    const fetchAndUpdateStatus = async () => {
      try {
        const response = await fetch('/api/scan/status');
        if (!response.ok) {
          throw new Error(`Failed to fetch scan status: ${response.status}`);
        }
        const statusData = await response.json();
        updateScanStatusUI(statusData);
      } catch (error) {
        console.error('Error polling scan status:', error);
        // Optionally update UI to show polling error
        if (scanStatusElement) {
            scanStatusElement.textContent = 'Error fetching scan status.';
            scanStatusElement.className = 'scan-status failed';
        }
        // Stop polling on error to prevent spamming logs/network
        if (scanPollingInterval) {
          clearInterval(scanPollingInterval);
          scanPollingInterval = null;
          console.log('Scan status polling stopped due to error.');
          resetRefreshButtonState(); // Ensure button is usable
        }
      }
    };

    // Fetch immediately first time
    await fetchAndUpdateStatus();

    // Then set interval if not already completed/failed
    const currentStatus = scanStatusElement.className.includes('completed') || scanStatusElement.className.includes('failed');
    if (!currentStatus) {
        scanPollingInterval = setInterval(fetchAndUpdateStatus, 5000); // Poll every 5 seconds
    } else {
        console.log('Scan already completed/failed, not starting interval polling.');
    }
  }

  /**
   * Handle favorites toggle change
   * NOTE: This currently filters only the *loaded* videos.
   * For full filtering, backend changes would be needed.
   */
  function handleFavoritesToggle(event) {
    showOnlyFavorites = event.target.checked;
    // Re-render based on the currently loaded 'allVideos' array
    videosGrid.innerHTML = ''; // Clear grid before re-rendering filtered list
    renderVideos(allVideos, false); // Render the filtered subset of loaded videos
  }

  /**
   * Handle advanced search toggle
   */
  function handleAdvancedSearchToggle(event) {
    useAdvancedSearch = event.target.checked;
    const searchContainer = searchInput.parentElement;
    
    // Update search input placeholder to indicate advanced mode
    if (useAdvancedSearch) {
      searchInput.placeholder = "Describe what you're looking for (e.g., 'find Cinderbrew Meadery with Evandis deaths')...";
      searchContainer.classList.add('advanced-mode');
      // Show search button for advanced mode
      if (searchButton) searchButton.style.display = 'flex';
    } else {
      searchInput.placeholder = "Search videos...";
      searchContainer.classList.remove('advanced-mode');
      // Hide search button for regular mode
      if (searchButton) searchButton.style.display = 'none';
    }
    
    // If there's a current search query, re-run the search with the new mode
    if (searchQuery) {
      currentPage = 1; // Reset to first page
      loadVideos(currentPage, false); // Re-search with the new mode
    }
  }

  /**
   * Handle Enter key press in search input
   */
  function handleSearchKeyPress(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSearchButtonClick();
    }
  }

  /**
   * Creates a video card DOM element.
   * @param {object} video - The video object.
   * @param {object} options - Rendering options.
   * @returns {HTMLElement} The video card element.
   */
  function createVideoCardElement(video, options = {}) {
      const {
        animate = true,
        highPriorityThumbnail = false
      } = options;
      const videoCard = document.createElement('div');
      videoCard.className = 'video-card';
      videoCard.dataset.id = video.id;

      const isFavorited = VideoUtils.isFavorite(video.id.toString()); // Use VideoUtils explicitly
      // Ensure duration is formatted, using utility if needed
      const durationFormatted = video.duration_formatted || (window.VideoUtils && typeof window.VideoUtils.formatDuration === 'function' ? window.VideoUtils.formatDuration(video.duration) : `${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')}`);
      const thumbnailSrc = video.thumbnail_path || getPlaceholderThumbnail();
      const imageLoading = highPriorityThumbnail ? 'eager' : 'lazy';
      const imageFetchPriority = highPriorityThumbnail ? 'high' : 'auto';

      // --- Outcome Indicator Logic ---
      let outcomeStatus = 'neutral';
      const titleLower = video.title.toLowerCase();
      const successKeywords = ['kill'];
      const failureKeywords = ['wipe', 'abandoned', 'deplete'];
      // Updated regex to match +<number> optionally enclosed in parentheses, e.g., (+1) or +1
      const successPatternRegex = /\(\+\d+\)|\+\d+/;

      // Prioritize failure keywords
      if (failureKeywords.some(kw => titleLower.includes(kw))) {
          outcomeStatus = 'failure';
      } 
      // Only check for success if no failure keyword was found
      else if (successPatternRegex.test(video.title) || successKeywords.some(kw => titleLower.includes(kw))) {
          outcomeStatus = 'success';
      }
      // Otherwise, it remains 'neutral'

      let outcomeIndicatorHTML = '';
      if (outcomeStatus === 'success') {
          outcomeIndicatorHTML = '<span class="outcome-indicator success"></span>';
      } else if (outcomeStatus === 'failure') {
          outcomeIndicatorHTML = '<span class="outcome-indicator failure"></span>';
      }
      // --- End Outcome Indicator Logic ---

      videoCard.innerHTML = `
        <a href="/watch/${video.id}" rel="noopener noreferrer" class="video-card-link">
            <div class="thumbnail-container">
              <img class="thumbnail" src="${thumbnailSrc}" alt="${video.title}" loading="${imageLoading}" decoding="async" fetchpriority="${imageFetchPriority}">
              <div class="duration-badge">${durationFormatted}</div>
              ${outcomeIndicatorHTML}
            </div>
            <div class="video-info">
              <div class="video-title">${video.title}</div>
            </div>
        </a>
        <span class="favorite-indicator-grid ${isFavorited ? 'favorited' : ''}" data-video-id="${video.id}"></span>
      `;
      
      if (animate && !document.body.classList.contains('low-effects')) {
        videoCard.classList.add('card-enter');
        videoCard.addEventListener('animationend', () => {
          videoCard.classList.remove('card-enter');
        }, { once: true });
      }

      // Cache metadata using the preloader utility if available
      if (window.VideoPreloader && typeof window.VideoPreloader.cacheVideoMetadata === 'function') {
         window.VideoPreloader.cacheVideoMetadata(video.id, video);
      }

      // Add preview functionality if preview manager is available
      if (videoPreviewManager) {
        videoPreviewManager.attachPreviewListeners(videoCard, video.id.toString());
        videoPreviewManager.setupPreviewObserver(videoCard);
      }

      return videoCard;
  }
  
  /**
   * Render videos in the grid
   * @param {Array} videosToRender - Array of video objects to render
   * @param {boolean} append - Whether to append to the grid or replace its content
   */
  async function renderVideos(videosToRender, append = false) {
    let displayedVideos = videosToRender;
    
    // Apply favorite filtering *only* to the videos being rendered in this batch
    if (showOnlyFavorites) {
      const favoriteIds = VideoUtils.getFavorites(); // Use VideoUtils explicitly
      displayedVideos = videosToRender.filter(video => favoriteIds.includes(video.id.toString()));
    }

    // If appending, check if the filtered list for this batch is empty
    if (append && displayedVideos.length === 0) {
        // Don't show "no videos" message if just appending an empty filtered batch
        updateInfiniteScrollObserverState();
        return;
    }
    
    // If not appending (page 1 / new search / sort) and filtered list is empty
    if (!append && displayedVideos.length === 0) {
      if (showOnlyFavorites) {
        videosGrid.innerHTML = '<div class="loading">No favorite videos found. Add videos to your favorites while watching them.</div>';
      } else if (searchQuery) {
         videosGrid.innerHTML = '<div class="loading">No videos found matching your search.</div>';
      } else {
        videosGrid.innerHTML = '<div class="loading">No videos found. Add videos to your library folder.</div>';
      }
      return;
    }
    
    // If not appending, clear the grid first
    if (!append) {
        videosGrid.innerHTML = '';
    }

    const chunkSize = 8;
    const baseIndex = append ? videosGrid.querySelectorAll('.video-card').length : 0;

    for (let start = 0; start < displayedVideos.length; start += chunkSize) {
      const fragment = document.createDocumentFragment();
      const chunk = displayedVideos.slice(start, start + chunkSize);

      chunk.forEach((video, index) => {
        const overallIndex = baseIndex + start + index;
        const isFirstViewportBatch = !append && overallIndex < 6;
        const videoCard = createVideoCardElement(video, {
          animate: !append,
          highPriorityThumbnail: isFirstViewportBatch
        });
        fragment.appendChild(videoCard);
      });

      videosGrid.appendChild(fragment);
      setupPreloading(); // Setup preloading for newly added cards

      if (start + chunkSize < displayedVideos.length) {
        await nextFrame();
      }
    }

    updateInfiniteScrollObserverState();
  }
  
  /**
   * Set up preloading for video cards currently in the DOM
   */
  function setupPreloading() {
    const videoCards = videosGrid.querySelectorAll('.video-card:not(.preload-observed)'); // Select only cards not yet observed
    
    if (videoCards.length === 0) return; // No new cards to setup

    const cacheApiAvailable = typeof caches !== 'undefined';
    
    if (!cacheApiAvailable && !document.body.classList.contains('limited-preloading')) {
      console.log('Cache API not available, using limited preloading functionality');
      document.body.classList.add('limited-preloading');
      if (!document.querySelector('.preload-info-message')) {
        const infoMessage = document.createElement('div');
        infoMessage.className = 'preload-info-message';
        infoMessage.textContent = 'Limited preloading available in this browser';
        document.querySelector('.videos-header').appendChild(infoMessage);
      }
    }

    if (!preloadObserver) {
      preloadObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const videoId = entry.target.dataset.id;
            if (window.VideoPreloader && typeof window.VideoPreloader.preloadSegment === 'function') {
              window.VideoPreloader.preloadSegment(videoId, 0, 'low')
                .then(success => { if (success) entry.target.classList.add('preloaded'); })
                .catch(error => { console.warn(`Error preloading segment 0 for video ${videoId}:`, error); });
            }
            preloadObserver.unobserve(entry.target); // Preload only once on intersection
          }
        });
      }, { rootMargin: '200px', threshold: 0.1 });
    }

    const debouncedPreload = debounce((cardElement, id) => {
      if (window.VideoPreloader && typeof window.VideoPreloader.preloadSegments === 'function') {
        window.VideoPreloader.preloadSegments(id, 2, 'low') // Preload first 2 segments on hover
          .then(results => { if (results && results.some(success => success)) cardElement.classList.add('preloaded'); })
          .catch(error => { console.warn(`Error preloading segments on hover for video ${id}:`, error); });
      }
    }, 300); // 300ms debounce delay

    const shouldAttachHoverPreload = !document.body.classList.contains('low-effects');

    videoCards.forEach(card => {
      const videoId = card.dataset.id;
      if (shouldAttachHoverPreload) {
        card.addEventListener('mouseenter', () => debouncedPreload(card, videoId));
      }
      preloadObserver.observe(card);
      card.classList.add('preload-observed'); // Mark card as observed
    });
  }

  function loadNextPageIfNeeded() {
    if (isLoading || currentPage >= totalPages) {
      return;
    }

    const nextPage = currentPage + 1;
    if (pendingPage === nextPage) {
      return;
    }

    loadVideos(nextPage, true);
  }

  function updateInfiniteScrollObserverState() {
    if (!videosLoadSentinel) {
      return;
    }

    const isAtEnd = currentPage >= totalPages;
    videosLoadSentinel.classList.toggle('is-idle', isAtEnd);
    videosLoadSentinel.setAttribute('aria-hidden', isAtEnd ? 'true' : 'false');
  }

  const handleInfiniteScroll = debounce(() => {
    if (isLoading || currentPage >= totalPages) {
      return;
    }

    const scrollThreshold = 1200;
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (scrollPosition >= documentHeight - scrollThreshold) {
      loadNextPageIfNeeded();
    }
  }, 100);

  function initializeInfiniteScroll() {
    if (!videosLoadSentinel) {
      return;
    }

    if ('IntersectionObserver' in window) {
      infiniteScrollObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            loadNextPageIfNeeded();
          }
        });
      }, { root: null, rootMargin: '1200px 0px', threshold: 0 });

      infiniteScrollObserver.observe(videosLoadSentinel);
    } else {
      window.addEventListener('scroll', handleInfiniteScroll, { passive: true });
    }

    updateInfiniteScrollObserverState();
  }
  
  /**
   * Handle sort change
   */
  function handleSortChange(event) {
    sortBy = event.target.value;
    currentPage = 1; // Reset to first page
    loadVideos(currentPage, false); // Fetch page 1 with new sort, don't append
  }

  /**
   * Resets the refresh button to its default state
   */
  function resetRefreshButtonState() {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
        <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
      </svg>
      Refresh Videos
    `;
  }
  
  /**
   * Refresh the video library by initiating a scan
   */
  async function refreshLibrary() {
    // Check if scan is already running via UI state or a quick API check?
    // For simplicity, we rely on the backend to prevent concurrent scans for now.
    // We disable the button immediately based on the UI state from polling.
    if (refreshBtn.disabled) {
        console.log('Refresh button is disabled (scan likely running).');
         return;
     }
 
     hasScanRunThisSession = true; // Set the flag when scan is initiated
     try {
       // Disable button immediately and show initiating state
       refreshBtn.disabled = true;
      refreshBtn.innerHTML = `
        <svg class="spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
          <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
        </svg>
        Initiating Scan...
      `;
      // Update status element immediately for responsiveness
      if (scanStatusElement) {
          scanStatusElement.textContent = 'Initiating Scan...';
          scanStatusElement.className = 'scan-status running';
      }

      // Use POST for the refresh endpoint
      const response = await fetch('/api/refresh', { method: 'POST' }); 
      
      if (!response.ok) {
         // Handle non-2xx responses, e.g., 500 if initiation failed
         const errorData = await response.json().catch(() => ({ error: 'Failed to initiate scan' }));
         throw new Error(errorData.error || `Failed to initiate scan (status: ${response.status})`);
      }
      
      // Response status 202 Accepted indicates scan was initiated
      if (response.status === 202) {
          showToast('Library scan initiated.');
          // Start polling for status updates
          pollScanStatus(); 
      } else {
          // Handle unexpected success codes if necessary
          console.warn('Unexpected response status after initiating scan:', response.status);
          // Still attempt to poll
          pollScanStatus();
      }

    } catch (error) {
      console.error('Error initiating library scan:', error);
      resetRefreshButtonState(); // Re-enable button on initiation error
      showToast(`Error: ${error.message || 'Failed to initiate scan.'}`, 'error');
      if (scanStatusElement) {
          scanStatusElement.textContent = 'Failed to initiate scan.';
          scanStatusElement.className = 'scan-status failed';
      }
    }
    // Note: Button state is now managed by polling logic (updateScanStatusUI)
  }

  /**
   * Connect to the Server-Sent Events endpoint
   */
  function connectSSE() {
    if (sseEventSource) {
      sseEventSource.close(); // Close existing connection if any
    }

    console.log('Connecting to SSE endpoint...');
    sseEventSource = new EventSource('/api/updates');

    sseEventSource.onopen = () => {
      console.log('SSE connection established.');
    };

    sseEventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      // Optionally implement reconnection logic here
      sseEventSource.close(); // Close on error
      // Attempt to reconnect after a delay
      setTimeout(connectSSE, 5000); // Reconnect after 5 seconds
    };

    sseEventSource.addEventListener('connected', (event) => {
        const data = JSON.parse(event.data);
        console.log('SSE connected event received:', data);
    });

    // Listen for custom 'update' events (or just use the default 'message' event)
    sseEventSource.onmessage = (event) => {
      try {
        const updateData = JSON.parse(event.data);
        console.log('SSE message received:', updateData);

        if (updateData.type === 'add') {
          handleSseAddVideo(updateData.video);
        } else if (updateData.type === 'delete') {
          handleSseDeleteVideo(updateData.videoId);
        }
      } catch (error) {
        console.error('Error parsing SSE message data:', error);
      }
    };
  }

  /**
   * Handle adding a video via SSE
   */
  function handleSseAddVideo(newVideo) {
    // Check if video already exists in the DOM (e.g., due to race condition)
    if (videosGrid.querySelector(`.video-card[data-id="${newVideo.id}"]`)) {
      console.log(`SSE Add: Video ${newVideo.id} already exists in DOM, skipping.`);
      return;
    }

    // Add to the local cache if not already present
    const existsInCache = allVideos.some(v => v.id === newVideo.id);
    if (!existsInCache) {
        allVideos.unshift(newVideo); // Add to the beginning of the local cache
        totalVideos++; // Increment total count
    }

    // Create and prepend the new video card element
    // Format duration if needed (assuming utils are loaded)
    newVideo.duration_formatted = window.VideoUtils.formatDuration(newVideo.duration);
    const videoCard = createVideoCardElement(newVideo, {
      animate: !document.body.classList.contains('low-effects'),
      highPriorityThumbnail: false
    });
    videosGrid.prepend(videoCard); // Add to the beginning of the grid

    // Setup preloading for the new card
    setupPreloading();
    updateInfiniteScrollObserverState();

    // Remove "No videos found" message if it exists
    const noVideosMessage = videosGrid.querySelector('.loading');
    if (noVideosMessage && noVideosMessage.textContent.includes('No videos found')) {
        noVideosMessage.remove();
    }

    showToast(`Video added: ${newVideo.title}`);
  }

  /**
   * Handle deleting a video via SSE
   */
  function handleSseDeleteVideo(videoId) {
    // Remove from the local cache
    const initialLength = allVideos.length;
    allVideos = allVideos.filter(v => v.id !== videoId);
    if (allVideos.length < initialLength) {
        totalVideos--; // Decrement total count if removed from cache
    }

    // Remove the card from the DOM
    const videoCard = videosGrid.querySelector(`.video-card[data-id="${videoId}"]`);
    if (videoCard) {
      // Clean up preview functionality
      if (videoPreviewManager) {
        videoPreviewManager.removePreviewListeners(videoCard);
        videoPreviewManager.hidePreview(videoCard, videoId);
      }
      
      videoCard.classList.add('fade-out'); // Add fade-out animation
      videoCard.addEventListener('animationend', () => {
          videoCard.remove();
          // Add "No videos" message if grid becomes empty
          if (videosGrid.children.length === 0) {
              videosGrid.innerHTML = '<div class="loading">No videos found. Add videos to your library folder.</div>';
          }
      }, { once: true });
      showToast(`Video removed.`);
    } else {
        console.log(`SSE Delete: Video card ${videoId} not found in DOM.`);
    }
  }

  /**
   * Keep native browser scrolling for input responsiveness and lower scroll jitter.
   */
  function initializeGsapSmoothScroll() {
    console.log('[Performance] Native scrolling enabled.');
  }

  /**
   * Video Overlay Functions
   */

  // FPS monitoring for overlay performance
  let overlayFPSMonitor = null;

  /**
   * Start FPS monitoring for overlay video performance
   * @param {HTMLVideoElement} videoElement - The video element to monitor
   */
  function startOverlayFPSMonitoring(videoElement) {
    if (!videoElement || !('requestVideoFrameCallback' in videoElement)) {
      console.warn('[Performance] requestVideoFrameCallback not supported, FPS monitoring disabled');
      return;
    }

    stopOverlayFPSMonitoring(); // Stop any existing monitoring

    const monitor = {
      frameCount: 0,
      lastTime: performance.now(),
      startTime: performance.now(),
      sampleCount: 0,
      totalFPS: 0,
      minFPS: Infinity,
      maxFPS: 0,
      belowThreshold: 0,
      element: videoElement,
      callbackId: null,
      isActive: true
    };

    const fpsCallback = (now, metadata) => {
      if (!monitor.isActive) return;

      monitor.frameCount++;
      const elapsed = now - monitor.lastTime;

      // Calculate FPS every 1 second
      if (elapsed >= 1000) {
        const fps = Math.round((monitor.frameCount * 1000) / elapsed);
        monitor.frameCount = 0;
        monitor.lastTime = now;
        monitor.sampleCount++;
        monitor.totalFPS += fps;
        monitor.minFPS = Math.min(monitor.minFPS, fps);
        monitor.maxFPS = Math.max(monitor.maxFPS, fps);

        if (fps < 30) {
          monitor.belowThreshold++;
        }

        // Log FPS periodically for debugging
        if (monitor.sampleCount % 5 === 0) {
          const avgFPS = Math.round(monitor.totalFPS / monitor.sampleCount);
          console.log(`[Performance] Overlay FPS - Current: ${fps}, Avg: ${avgFPS}, Min: ${monitor.minFPS}, Max: ${monitor.maxFPS}, Below 30fps: ${monitor.belowThreshold}/${monitor.sampleCount} samples`);
        }

        // Auto-enable low effects if performance is consistently poor
        if (monitor.sampleCount >= 3 && monitor.belowThreshold / monitor.sampleCount >= 0.6) {
          const effectsConfig = window.VideoUIEffects || {};
          if (!effectsConfig.lowEffectsEnabled) {
            console.warn('[Performance] Poor overlay performance detected, auto-enabling low effects mode');
            if (window.enableLowEffectsMode) {
              window.enableLowEffectsMode();
            }
          }
        }
      }

      // Continue monitoring
      if (monitor.isActive) {
        monitor.callbackId = videoElement.requestVideoFrameCallback(fpsCallback);
      }
    };

    // Start monitoring
    monitor.callbackId = videoElement.requestVideoFrameCallback(fpsCallback);
    overlayFPSMonitor = monitor;

    console.log('[Performance] Started overlay FPS monitoring');
  }

  /**
   * Stop FPS monitoring for overlay
   */
  function stopOverlayFPSMonitoring() {
    if (overlayFPSMonitor) {
      overlayFPSMonitor.isActive = false;
      if (overlayFPSMonitor.callbackId && overlayFPSMonitor.element) {
        overlayFPSMonitor.element.cancelVideoFrameCallback(overlayFPSMonitor.callbackId);
      }

      // Log final stats
      if (overlayFPSMonitor.sampleCount > 0) {
        const avgFPS = Math.round(overlayFPSMonitor.totalFPS / overlayFPSMonitor.sampleCount);
        const duration = Math.round((performance.now() - overlayFPSMonitor.startTime) / 1000);
        console.log(`[Performance] Overlay FPS monitoring stopped - Duration: ${duration}s, Avg FPS: ${avgFPS}, Min: ${overlayFPSMonitor.minFPS}, Max: ${overlayFPSMonitor.maxFPS}`);
      }

      overlayFPSMonitor = null;
    }
  }

  function shouldUseReducedMotion() {
    if (document.body.classList.contains('low-effects')) {
      return true;
    }
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function resetOverlayTransformVariables(overlay) {
    overlay.style.removeProperty('--overlay-origin-translate-x');
    overlay.style.removeProperty('--overlay-origin-translate-y');
    overlay.style.removeProperty('--overlay-origin-scale');
  }

  function setOverlayOriginFromEvent(overlay, event) {
    if (!event || !event.target || shouldUseReducedMotion()) {
      overlay.classList.remove('has-origin');
      resetOverlayTransformVariables(overlay);
      return;
    }

    const card = event.target.closest && event.target.closest('.video-card');
    if (!card) {
      overlay.classList.remove('has-origin');
      resetOverlayTransformVariables(overlay);
      return;
    }

    const cardRect = card.getBoundingClientRect();
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    const cardCenterX = cardRect.left + (cardRect.width / 2);
    const cardCenterY = cardRect.top + (cardRect.height / 2);
    const translateX = cardCenterX - viewportCenterX;
    const translateY = cardCenterY - viewportCenterY;
    const targetWidth = Math.min(window.innerWidth * 0.95, 1450);
    const originScale = Math.max(0.3, Math.min(0.92, cardRect.width / targetWidth));

    overlay.style.setProperty('--overlay-origin-translate-x', `${Math.round(translateX)}px`);
    overlay.style.setProperty('--overlay-origin-translate-y', `${Math.round(translateY)}px`);
    overlay.style.setProperty('--overlay-origin-scale', originScale.toFixed(3));
    overlay.classList.add('has-origin');
  }

  function showOverlayWithTransition(overlay, event) {
    if (overlayOpenTimer) {
      clearTimeout(overlayOpenTimer);
      overlayOpenTimer = null;
    }

    if (overlayCloseTimer) {
      clearTimeout(overlayCloseTimer);
      overlayCloseTimer = null;
    }

    overlay.classList.remove('is-closing');
    setOverlayOriginFromEvent(overlay, event);
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('overlay-open');

    if (!shouldUseReducedMotion()) {
      overlay.classList.add('is-opening');
      overlayOpenTimer = setTimeout(() => {
        overlayOpenTimer = null;
        overlay.classList.remove('is-opening');
        overlay.classList.remove('has-origin');
        resetOverlayTransformVariables(overlay);
      }, OVERLAY_OPEN_TRANSITION_MS);
    } else {
      overlay.classList.remove('has-origin');
      resetOverlayTransformVariables(overlay);
    }
  }

  function finalizeOverlayClose(overlay, updateHistory) {
    if (overlayOpenTimer) {
      clearTimeout(overlayOpenTimer);
      overlayOpenTimer = null;
    }

    overlay.classList.remove('visible');
    overlay.classList.remove('is-opening');
    overlay.classList.remove('is-closing');
    overlay.classList.remove('has-origin');
    overlay.setAttribute('aria-hidden', 'true');
    resetOverlayTransformVariables(overlay);
    document.body.classList.remove('overlay-open');

    if (updateHistory && window.location.pathname !== '/') {
      history.pushState({}, '', '/');
    }

    // Reset page title
    document.title = vodsName;
  }

  /**
   * Open video overlay with specified video ID
   * @param {string} videoId - The ID of the video to open
   * @param {Event} event - Optional event to prevent default behavior
   */
  async function openVideoOverlay(videoId, event, options = {}) {
    const { updateHistory = true } = options;
    if (event) {
      event.preventDefault();
    }

    try {
      // Show loading state
      const overlay = document.getElementById('video-overlay');
      const playerContainer = document.querySelector('.video-overlay-player-container');
      const overlayVideo = document.getElementById('overlay-video-player');
      overlayVideo.classList.remove('is-ready');
      playerContainer.classList.remove('is-video-ready');
      
      // Add loading indicator
      const loadingOverlay = document.createElement('div');
      loadingOverlay.className = 'video-overlay-loading';
      loadingOverlay.innerHTML = '<div class="loading-spinner"></div>';
      playerContainer.appendChild(loadingOverlay);
      
      showOverlayWithTransition(overlay, event);
      
      // Update URL
      if (updateHistory) {
        const newUrl = `/watch/${videoId}`;
        history.pushState({ videoOverlay: true, videoId }, '', newUrl);
      }

      // Suspend preview system to free up resources
      if (videoPreviewManager) {
        videoPreviewManager.pause();
      }

      // Load video metadata
      let video = null;
      try {
        video = await window.VideoPreloader.getCachedMetadata(videoId);
      } catch (error) {
        console.warn('Error getting cached metadata:', error);
      }
      
      if (!video) {
        const response = await fetch(`/api/videos/${videoId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch video');
        }
        video = await response.json();
        
        // Cache for future use
        try {
          await window.VideoPreloader.cacheVideoMetadata(videoId, video);
        } catch (error) {
          console.warn('Error caching video metadata:', error);
        }
      }
      
      // Store current video data
      overlayCurrentVideoId = videoId;
      overlayVideoMetadata = video;
      overlayBaseShareUrl = null; // Reset share URL
      
      // Update overlay UI
      document.getElementById('overlay-video-title').textContent = video.title;
      
      const addedDate = new Date(video.added_date);
      document.getElementById('overlay-video-date').textContent = addedDate.toLocaleDateString();
      document.getElementById('overlay-video-duration').textContent = video.duration_formatted;
      
      // Update page title
      document.title = `${vodsName} - ${video.title}`;
      
      // Initialize video player
      overlayVideo.src = `/api/videos/${videoId}/stream`;

      const removeLoadingOverlay = () => {
        if (loadingOverlay.parentNode) {
          loadingOverlay.remove();
        }
      };

      const onOverlayReady = () => {
        cleanupOverlayLoadingListeners();
        removeLoadingOverlay();
        playerContainer.classList.add('is-video-ready');
        overlayVideo.classList.add('is-ready');
      };

      const cleanupOverlayLoadingListeners = () => {
        clearTimeout(overlayLoadingFallbackTimeout);
        overlayVideo.removeEventListener('playing', onOverlayReady);
        overlayVideo.removeEventListener('canplay', onOverlayReady);
        overlayVideo.removeEventListener('error', onOverlayReady);
      };

      // Hide loader when playback is actually ready, not on an arbitrary timer.
      overlayVideo.addEventListener('playing', onOverlayReady, { once: true });
      overlayVideo.addEventListener('canplay', onOverlayReady, { once: true });
      overlayVideo.addEventListener('error', onOverlayReady, { once: true });

      // Safety fallback in case media events are delayed/missed.
      const overlayLoadingFallbackTimeout = setTimeout(() => {
        cleanupOverlayLoadingListeners();
        removeLoadingOverlay();
      }, 8000);

      // Initialize Plyr
      initializeOverlayPlayer(video);

      // Start FPS monitoring for performance analysis
      startOverlayFPSMonitoring(overlayVideo);
      
      // Update favorite button state
      updateOverlayFavoriteButton(videoId);
      
      // Focus on close button for accessibility
      setTimeout(() => {
        document.querySelector('.video-overlay-close').focus();
      }, 100);
      
      // Preload additional segments (conditional based on performance)
      preloadOverlaySegments(videoId, overlayVideo);
      
    } catch (error) {
      console.error('Error opening video overlay:', error);
      showToast('Failed to load video. Please try again.', 'error');
      closeVideoOverlay();
    }
  }
  
  /**
   * Close the video overlay
   */
  function closeVideoOverlay(options = {}) {
    const { updateHistory = true } = options;
    const overlay = document.getElementById('video-overlay');
    const playerContainer = document.querySelector('.video-overlay-player-container');

    // Stop FPS monitoring
    stopOverlayFPSMonitoring();

    if (overlayCloseTimer) {
      clearTimeout(overlayCloseTimer);
      overlayCloseTimer = null;
    }

    const animateClose = overlay.classList.contains('visible') && !shouldUseReducedMotion();
    if (animateClose) {
      overlay.classList.remove('visible');
      overlay.classList.add('is-closing');
      overlayCloseTimer = setTimeout(() => {
        overlayCloseTimer = null;
        finalizeOverlayClose(overlay, updateHistory);
      }, OVERLAY_CLOSE_TRANSITION_MS);
    } else {
      finalizeOverlayClose(overlay, updateHistory);
    }

    // Resume preview system
    if (videoPreviewManager) {
      videoPreviewManager.resume();
    }

    // Clean up Plyr player
    if (overlayPlyrPlayer) {
      try {
        overlayPlyrPlayer.pause();
        overlayPlyrPlayer.destroy();
      } catch (error) {
        console.warn('Error destroying Plyr player:', error);
      }
      overlayPlyrPlayer = null;
    }
    
    // Clear video source
    const overlayVideo = document.getElementById('overlay-video-player');
    playerContainer.classList.remove('is-video-ready');
    overlayVideo.classList.remove('is-ready');
    if (overlayVideo.src && overlayVideo.src.startsWith('blob:')) {
      URL.revokeObjectURL(overlayVideo.src);
    }
    overlayVideo.src = '';
    overlayVideo.load();
    
    // Reset state
    overlayCurrentVideoId = null;
    overlayVideoMetadata = null;
    overlayBaseShareUrl = null;
    
    // Remove any loading overlays
    const loadingOverlays = document.querySelectorAll('.video-overlay-loading');
    loadingOverlays.forEach(overlay => overlay.remove());
  }
  
  /**
   * Initialize Plyr player for overlay
   * @param {Object} video - Video metadata object
   */
  function initializeOverlayPlayer(video) {
    // Destroy existing player
    if (overlayPlyrPlayer) {
      try {
        overlayPlyrPlayer.destroy();
      } catch (error) {
        console.warn('Error destroying previous Plyr instance:', error);
      }
    }
    
    const overlayVideo = document.getElementById('overlay-video-player');
    
    // Plyr options (similar to player.js)
    const options = {
      controls: [
        'play-large',
        'play',
        'progress',
        'current-time',
        'duration',
        'mute',
        'volume',
        'captions',
        'settings',
        'pip',
        'airplay',
        'fullscreen'
      ],
      settings: ['captions', 'quality', 'speed', 'loop'],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      keyboard: { focused: true, global: false }, // Disable global shortcuts when in overlay
      tooltips: { controls: true, seek: true },
      autoplay: true
    };
    
    overlayPlyrPlayer = new Plyr(overlayVideo, options);
    
    overlayPlyrPlayer.on('ready', () => {
      console.log('Overlay Plyr player ready');
      
      // Check for timestamp parameter in URL
      const urlParams = new URLSearchParams(window.location.search);
      const startTime = urlParams.get('t');
      if (startTime) {
        const timeInSeconds = parseInt(startTime, 10);
        if (!isNaN(timeInSeconds) && timeInSeconds > 0) {
          setTimeout(() => {
            try {
              overlayPlyrPlayer.currentTime = timeInSeconds;
            } catch (error) {
              console.error('Error seeking to timestamp:', error);
            }
          }, 100);
        }
      }
    });
    
    // Handle metadata loaded for death markers
    overlayPlyrPlayer.on('loadedmetadata', () => {
      if (video.death_timestamps && overlayPlyrPlayer.duration) {
        try {
          const deathTimestamps = JSON.parse(video.death_timestamps);
          if (Array.isArray(deathTimestamps)) {
            displayOverlayDeathMarkers(deathTimestamps, overlayPlyrPlayer.duration);
          }
        } catch (error) {
          console.error('Error parsing death timestamps:', error);
        }
      }
    });
    
    overlayPlyrPlayer.on('error', (event) => {
      console.error('Overlay player error:', event);
      showToast('Error playing video. Please try again.', 'error');
    });
  }
  
  /**
   * Display death markers on overlay player timeline
   * @param {number[]} timestamps - Array of death timestamps in seconds
   * @param {number} duration - Video duration in seconds
   */
  function displayOverlayDeathMarkers(timestamps, duration) {
    if (!duration || duration <= 0 || !timestamps || timestamps.length === 0) {
      return;
    }
    
    const playerContainer = document.querySelector('.video-overlay-player-container');
    const progressTrack = playerContainer.querySelector('.plyr__progress input[type=range]');
    
    let progressElement;
    if (!progressTrack) {
      const progressContainer = playerContainer.querySelector('.plyr__progress__container');
      if (!progressContainer) {
        console.warn('Could not find progress container for death markers');
        return;
      }
      progressElement = progressContainer;
    } else {
      progressElement = progressTrack.parentElement;
    }
    
    // Clear existing markers
    const existingMarkers = progressElement.querySelectorAll('.death-marker');
    existingMarkers.forEach(marker => marker.remove());
    
    // Add new markers
    timestamps.forEach(timestamp => {
      if (timestamp >= 0 && timestamp <= duration) {
        const percentage = (timestamp / duration) * 100;
        const marker = document.createElement('div');
        marker.className = 'death-marker';
        marker.style.left = `${percentage}%`;
        marker.title = `Death at ${formatOverlayTime(timestamp)}`;
        progressElement.appendChild(marker);
      }
    });
  }
  
  /**
   * Format time for overlay display
   * @param {number} seconds - Time in seconds
   * @returns {string} Formatted time string
   */
  function formatOverlayTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const timeString = date.toISOString().substr(11, 8);
    return timeString.startsWith('00:') ? timeString.substr(3) : timeString;
  }
  
  /**
   * Update overlay favorite button state
   * @param {string} videoId - Video ID
   */
  function updateOverlayFavoriteButton(videoId) {
    const favoriteBtn = document.getElementById('overlay-favorite-btn');
    const favoriteText = favoriteBtn.querySelector('.favorite-text');
    const isFavorited = isFavorite(videoId);
    
    if (isFavorited) {
      favoriteBtn.classList.add('active');
      favoriteText.textContent = 'Remove from Favorites';
    } else {
      favoriteBtn.classList.remove('active');
      favoriteText.textContent = 'Add to Favorites';
    }
  }
  
  /**
   * Handle overlay favorite button click
   */
  function handleOverlayFavoriteClick() {
    if (!overlayCurrentVideoId) return;
    
    const isNowFavorited = toggleFavorite(overlayCurrentVideoId);
    updateOverlayFavoriteButton(overlayCurrentVideoId);
    
    showToast(isNowFavorited ? 'Added to favorites' : 'Removed from favorites');
    
    // Update the main grid if this video is visible
    const gridCard = document.querySelector(`.video-card[data-id="${overlayCurrentVideoId}"]`);
    if (gridCard) {
      const gridIndicator = gridCard.querySelector('.favorite-indicator-grid');
      if (gridIndicator) {
        gridIndicator.classList.toggle('favorited', isNowFavorited);
      }
    }
  }
  
  /**
   * Preload segments for overlay video (conditional based on performance)
   * @param {string} videoId - Video ID
   * @param {HTMLVideoElement} videoElement - Video element to check buffering state
   */
  async function preloadOverlaySegments(videoId, videoElement = null) {
    try {
      // Skip preloading if low-effects mode is enabled (indicates constrained system)
      const effectsConfig = window.VideoUIEffects || {};
      if (effectsConfig.lowEffectsEnabled) {
        console.log('[Performance] Skipping segment preloading - low effects mode enabled');
        return;
      }

      // Skip preloading if FPS is poor (system under stress)
      if (overlayFPSMonitor && overlayFPSMonitor.sampleCount >= 2) {
        const avgFPS = overlayFPSMonitor.totalFPS / overlayFPSMonitor.sampleCount;
        if (avgFPS < 40) {
          console.log(`[Performance] Skipping segment preloading - poor FPS (${Math.round(avgFPS)})`);
          return;
        }
      }

      // Check if video is actually buffering/needs preloading
      if (videoElement) {
        const buffered = videoElement.buffered;
        const currentTime = videoElement.currentTime;
        const duration = videoElement.duration;

        // If we have good buffering ahead, skip preloading
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1);
          const bufferedAhead = bufferedEnd - currentTime;

          if (bufferedAhead > 30 || bufferedEnd >= duration * 0.8) {
            console.log(`[Performance] Skipping segment preloading - sufficient buffer (${Math.round(bufferedAhead)}s ahead)`);
            return;
          }
        }
      }

      if (window.VideoPreloader) {
        console.log('[Performance] Starting conditional segment preloading');
        for (let i = 1; i <= 3; i++) {
          try {
            await window.VideoPreloader.preloadSegment(videoId, i);
          } catch (error) {
            console.warn(`Error preloading segment ${i}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('Error preloading overlay segments:', error);
    }
  }
  
  /**
   * Handle browser back/forward navigation
   */
  function handleOverlayPopState(event) {
    const currentPath = window.location.pathname;
    const watchMatch = currentPath.match(/^\/watch\/(\d+)$/);
    
    if (watchMatch) {
      // URL indicates we should show overlay
      const videoId = watchMatch[1];
      if (!overlayCurrentVideoId || overlayCurrentVideoId !== videoId) {
        openVideoOverlay(videoId, null, { updateHistory: false });
      }
    } else {
      // URL indicates we should close overlay
      if (overlayCurrentVideoId) {
        closeVideoOverlay({ updateHistory: false });
      }
    }
  }

  /**
   * Share functionality for overlay
   */
  
  /**
   * Toggle overlay share popover visibility
   */
  function toggleOverlaySharePopover() {
    const sharePopover = document.getElementById('overlay-share-popover');
    const currentTimeDisplay = document.getElementById('overlay-popover-current-time');
    
    const isVisible = sharePopover.classList.toggle('visible');
    
    if (isVisible && overlayPlyrPlayer) {
      const currentTime = Math.round(overlayPlyrPlayer.currentTime);
      currentTimeDisplay.textContent = `Current time: ${formatOverlayTime(currentTime)}`;
    }
  }
  
  /**
   * Copy base share link (without timestamp)
   */
  async function handleOverlayCopyBaseLink() {
    if (!overlayBaseShareUrl) {
      await fetchOverlayBaseShareUrl();
      if (!overlayBaseShareUrl) {
        showToast('Could not get share link.', 'error');
        return;
      }
    }
    
    copyOverlayToClipboard(overlayBaseShareUrl, document.getElementById('overlay-copy-base-link-btn'));
    document.getElementById('overlay-share-popover').classList.remove('visible');
  }
  
  /**
   * Copy timestamped share link
   */
  async function handleOverlayCopyTimestampLink() {
    if (!overlayPlyrPlayer || typeof overlayPlyrPlayer.currentTime === 'undefined') {
      showToast('Player not ready.', 'error');
      return;
    }
    
    if (!overlayBaseShareUrl) {
      await fetchOverlayBaseShareUrl();
      if (!overlayBaseShareUrl) {
        showToast('Could not get share link.', 'error');
        return;
      }
    }
    
    const currentTime = Math.round(overlayPlyrPlayer.currentTime);
    const timestampedUrl = `${overlayBaseShareUrl}?t=${currentTime}`;
    
    copyOverlayToClipboard(timestampedUrl, document.getElementById('overlay-copy-timestamp-link-btn'));
    document.getElementById('overlay-share-popover').classList.remove('visible');
  }
  
  /**
   * Fetch base share URL for current overlay video
   */
  async function fetchOverlayBaseShareUrl() {
    if (overlayBaseShareUrl || !overlayCurrentVideoId) return;
    
    try {
      const response = await fetch(`/api/share/${overlayCurrentVideoId}`);
      if (!response.ok) {
        throw new Error('Failed to generate share link');
      }
      const data = await response.json();
      overlayBaseShareUrl = data.shareLink;
    } catch (error) {
      console.error('Error generating overlay share link:', error);
      overlayBaseShareUrl = null;
    }
  }
  
  /**
   * Copy text to clipboard with feedback
   * @param {string} text - Text to copy
   * @param {HTMLElement} buttonElement - Button that was clicked
   */
  function copyOverlayToClipboard(text, buttonElement) {
    navigator.clipboard.writeText(text).then(() => {
      const originalText = buttonElement.textContent;
      buttonElement.textContent = 'Copied!';
      buttonElement.disabled = true;
      showToast('Link copied to clipboard!', 'success');
      setTimeout(() => {
        buttonElement.textContent = originalText;
        buttonElement.disabled = false;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy text:', err);
      showToast('Failed to copy link.', 'error');
    });
  }

  // Make overlay functions globally available
  window.openVideoOverlay = openVideoOverlay;
  window.closeVideoOverlay = closeVideoOverlay;

  // --- Event Listeners ---
  searchInput.addEventListener('focus', () => searchInput.parentElement.classList.add('focused'));
  searchInput.addEventListener('blur', () => searchInput.parentElement.classList.remove('focused'));
  refreshBtn.addEventListener('click', refreshLibrary);
  sortSelect.addEventListener('change', handleSortChange);
  searchInput.addEventListener('input', handleSearchInput);
  searchInput.addEventListener('keypress', handleSearchKeyPress);
  if (searchButton) {
    searchButton.addEventListener('click', handleSearchButtonClick);
  }
  favoritesToggle.addEventListener('change', handleFavoritesToggle);
  if (advancedSearchToggle) {
    advancedSearchToggle.addEventListener('change', handleAdvancedSearchToggle);
  }
  
  // Video overlay event listeners
  document.getElementById('overlay-favorite-btn').addEventListener('click', handleOverlayFavoriteClick);
  document.getElementById('overlay-share-toggle-btn').addEventListener('click', toggleOverlaySharePopover);
  document.getElementById('overlay-copy-base-link-btn').addEventListener('click', handleOverlayCopyBaseLink);
  document.getElementById('overlay-copy-timestamp-link-btn').addEventListener('click', handleOverlayCopyTimestampLink);
  window.addEventListener('popstate', handleOverlayPopState);
  
  // Close share popover on outside click
  document.addEventListener('click', (event) => {
    const sharePopover = document.getElementById('overlay-share-popover');
    const shareButton = document.getElementById('overlay-share-toggle-btn');
    if (sharePopover.classList.contains('visible') && 
        !sharePopover.contains(event.target) && 
        !shareButton.contains(event.target)) {
      sharePopover.classList.remove('visible');
    }
  });
  
  // Keyboard navigation for overlay
  document.addEventListener('keydown', (event) => {
    const overlay = document.getElementById('video-overlay');
    if (overlay.classList.contains('visible')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeVideoOverlay();
      }
    }
  });

  // --- Initial Load ---
  loadVideos(currentPage, false); // Initial load of page 1
  sortSelect.value = sortBy; // Set dropdown to reflect default sort
  pollScanStatus(); // Check initial scan status on page load
  connectSSE(); // Connect to Server-Sent Events
  initializeInfiniteScroll();
  initializeGsapSmoothScroll(); // Keep native scroll behavior
  
  // Handle direct URL navigation to video overlay
  const currentPath = window.location.pathname;
  const watchMatch = currentPath.match(/^\/watch\/(\d+)$/);
  if (watchMatch) {
    const videoId = watchMatch[1];
    // Wait for page to load before opening overlay
    setTimeout(() => {
      openVideoOverlay(videoId, null, { updateHistory: false });
    }, 500);
  }

  /**
   * Update favorite indicators on the grid based on current localStorage status.
   */
  function updateFavoriteIndicatorsOnGrid() {
    const videoCards = videosGrid.querySelectorAll('.video-card');
    videoCards.forEach(card => {
      const videoId = card.dataset.id;
      const indicator = card.querySelector('.favorite-indicator-grid');
      if (videoId && indicator) {
        const isNowFavorite = VideoUtils.isFavorite(videoId);
        indicator.classList.toggle('favorited', isNowFavorite);
      }
    });
  }

  // Add event listener for pageshow to update favorites when navigating back
  window.addEventListener('pageshow', (event) => {
    // event.persisted is true if the page is loaded from the cache (like when using back button)
    if (event.persisted) {
      console.log('Page loaded from cache (pageshow event). Updating favorite indicators.');
      updateFavoriteIndicatorsOnGrid();
    }
  });

});
