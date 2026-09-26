/**
 * Player core shared by the index overlay and the standalone player page:
 * lazy Plyr loading, player creation (options, death markers),
 * favorite buttons and the share menu. Also boots player.html when present.
 *
 * Lives in player.js (not a new file) because this script is served before
 * authentication, which share-link viewers need.
 */
(function () {
  const { showToast, appUrl, formatClock, isFavorite, toggleFavorite } = window.VideoUtils;

  // Vendored Plyr 3.7.8 (public/vendor/plyr), served before authentication so share-link viewers get it too.
  const PLYR_RETRY_AFTER_MS = 30000;
  let plyrPromise = null;
  let plyrFailedAt = 0;

  /** Insert plyr.css before the app stylesheet, so the app's Plyr overrides win at equal specificity. */
  function ensurePlyrStylesheet() {
    const href = appUrl('/vendor/plyr/plyr.css');
    const absolute = new URL(href, document.baseURI).href;
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === absolute)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.insertBefore(link, document.querySelector('link[rel="stylesheet"][href$="css/style.css"]'));
  }

  /**
   * Load Plyr (JS + CSS) once. A failure is remembered for a short cooldown, so opening
   * several videos does not retry the download each time; callers fall back to native controls.
   * @returns {Promise<Function>} The Plyr constructor
   */
  function loadPlyr() {
    if (typeof window.Plyr === 'function') {
      ensurePlyrStylesheet();
      return Promise.resolve(window.Plyr);
    }
    if (plyrPromise && !(plyrFailedAt && Date.now() - plyrFailedAt > PLYR_RETRY_AFTER_MS)) {
      return plyrPromise;
    }
    plyrFailedAt = 0;
    ensurePlyrStylesheet();
    plyrPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = (error) => {
        script.remove();
        plyrFailedAt = Date.now();
        reject(error);
      };
      script.src = appUrl('/vendor/plyr/plyr.js');
      script.async = true;
      script.onload = () => (typeof window.Plyr === 'function'
        ? resolve(window.Plyr)
        : fail(new Error('Plyr missing after loading vendor/plyr/plyr.js')));
      script.onerror = () => fail(new Error('Failed to load vendor/plyr/plyr.js'));
      document.head.appendChild(script);
    });
    return plyrPromise;
  }

  function getTimestampFromUrl() {
    const timestamp = new URLSearchParams(window.location.search).get('t');
    if (timestamp === null) return null;
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.floor(seconds);
  }

  /**
   * @param {string|number[]|null|undefined} raw - JSON array of seconds from the API
   * @returns {number[]}
   */
  function parseDeathTimestamps(raw) {
    if (!raw) return [];
    try {
      const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t) => Number.isFinite(t) && t >= 0) : [];
    } catch (error) {
      console.warn('Invalid death_timestamps:', error);
      return [];
    }
  }

  /**
   * Create a Plyr player on an element that has no src yet (set src afterwards,
   * so Plyr's internal clone of the element does not start a second download).
   * @param {HTMLVideoElement} videoElement
   * @param {{deathTimestamps?: number[]}} options
   * @returns {Object} Plyr instance
   */
  function createPlayer(videoElement, { deathTimestamps = [] } = {}) {
    const seen = new Set();
    const points = [];
    deathTimestamps.forEach((seconds) => {
      const time = Math.round(seconds);
      if (seen.has(time)) return;
      seen.add(time);
      // Plyr renders labels as HTML; this one is built from digits only.
      points.push({ time, label: `Death at ${formatClock(time)}` });
    });

    const player = new window.Plyr(videoElement, {
      controls: [
        'play-large', 'play', 'progress', 'current-time', 'duration', 'mute',
        'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
      ],
      settings: ['captions', 'quality', 'speed', 'loop'],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      // Global keys: one player per page, and the overlay makes the page behind it inert.
      keyboard: { focused: true, global: true },
      tooltips: { controls: true, seek: true },
      autoplay: true,
      iconUrl: appUrl('/vendor/plyr/plyr.svg'),
      blankVideo: appUrl('/vendor/plyr/blank.mp4'),
      markers: { enabled: points.length > 0, points }
    });

    player.on('error', () => {
      showToast('Error playing video. Please try again.', 'error');
    });
    return player;
  }

  /**
   * Reflect favorite state on a Favorite button (the label stays "Favorite"; aria-pressed carries the state)
   * @param {HTMLButtonElement} button
   * @param {string} videoId
   */
  function renderFavoriteButton(button, videoId) {
    const favorited = Boolean(videoId) && isFavorite(videoId);
    button.classList.toggle('active', favorited);
    button.setAttribute('aria-pressed', String(favorited));
  }

  /**
   * Wire a Favorite button
   * @param {HTMLButtonElement} button
   * @param {() => string|null} getVideoId
   * @param {(videoId: string, favorited: boolean) => void} [onChange]
   */
  function bindFavoriteButton(button, getVideoId, onChange) {
    button.addEventListener('click', () => {
      const videoId = getVideoId();
      if (!videoId) return;
      const favorited = toggleFavorite(videoId);
      renderFavoriteButton(button, videoId);
      showToast(favorited ? 'Added to favorites' : 'Removed from favorites');
      if (onChange) onChange(videoId, favorited);
    });
  }

  function copyToClipboard(text, button) {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      // Insecure origins (plain-http LAN) have no async clipboard API.
      window.prompt('Copy this link:', text);
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      const originalText = button.textContent;
      button.textContent = 'Copied!';
      button.disabled = true;
      showToast('Link copied to clipboard!', 'success');
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 2000);
    }).catch((error) => {
      console.error('Failed to copy text:', error);
      showToast('Failed to copy link.', 'error');
    });
  }

  /**
   * Wire a share popover (Copy Link / Copy Link at Current Time)
   * @param {Object} elements - { toggle, popover, copyBase, copyTimestamp, timeDisplay }
   * @param {() => string|null} getVideoId
   * @param {() => Object|null} getPlayer
   * @returns {{close: Function}}
   */
  function bindShareMenu(elements, getVideoId, getPlayer) {
    const { toggle, popover, copyBase, copyTimestamp, timeDisplay } = elements;
    const shareUrls = new Map();

    const setOpen = (open) => {
      popover.classList.toggle('visible', open);
      toggle.setAttribute('aria-expanded', String(open));
      const player = getPlayer();
      if (open && player) {
        timeDisplay.textContent = `Current time: ${formatClock(Math.round(player.currentTime || 0))}`;
      }
    };
    const close = () => setOpen(false);

    async function getShareUrl(videoId) {
      if (shareUrls.has(videoId)) return shareUrls.get(videoId);
      try {
        const response = await fetch(appUrl(`/api/share/${videoId}`));
        if (!response.ok) throw new Error(`Share link request failed (${response.status})`);
        const data = await response.json();
        shareUrls.set(videoId, data.shareLink);
        return data.shareLink;
      } catch (error) {
        console.error('Error generating share link:', error);
        return null;
      }
    }

    async function copyLink(button, withTimestamp) {
      const videoId = getVideoId();
      const player = getPlayer();
      if (!videoId) return;
      if (withTimestamp && (!player || typeof player.currentTime === 'undefined')) {
        showToast('Player not ready.', 'error');
        return;
      }
      const baseUrl = await getShareUrl(videoId);
      if (!baseUrl) {
        showToast('Could not get share link.', 'error');
        return;
      }
      copyToClipboard(withTimestamp ? `${baseUrl}?t=${Math.round(player.currentTime)}` : baseUrl, button);
      close();
    }

    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => setOpen(!popover.classList.contains('visible')));
    copyBase.addEventListener('click', () => copyLink(copyBase, false));
    copyTimestamp.addEventListener('click', () => copyLink(copyTimestamp, true));
    document.addEventListener('click', (event) => {
      if (popover.classList.contains('visible') && !popover.contains(event.target) && !toggle.contains(event.target)) {
        close();
      }
    });
    return { close };
  }

  /** @returns {string|null} The id in a /watch/:id path (under any base path) */
  function videoIdFromPath(pathname = window.location.pathname) {
    const match = pathname.match(/\/watch\/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  window.PlayerCore = {
    videoIdFromPath,
    loadPlyr,
    createPlayer,
    parseDeathTimestamps,
    renderFavoriteButton,
    bindFavoriteButton,
    bindShareMenu
  };

  // --- Standalone player page (player.html) ---
  async function bootPlayerPage(videoElement) {
    const $ = (id) => document.getElementById(id);
    const videoId = videoIdFromPath();
    let player = null;

    const favoriteBtn = $('favorite-btn');
    bindFavoriteButton(favoriteBtn, () => videoId);
    renderFavoriteButton(favoriteBtn, videoId);
    bindShareMenu({
      toggle: $('share-toggle-btn'),
      popover: $('share-popover'),
      copyBase: $('copy-base-link-btn'),
      copyTimestamp: $('copy-timestamp-link-btn'),
      timeDisplay: $('popover-current-time')
    }, () => videoId, () => player);

    // Config, metadata and Plyr load in parallel; only the metadata gates playback.
    const namePromise = window.VideoUtils.getAppConfig().then((config) => config.vodsName);
    namePromise.then((name) => {
      $('app-title').textContent = name;
      $('footer-text').textContent = `© ${name} - A simple VOD sharing system`;
    });

    try {
      if (!videoId) throw new Error('No video id in URL');
      const videoPromise = fetch(appUrl(`/api/videos/${videoId}`)).then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch video (${response.status})`);
        return response.json();
      });
      // Without Plyr (load failed) the native controls still play the video.
      const [video, plyrAvailable] = await Promise.all([videoPromise, loadPlyr().then(() => true, () => false)]);

      $('video-title').textContent = video.title;
      $('video-date').textContent = new Date(video.added_date).toLocaleDateString();
      $('video-duration').textContent = window.VideoUtils.formatVideoDuration(video);
      namePromise.then((name) => {
        document.title = `${name} - ${video.title}`;
      });

      if (plyrAvailable) {
        player = createPlayer(videoElement, {
          deathTimestamps: parseDeathTimestamps(video.death_timestamps)
        });
        player.on('ready', () => document.querySelector('.video-info').classList.add('fade-in'));
      }
      // ?t= (share links): one seek once the duration is known; works with or without Plyr.
      const startAt = getTimestampFromUrl();
      if (startAt !== null) {
        videoElement.addEventListener('loadedmetadata', () => {
          videoElement.currentTime = startAt;
        }, { once: true });
      }
      videoElement.src = appUrl(`/api/videos/${videoId}/stream`);
    } catch (error) {
      console.error('Error loading video:', error);
      showToast('Failed to load video. Please try again.', 'error');
    }
  }

  const standaloneVideo = document.getElementById('video-player');
  if (standaloneVideo) {
    bootPlayerPage(standaloneVideo);
  }
}());
