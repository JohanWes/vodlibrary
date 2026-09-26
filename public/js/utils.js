/**
 * Shared helpers for the index and player pages.
 * Served before authentication (share-link viewers), so keep it free of private data.
 */

/**
 * Show a toast notification
 * @param {string} message - Text to display (rendered as text, never HTML)
 * @param {string} type - info | success | error
 */
function showToast(message, type = 'info') {
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    toastContainer.setAttribute('role', 'status');
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Placeholder thumbnail as a data URI
 * @returns {string}
 */
function getPlaceholderThumbnail() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225" viewBox="0 0 400 225">'
    + '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">'
    + '<stop offset="0%" stop-color="#1a1a22"/><stop offset="100%" stop-color="#23232d"/></linearGradient></defs>'
    + '<rect width="400" height="225" fill="url(#g)"/><circle cx="200" cy="112.5" r="50" fill="#2c2c3a"/>'
    + '<polygon points="185,90 185,135 225,112.5" fill="#5c6cff"/></svg>'
  );
}

/**
 * Format seconds as a clock string: MM:SS below one hour, H:MM:SS above.
 * The single time/duration formatter for the client (cards, overlay, player, markers).
 * @param {number} seconds
 * @returns {string} e.g. 01:05, 25:00, 1:15:30
 */
function formatClock(seconds) {
  const total = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.floor(Number(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/**
 * Display duration for a video DTO; prefers the numeric duration so >1 h renders as H:MM:SS.
 * @param {{duration?: number, duration_formatted?: string}} video
 * @returns {string}
 */
function formatVideoDuration(video) {
  if (video && video.duration !== null && video.duration !== undefined && Number.isFinite(Number(video.duration))) {
    return formatClock(video.duration);
  }
  return (video && video.duration_formatted) || '';
}

/**
 * Resolve an application path beneath the document's base href
 * @param {string} path - Application path, with or without leading slash (query/hash preserved)
 * @returns {string} - Root-relative URL resolved against the document base
 */
function appUrl(path) {
  let basePath = '/';
  const baseElement = document.querySelector('base[href]');
  const baseHref = baseElement ? baseElement.getAttribute('href') : '';
  if (baseHref) {
    try {
      // Resolve the base href against the page URL (document.URL excludes the base itself)
      basePath = new URL(baseHref, document.URL || undefined).pathname;
    } catch (urlError) {
      basePath = baseHref.split(/[?#]/)[0] || '/';
    }
  }

  // Normalize the base path to exactly one leading and one trailing slash
  const trimmedBase = basePath.replace(/^\/+|\/+$/g, '');
  basePath = trimmedBase ? `/${trimmedBase}/` : '/';

  // Keep query/hash verbatim, strip a leading slash from the app path
  const suffixIndex = path.search(/[?#]/);
  const pathPart = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);

  return `${basePath}${pathPart.replace(/^\/+/, '')}${suffix}`;
}

let appConfigPromise = null;

/**
 * Fetch (once) the public application configuration
 * @returns {Promise<Object>} - e.g. { vodsName, advancedSearch? }
 */
function getAppConfig() {
  if (!appConfigPromise) {
    appConfigPromise = fetch(appUrl('/api/config'))
      .then((response) => {
        if (!response.ok) throw new Error(`Config request failed (${response.status})`);
        return response.json();
      })
      .catch((error) => {
        console.error('Error fetching app configuration:', error);
        return { vodsName: 'VODlibrary' };
      });
  }
  return appConfigPromise;
}

// --- Favorites: one parsed Set per page, persisted as a JSON array of string ids ---
const FAVORITES_KEY = 'videoFavorites';
let favoritesCache = null;

function readFavorites() {
  if (!favoritesCache) {
    try {
      const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
      favoritesCache = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch (error) {
      favoritesCache = new Set();
    }
  }
  return favoritesCache;
}

/** Drop the in-memory copy so the next read re-parses storage (bfcache restore, other tabs). */
function reloadFavorites() {
  favoritesCache = null;
}

function isFavorite(videoId) {
  return readFavorites().has(String(videoId));
}

/**
 * @param {string|number} videoId
 * @returns {boolean} - True if the video is now a favorite
 */
function toggleFavorite(videoId) {
  const favorites = readFavorites();
  const id = String(videoId);
  const nowFavorite = !favorites.has(id);
  if (nowFavorite) {
    favorites.add(id);
  } else {
    favorites.delete(id);
  }
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  } catch (error) {
    console.warn('Could not persist favorites:', error);
  }
  return nowFavorite;
}

window.addEventListener('storage', (event) => {
  if (event.key === FAVORITES_KEY || event.key === null) reloadFavorites();
});

window.VideoUtils = {
  showToast,
  getPlaceholderThumbnail,
  formatClock,
  formatVideoDuration,
  appUrl,
  getAppConfig,
  isFavorite,
  toggleFavorite,
  reloadFavorites
};
