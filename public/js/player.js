document.addEventListener('DOMContentLoaded', async () => {
  // Load utility functions
  const { showToast, addUtilStyles, getVODsName, isFavorite, toggleFavorite } = window.VideoUtils;
  
  // Add utility styles
  addUtilStyles();
  
  // Get the dynamic VODs name and update page elements
  const vodsName = await getVODsName();
  document.getElementById('app-title').textContent = vodsName;
  document.getElementById('footer-text').textContent = `© ${vodsName} - A simple VOD sharing system`;
  const videoPlayer = document.getElementById('video-player');
  const videoTitle = document.getElementById('video-title');
  const videoDate = document.getElementById('video-date');
  const videoDuration = document.getElementById('video-duration');
  const favoriteBtn = document.getElementById('favorite-btn');
  const favoriteText = favoriteBtn.querySelector('.favorite-text');
  const videoContainer = document.querySelector('.video-container');
  
  // New share popover elements
  const shareToggleBtn = document.getElementById('share-toggle-btn');
  const sharePopover = document.getElementById('share-popover');
  const copyBaseLinkBtn = document.getElementById('copy-base-link-btn');
  const copyTimestampLinkBtn = document.getElementById('copy-timestamp-link-btn');
  const popoverCurrentTime = document.getElementById('popover-current-time');
  
  let isLoading = false;
  let plyrPlayer = null; // To hold the Plyr instance
  let deathTimestamps = null; // To hold parsed timestamps
  let baseShareUrl = null; // To store the base share URL fetched from API
  
  const videoId = getVideoIdFromPath(window.location.pathname);
  
  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'video-loading-overlay';
  loadingOverlay.innerHTML = `
    <div class="video-loading-spinner"></div>
    <div class="video-loading-text">Loading video...</div>
  `;
  
  loadVideo(videoId);
  
  // Add listeners for new elements (implementation later)
  favoriteBtn.addEventListener('click', handleFavoriteClick);
  shareToggleBtn.addEventListener('click', toggleSharePopover); 
  copyBaseLinkBtn.addEventListener('click', handleCopyBaseLink);
  copyTimestampLinkBtn.addEventListener('click', handleCopyTimestampLink);
  // Add listener to close popover on outside click (implementation later)
  document.addEventListener('click', handleClickOutsidePopover);
  
  /**
   * Parse the video ID from a watch page path, relative to the document base
   * @param {string} path - The current window location pathname
   * @returns {string} - The video ID, or '' if not present
   */
  function getVideoIdFromPath(path) {
    const basePath = appUrl('/');
    let relativePath = path;
    if (relativePath.startsWith(basePath)) {
      relativePath = relativePath.slice(basePath.length);
    }
    relativePath = relativePath.replace(/^\/+/, '');
    return relativePath.split('/').pop() || '';
  }

  /**
   * Load video details and set up player
   */
  async function loadVideo(id) {
    if (isLoading) return;
    
    try {
      isLoading = true;
      
      // Fetch video metadata from API
      const response = await fetch(appUrl(`/api/videos/${id}`));
      
      if (!response.ok) {
        throw new Error('Failed to fetch video');
      }
      
      const video = await response.json();
      
      document.title = `${vodsName} - ${video.title}`;
      videoTitle.textContent = video.title;
      
      const addedDate = new Date(video.added_date);
      videoDate.textContent = addedDate.toLocaleDateString();
      
      videoDuration.textContent = video.duration_formatted;
      
      // Parse death timestamps if they exist
      if (video.death_timestamps) {
        try {
          deathTimestamps = JSON.parse(video.death_timestamps);
          if (!Array.isArray(deathTimestamps)) {
            console.warn('Parsed death_timestamps is not an array:', deathTimestamps);
            deathTimestamps = null;
          }
        } catch (parseError) {
          console.error('Error parsing death_timestamps JSON:', parseError);
          deathTimestamps = null;
        }
      } else {
        deathTimestamps = null; // Ensure it's null if not present
      }
      
      updateFavoriteButtonState(id);
      
      videoPlayer.src = appUrl(`/api/videos/${id}/stream`);
      
      initializePlyrPlayer();
    } catch (error) {
      console.error('Error loading video:', error);
      showToast('Failed to load video. Please try again.', 'error');
    } finally {
      isLoading = false;
    }
  }
  
  /**
   * Initialize Plyr player
   */
  function initializePlyrPlayer() {
    // Destroy existing player if it exists
    if (plyrPlayer) {
      try {
        plyrPlayer.destroy();
      } catch (e) {
        console.warn('Error destroying previous Plyr instance:', e);
      }
      plyrPlayer = null;
    }
    
    // Plyr options
    const options = {
      // Standard controls similar to YouTube
      controls: [
        'play-large', // The big play button in the center
        'play',       // Play/pause playback
        'progress',   // The progress bar and scrubber for playback and buffering
        'current-time', // The current time of playback
        'duration',   // The full duration of the media
        'mute',       // Toggle mute
        'volume',     // Volume control
        'captions',   // Toggle captions
        'settings',   // Settings menu
        'pip',        // Picture-in-picture (supported browsers)
        'airplay',    // Airplay (supported browsers)
        'fullscreen'  // Toggle fullscreen
      ],
      settings: ['captions', 'quality', 'speed', 'loop'],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      // Add other options as needed, e.g., keyboard shortcuts, tooltips
      keyboard: { focused: true, global: true },
      tooltips: { controls: true, seek: true },
      autoplay: true, // Attempt to autoplay
      // You might want to customize icons or i18n later
    };
    
    plyrPlayer = new Plyr(videoPlayer, options);
    const initialTimestamp = getTimestampFromUrl();
    const seekToInitialTimestamp = initialTimestamp !== null
      ? createDeferredTimestampSeek(plyrPlayer, videoPlayer, initialTimestamp, 'Player')
      : null;

    plyrPlayer.on('ready', event => {
      console.log('Plyr player ready');
      document.querySelector('.video-info').classList.add('fade-in');

      if (seekToInitialTimestamp) {
        seekToInitialTimestamp();
      }
    });
    
    // Handle loadedmetadata to ensure duration is known before drawing markers
    plyrPlayer.on('loadedmetadata', event => {
      console.log('Plyr metadata loaded, duration:', plyrPlayer.duration);
      if (deathTimestamps && plyrPlayer.duration) {
        displayDeathMarkers(deathTimestamps, plyrPlayer.duration);
      }
    });
    
    plyrPlayer.on('error', event => {
      console.error('Plyr playback error:', event.detail.plyr.source);
      showToast('Error playing video. Please try again.', 'error');
    });
  }

  function getTimestampFromUrl() {
    const timestamp = new URLSearchParams(window.location.search).get('t');
    if (timestamp === null) return null;

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds < 0) return null;

    return Math.floor(seconds);
  }

  function createDeferredTimestampSeek(player, mediaElement, targetTime, label) {
    const maxAttempts = 20;
    const retryDelayMs = 250;
    const seekEvents = ['loadedmetadata', 'durationchange', 'canplay', 'playing'];
    let attempts = 0;
    let retryTimer = null;
    let completed = false;

    const cleanup = () => {
      seekEvents.forEach(eventName => {
        mediaElement.removeEventListener(eventName, attemptSeek);
      });
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRetry = () => {
      if (completed || attempts >= maxAttempts || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attemptSeek();
      }, retryDelayMs);
    };

    function attemptSeek() {
      if (completed) return;
      attempts += 1;

      try {
        player.currentTime = targetTime;

        const actualTime = Number(player.currentTime || mediaElement.currentTime || 0);
        if (Math.abs(actualTime - targetTime) < 1) {
          completed = true;
          cleanup();
          console.log(`${label} seeked to timestamp: ${targetTime}s`);
          return;
        }

        if (attempts >= maxAttempts) {
          completed = true;
          cleanup();
          console.warn(`${label} timestamp seek did not settle near ${targetTime}s`);
          return;
        }
      } catch (seekError) {
        if (attempts >= maxAttempts) {
          completed = true;
          cleanup();
          console.error(`${label} timestamp seek failed:`, seekError);
          return;
        }
      }

      scheduleRetry();
    }

    seekEvents.forEach(eventName => {
      mediaElement.addEventListener(eventName, attemptSeek);
    });

    return attemptSeek;
  }
  
  /**
   * Update favorite button state based on whether the video is favorited
   * @param {string} videoId - The ID of the video
   */
  function updateFavoriteButtonState(videoId) {
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
   * Handle favorite button click
   */
  function handleFavoriteClick() {
    const isNowFavorited = toggleFavorite(videoId);
    
    updateFavoriteButtonState(videoId);
    
    if (isNowFavorited) {
      showToast('Added to favorites', 'info');
    } else {
      showToast('Removed from favorites', 'info');
    }
  }
  
  /**
   * Toggles the visibility of the share popover.
   */
  function toggleSharePopover() {
    const isVisible = sharePopover.classList.toggle('visible');
    if (isVisible && plyrPlayer) {
      // Update time display when opening
      const currentTime = Math.round(plyrPlayer.currentTime);
      popoverCurrentTime.textContent = `Current time: ${formatTime(currentTime)}`;
    }
  }
  
  /**
   * Closes the popover if a click occurs outside of it.
   * @param {Event} event - The click event.
   */
  function handleClickOutsidePopover(event) {
    if (sharePopover.classList.contains('visible') && 
        !sharePopover.contains(event.target) && 
        !shareToggleBtn.contains(event.target)) {
      sharePopover.classList.remove('visible');
    }
  }
  
  /**
   * Copies the base share link (without timestamp) to the clipboard.
   */
  async function handleCopyBaseLink() {
    if (!baseShareUrl) {
      // Fetch the base URL if it hasn't been fetched yet
      await fetchBaseShareUrl(); 
      if (!baseShareUrl) { // Check again after fetch attempt
        showToast('Could not get share link.', 'error');
        return;
      }
    }
    
    copyToClipboard(baseShareUrl, copyBaseLinkBtn);
    sharePopover.classList.remove('visible'); // Close popover after copy
  }
  
  /**
   * Copies the share link with the current timestamp to the clipboard.
   */
  async function handleCopyTimestampLink() {
    if (!plyrPlayer || typeof plyrPlayer.currentTime === 'undefined') {
      showToast('Player not ready.', 'error');
      return;
    }
    
    if (!baseShareUrl) {
      // Fetch the base URL if it hasn't been fetched yet
      await fetchBaseShareUrl();
      if (!baseShareUrl) { // Check again after fetch attempt
        showToast('Could not get share link.', 'error');
        return;
      }
    }
    
    const currentTime = Math.round(plyrPlayer.currentTime);
    const timestampedUrl = `${baseShareUrl}?t=${currentTime}`;
    
    copyToClipboard(timestampedUrl, copyTimestampLinkBtn);
    sharePopover.classList.remove('visible'); // Close popover after copy
  }
  
  /**
   * Helper function to copy text to clipboard and provide feedback.
   * @param {string} text - The text to copy.
   * @param {HTMLElement} buttonElement - The button that was clicked.
   */
  function copyToClipboard(text, buttonElement) {
    navigator.clipboard.writeText(text).then(() => {
      const originalText = buttonElement.textContent;
      buttonElement.textContent = 'Copied!';
      buttonElement.disabled = true; // Briefly disable
      showToast('Link copied to clipboard!', 'success');
      setTimeout(() => {
        buttonElement.textContent = originalText;
        buttonElement.disabled = false;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy text: ', err);
      showToast('Failed to copy link.', 'error');
    });
  }
  
  /**
   * Fetches the base share URL from the API.
   */
  async function fetchBaseShareUrl() {
    if (baseShareUrl) return; // Already fetched
    
    try {
      const response = await fetch(appUrl(`/api/share/${videoId}`));
      if (!response.ok) {
        throw new Error('Failed to generate share link');
      }
      const data = await response.json();
      baseShareUrl = data.shareLink; // Store the base URL
    } catch (error) {
      console.error('Error generating share link:', error);
      baseShareUrl = null; // Ensure it's null on error
    }
  }

  /**
   * Displays markers on the video timeline for each death timestamp.
   * @param {number[]} timestamps - Array of death timestamps in seconds.
   * @param {number} duration - Total video duration in seconds.
   */
  function displayDeathMarkers(timestamps, duration) {
    if (!duration || duration <= 0 || !timestamps || timestamps.length === 0) {
      console.log('No valid timestamps or duration to display markers.');
      return;
    }
    
    // Find the actual progress input element within the container
    // This is usually the element that visually represents the seekable track
    const progressTrack = videoContainer.querySelector('.plyr__progress input[type=range]'); 
    let progressElement; // Declare progressElement here
    if (!progressTrack) {
      console.error('Could not find Plyr progress track element to add markers.');
      // Fallback to container if track not found, though positioning might be less precise
      const progressContainer = videoContainer.querySelector('.plyr__progress__container');
      if (!progressContainer) {
        console.error('Could not find Plyr progress container either.');
        return;
      }
      console.warn('Using progress container as fallback for markers.');
      progressElement = progressContainer; 
    } else {
      // We need to append markers to the *parent* of the input range for correct positioning relative to it.
      progressElement = progressTrack.parentElement; 
    }

    if (!progressElement) {
        console.error('Could not determine element to append markers to.');
        return;
    }
    
    // Clear existing markers first from the chosen parent
    const existingMarkers = progressElement.querySelectorAll('.death-marker');
    existingMarkers.forEach(marker => marker.remove());
    
    console.log(`Displaying ${timestamps.length} death markers.`);
    
    timestamps.forEach(timestamp => {
      if (timestamp >= 0 && timestamp <= duration) {
        const percentage = (timestamp / duration) * 100;
        
        const marker = document.createElement('div');
        marker.className = 'death-marker';
        marker.style.left = `${percentage}%`;
        // Optional: Add tooltip with timestamp or player name later
        marker.title = `Death at ${formatTime(timestamp)}`; 
        
        progressElement.appendChild(marker); // Append to the correct parent
      } else {
        console.warn(`Skipping invalid timestamp: ${timestamp} (duration: ${duration})`);
      }
    });
  }
  
  /**
   * Formats seconds into MM:SS or HH:MM:SS format.
   * @param {number} seconds - The time in seconds.
   * @returns {string} The formatted time string.
   */
  function formatTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds); 
    const timeString = date.toISOString().substr(11, 8);
    // Remove leading hours if zero (e.g., 00:15:30 -> 15:30)
    return timeString.startsWith('00:') ? timeString.substr(3) : timeString;
  }
});
