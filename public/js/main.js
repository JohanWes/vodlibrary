document.addEventListener('DOMContentLoaded', async () => {
  // Load utility functions
  const { showToast, getPlaceholderThumbnail, addUtilStyles, getVODsName, isFavorite, getFavorites } = window.VideoUtils;
  
  // Add utility styles
  addUtilStyles();
  
  // Initialize video preview manager
  let videoPreviewManager;
  try {
    videoPreviewManager = new window.VideoPreviewManager();
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
  const favoritesToggle = document.getElementById('favorites-toggle');
  const scanStatusElement = document.getElementById('scan-status'); // Get scan status element
  const loadingIndicator = document.createElement('div'); // Create loading indicator dynamically
  loadingIndicator.className = 'loading';
  loadingIndicator.style.display = 'none';
  videosGrid.parentNode.appendChild(loadingIndicator); // Append near the grid

  // State Variables
  let allVideos = []; // Holds all currently loaded videos across pages
  let sortBy = 'date_added_desc'; // Default sort by date added (newest)
  let searchQuery = '';
  let searchTimeout = null;
  let isLoading = false;
  let showOnlyFavorites = false;
  let currentPage = 1;
  let totalPages = 1;
  let limit = 20; // Default limit, will be updated from API response - Reduced batch size for better scrolling performance
  let totalVideos = 0;
  let currentAbortController = null; // To cancel ongoing fetch requests
  let scanPollingInterval = null; // Interval ID for scan status polling
  let sseEventSource = null; // Variable to hold the EventSource instance
  let hasScanRunThisSession = false; // Flag to track if scan initiated in this session
  let currentScrollTween = null; // To manage GSAP scroll animation

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
   * Load videos from the API with pagination
   */
  async function loadVideos(page = 1, append = false) {
    if (isLoading) return;
    
    abortPreviousFetch(); // Abort previous request if any
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    isLoading = true;
    loadingIndicator.style.display = 'block';
    if (!append) {
        videosGrid.innerHTML = ''; // Clear grid only if not appending (i.e., page 1 or new search/sort)
        allVideos = []; // Reset the local video cache
    }

    try {
      let url = `/api/videos?page=${page}&limit=${limit}&sort=${sortBy}`; // Include sort
      if (searchQuery) {
        url += `&search=${encodeURIComponent(searchQuery)}`;
      }
      
      const response = await fetch(url, { signal }); // Pass the signal
      
      if (!response.ok) {
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
         renderVideos(newVideos, append); // Render only the newly fetched videos if appending
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
      loadingIndicator.style.display = 'none';
      currentAbortController = null; // Clear the controller
    }
  }

  /**
   * Handle search input with debouncing
   */
  function handleSearchInput(event) {
    searchQuery = event.target.value.trim();
    
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
   * Creates a video card DOM element.
   * @param {object} video - The video object.
   * @param {number} index - The index for animation delay calculation.
   * @returns {HTMLElement} The video card element.
   */
  function createVideoCardElement(video, index = 0) {
      const videoCard = document.createElement('div');
      videoCard.className = 'video-card';
      videoCard.dataset.id = video.id;

      const addedDate = new Date(video.added_date);
      const formattedDate = addedDate.toLocaleDateString();

      const isFavorited = VideoUtils.isFavorite(video.id.toString()); // Use VideoUtils explicitly
      // Ensure duration is formatted, using utility if needed
      const durationFormatted = video.duration_formatted || (window.VideoUtils && typeof window.VideoUtils.formatDuration === 'function' ? window.VideoUtils.formatDuration(video.duration) : `${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')}`);

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
              <img class="thumbnail" src="${video.thumbnail_path || getPlaceholderThumbnail()}" alt="${video.title}" loading="lazy">
              <div class="duration-badge">${durationFormatted}</div>
              ${outcomeIndicatorHTML} {/* Add outcome indicator */}
            </div>
            <div class="video-info">
              <div class="video-title">${video.title}</div>
              <div class="video-date">${formattedDate}</div>
            </div>
        </a>
        <span class="favorite-indicator-grid ${isFavorited ? 'favorited' : ''}" data-video-id="${video.id}"></span>
      `;
      
      // --- Add Click Listener for Favorite Indicator ---
      // The favorite indicator is now a direct child of videoCard, not within the <a> tag.
      // Its click listener still needs to stop propagation to prevent the <a> tag from navigating.
      const favoriteIndicator = videoCard.querySelector('.favorite-indicator-grid');
      if (favoriteIndicator) {
          favoriteIndicator.addEventListener('click', (event) => {
              event.stopPropagation(); // Prevent card link navigation
              const videoId = event.target.dataset.videoId;
              const isNowFavorited = VideoUtils.toggleFavorite(videoId);
              event.target.classList.toggle('favorited', isNowFavorited);
              // Optional: Update the allVideos cache if needed for filtering consistency
              const videoIndex = allVideos.findIndex(v => v.id.toString() === videoId);
              if (videoIndex > -1) {
                  allVideos[videoIndex].is_favorite = isNowFavorited ? 1 : 0; 
              }
              showToast(isNowFavorited ? 'Added to favorites' : 'Removed from favorites');
          });
      }
      // --- End Favorite Indicator Click Listener ---

      // --- Add Click Listener for Video Card Link ---
      const videoLink = videoCard.querySelector('.video-card-link');
      if (videoLink) {
          videoLink.addEventListener('click', (event) => {
              // Check for middle click (button 1) or Ctrl+left click
              if (event.button === 1 || (event.button === 0 && event.ctrlKey)) {
                  event.preventDefault(); // Prevent default navigation
                  window.open(videoLink.href, '_blank', 'noopener,noreferrer');
              }
              // For regular left clicks (button 0 without Ctrl), let default behavior happen
          });
          
          // Also handle mousedown for middle click detection
          videoLink.addEventListener('mousedown', (event) => {
              if (event.button === 1) {
                  event.preventDefault(); // Prevent middle-click scroll behavior
              }
          });
      }
      // --- End Video Card Link Click Listener ---

      // Apply animation delay
      videoCard.style.animationDelay = `${index * 0.05}s`;
      videoCard.classList.add('fade-in');

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
  function renderVideos(videosToRender, append = false) {
    let displayedVideos = videosToRender;
    
    // Apply favorite filtering *only* to the videos being rendered in this batch
    if (showOnlyFavorites) {
      const favoriteIds = VideoUtils.getFavorites(); // Use VideoUtils explicitly
      displayedVideos = videosToRender.filter(video => favoriteIds.includes(video.id.toString()));
    }

    // If appending, check if the filtered list for this batch is empty
    if (append && displayedVideos.length === 0) {
        // Don't show "no videos" message if just appending an empty filtered batch
        setupPreloading(); // Still need to potentially setup preloading for existing items
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
    
    const fragment = document.createDocumentFragment();

    // Use the helper function to create elements
    displayedVideos.forEach((video, index) => {
      // Calculate overall index based on whether appending or not
      const overallIndex = append ? videosGrid.children.length + index : index;
      const videoCard = createVideoCardElement(video, overallIndex);
      fragment.appendChild(videoCard);
    });

    videosGrid.appendChild(fragment);
    
    setupPreloading(); // Setup preloading for newly added cards
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
       // Add styles if not already added
       if (!document.getElementById('limited-preload-styles')) {
           const style = document.createElement('style');
           style.id = 'limited-preload-styles';
           style.textContent = `
             .preload-info-message { font-size: 12px; color: var(--text-secondary); margin-left: 10px; padding: 4px 8px; background-color: rgba(92, 108, 255, 0.1); border-radius: var(--radius-sm); display: inline-block; }
             .limited-preloading .preload-indicator { opacity: 0.5; }
           `;
           document.head.appendChild(style);
       }
    }
    
    // Intersection Observer for initial segment preload when card enters viewport
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const videoId = entry.target.dataset.id;
          if (window.VideoPreloader && typeof window.VideoPreloader.preloadSegment === 'function') {
             window.VideoPreloader.preloadSegment(videoId, 0, 'low')
               .then(success => { if (success) entry.target.classList.add('preloaded'); })
               .catch(error => { console.warn(`Error preloading segment 0 for video ${videoId}:`, error); });
          }
          observer.unobserve(entry.target); // Preload only once on intersection
        }
      });
    }, { rootMargin: '200px', threshold: 0.1 }); // Increased rootMargin
    
    // Debounced preloading on hover
    const debouncedPreload = debounce((cardElement, id) => {
       if (window.VideoPreloader && typeof window.VideoPreloader.preloadSegments === 'function') {
          window.VideoPreloader.preloadSegments(id, 2, 'low') // Preload first 2 segments on hover
            .then(results => { if (results && results.some(success => success)) cardElement.classList.add('preloaded'); })
            .catch(error => { console.warn(`Error preloading segments on hover for video ${id}:`, error); });
       }
    }, 300); // 300ms debounce delay

    videoCards.forEach(card => {
      const videoId = card.dataset.id;
      card.addEventListener('mouseenter', () => debouncedPreload(card, videoId));
      observer.observe(card);
      card.classList.add('preload-observed'); // Mark card as observed
    });
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
   * Infinite Scroll Handler - Optimized for responsiveness
   */
  const handleInfiniteScroll = debounce(() => {
    if (isLoading || currentPage >= totalPages) {
      return; // Don't load if already loading or no more pages
    }

    // More aggressive threshold for faster scrolling
    const scrollThreshold = 3000; // Increased to 3000px for earlier loading
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;
    
    if (scrollPosition >= documentHeight - scrollThreshold) {
      console.log(`Loading page ${currentPage + 1}`);
      loadVideos(currentPage + 1, true); // Load next page and append
    }
  }, 50); // Reduced debounce for more responsive detection

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
    const videoCard = createVideoCardElement(newVideo, 0); // Create card with index 0 for animation
    videosGrid.prepend(videoCard); // Add to the beginning of the grid

    // Re-apply animation delays to all cards to maintain order
    Array.from(videosGrid.children).forEach((card, index) => {
        card.style.animationDelay = `${index * 0.05}s`;
    });

    // Setup preloading for the new card
    setupPreloading();

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
   * Initialize GSAP-based smooth scrolling
   */
  function initializeGsapSmoothScroll() {
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined' || typeof ScrollToPlugin === 'undefined') {
      console.error('GSAP, ScrollTrigger, or ScrollToPlugin not loaded. Smooth scrolling disabled.');
      return;
    }

    gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

    // Use the window as the scroll target
    const scrollTarget = window; 
    let targetScrollY = window.scrollY;
    const scrollSensitivity = 1.0; // Adjust sensitivity as needed
    const animationDuration = 0.4; // Reduced duration for more responsive scrolling
    const animationEase = "power1.out"; // Lighter ease for better performance

    // Prevent default scroll behavior and animate with GSAP
    window.addEventListener('wheel', (event) => {
      event.preventDefault(); // Prevent default browser scroll

      // Calculate target scroll position based on wheel delta
      targetScrollY += event.deltaY * scrollSensitivity;

      // Clamp target scroll to bounds (0 to max scroll height)
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      targetScrollY = Math.max(0, Math.min(targetScrollY, maxScroll));

      // Kill any existing scroll tween to avoid conflicts
      if (currentScrollTween) {
        currentScrollTween.kill();
      }

      // Animate scroll position using GSAP's ScrollToPlugin
      currentScrollTween = gsap.to(scrollTarget, {
        duration: animationDuration,
        ease: animationEase,
        scrollTo: {
          y: targetScrollY,
          autoKill: false // Prevent ScrollTrigger from killing tween
        },
        onComplete: () => {
          currentScrollTween = null; // Clear tween reference on completion
        },
        overwrite: true // Overwrite existing tweens on the same target
      });

    }, { passive: false }); // Need passive: false to call preventDefault

    // Listener to synchronize targetScrollY when scrolling via scrollbar/keyboard
    window.addEventListener('scroll', () => {
      // Only update if GSAP isn't currently animating the scroll
      if (!currentScrollTween) {
        targetScrollY = window.scrollY;
      }
    });

    console.log('GSAP smooth scroll initialized.');

    // Refresh ScrollTrigger to ensure it's aware of page height changes
    // Might need to call this after videos are loaded/added if height changes significantly
    // ScrollTrigger.refresh(); 
  }


  // --- Event Listeners ---
  searchInput.addEventListener('focus', () => searchInput.parentElement.classList.add('focused'));
  searchInput.addEventListener('blur', () => searchInput.parentElement.classList.remove('focused'));
  refreshBtn.addEventListener('click', refreshLibrary);
  sortSelect.addEventListener('change', handleSortChange);
  searchInput.addEventListener('input', handleSearchInput);
  favoritesToggle.addEventListener('change', handleFavoritesToggle);
  window.addEventListener('scroll', handleInfiniteScroll); // Add scroll listener

  // --- Initial Load ---
  loadVideos(currentPage, false); // Initial load of page 1
  sortSelect.value = sortBy; // Set dropdown to reflect default sort
  pollScanStatus(); // Check initial scan status on page load
  connectSSE(); // Connect to Server-Sent Events
  initializeGsapSmoothScroll(); // Initialize GSAP smooth scrolling

  // Add focus styles dynamically
  const style = document.createElement('style');
  style.textContent = `
    .search-container.focused .search-input {
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(92, 108, 255, 0.2);
    }
  `;
  document.head.appendChild(style);

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
