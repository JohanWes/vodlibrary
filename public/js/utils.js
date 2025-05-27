/**
 * Utility functions for the video application
 */

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - The type of toast (info, error, etc.)
 */
function showToast(message, type = 'info') {
  // Create toast container if it doesn't exist
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  // Add to container
  toastContainer.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

/**
 * Generate a placeholder thumbnail as data URI
 * @returns {string} - Data URI for the placeholder thumbnail
 */
function getPlaceholderThumbnail() {
  // Modern SVG placeholder with play icon
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="225" viewBox="0 0 400 225">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a1a22;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#23232d;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="400" height="225" fill="url(#grad)"/>
      <circle cx="200" cy="112.5" r="50" fill="#2c2c3a"/>
      <polygon points="185,90 185,135 225,112.5" fill="#5c6cff"/>
    </svg>
  `);
}

/**
 * Format duration in seconds to MM:SS format
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration string
 */
function formatDuration(seconds) {
  if (!seconds) return '00:00';
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Add CSS for toast and animations
function addUtilStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 1000;
    }
    
    .toast {
      background-color: var(--bg-secondary);
      color: var(--text-color);
      padding: 12px 20px;
      border-radius: var(--radius-md);
      margin-top: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transform: translateX(100%);
      opacity: 0;
      transition: all 0.3s ease;
      border-left: 4px solid var(--accent-color);
    }
    
    .toast.error {
      border-left-color: #ff5c5c;
    }
    
    .toast.show {
      transform: translateX(0);
      opacity: 1;
    }
    
    .fade-in {
      animation: fadeIn 0.5s ease forwards;
      opacity: 0;
      transform: translateY(20px);
    }
    
    @keyframes fadeIn {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .spin {
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Fetch application configuration from the server
 * @returns {Promise<Object>} - Configuration object
 */
async function getAppConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) {
      throw new Error('Failed to fetch app configuration');
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching app configuration:', error);
    return { vodsName: 'Sample' }; // Default fallback
  }
}

// App configuration cache
let appConfig = null;

/**
 * Get the VODs name with "VODs" appended
 * @returns {Promise<string>} - The formatted VODs name
 */
async function getVODsName() {
  if (!appConfig) {
    appConfig = await getAppConfig();
  }
  return `${appConfig.vodsName}VODs`;
}

/**
 * Add a video to favorites
 * @param {string} videoId - The ID of the video to add to favorites
 */
function addToFavorites(videoId) {
  // Get current favorites from localStorage
  const favorites = getFavorites();
  
  // Add the video ID if it's not already in favorites
  if (!favorites.includes(videoId)) {
    favorites.push(videoId);
    
    // Save updated favorites to localStorage
    localStorage.setItem('videoFavorites', JSON.stringify(favorites));
    
    return true; // Added successfully
  }
  
  return false; // Already in favorites
}

/**
 * Remove a video from favorites
 * @param {string} videoId - The ID of the video to remove from favorites
 */
function removeFromFavorites(videoId) {
  // Get current favorites from localStorage
  const favorites = getFavorites();
  
  // Find the index of the video ID
  const index = favorites.indexOf(videoId);
  
  // Remove the video ID if it exists in favorites
  if (index !== -1) {
    favorites.splice(index, 1);
    
    // Save updated favorites to localStorage
    localStorage.setItem('videoFavorites', JSON.stringify(favorites));
    
    return true; // Removed successfully
  }
  
  return false; // Not in favorites
}

/**
 * Check if a video is in favorites
 * @param {string} videoId - The ID of the video to check
 * @returns {boolean} - True if the video is in favorites, false otherwise
 */
function isFavorite(videoId) {
  // Get current favorites from localStorage
  const favorites = getFavorites();
  
  // Check if the video ID is in favorites
  return favorites.includes(videoId);
}

/**
 * Toggle favorite status for a video
 * @param {string} videoId - The ID of the video to toggle
 * @returns {boolean} - True if the video is now favorited, false if it was removed
 */
function toggleFavorite(videoId) {
  if (isFavorite(videoId)) {
    removeFromFavorites(videoId);
    return false; // Now not favorited
  } else {
    addToFavorites(videoId);
    return true; // Now favorited
  }
}

/**
 * Get all favorite video IDs
 * @returns {Array<string>} - Array of favorite video IDs
 */
function getFavorites() {
  // Get favorites from localStorage
  const favoritesJson = localStorage.getItem('videoFavorites');
  
  // Parse JSON or return empty array if no favorites exist
  return favoritesJson ? JSON.parse(favoritesJson) : [];
}

// Export the utility functions
window.VideoUtils = {
  showToast,
  getPlaceholderThumbnail,
  formatDuration,
  addUtilStyles,
  getAppConfig,
  getVODsName,
  addToFavorites,
  removeFromFavorites,
  isFavorite,
  toggleFavorite,
  getFavorites
};
