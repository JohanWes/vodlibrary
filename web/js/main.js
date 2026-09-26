import {
  showToast,
  appUrl,
  getPlaceholderThumbnail,
  getAppConfig,
  isFavorite,
  toggleFavorite,
  reloadFavorites,
  formatVideoDuration,
  formatDate,
  formatTime,
  videoDetails
} from './utils.js';
import * as PlayerCore from './player.js';
import { VideoPreviewManager } from './video-preview.js';

{
  const videoPreviewManager = new VideoPreviewManager();

  let vodsName = 'VODlibrary';

  // DOM Elements
  const videosGrid = document.getElementById('videos-grid');
  const refreshBtn = document.getElementById('refresh-btn');
  const sortSelect = document.getElementById('sort-select');
  const searchInput = document.getElementById('search-input');
  const searchContainer = searchInput.closest('.search-container');
  const searchButton = document.getElementById('search-button');
  const advancedSearchToggle = document.getElementById('advanced-search-toggle');
  const advancedSearchLabel = advancedSearchToggle.closest('label');
  const favoritesToggle = document.getElementById('favorites-toggle');
  const videosLoadSentinel = document.getElementById('videos-load-sentinel');
  const scanStatusElement = document.getElementById('scan-status');
  const overlay = document.getElementById('video-overlay');
  const overlayPlayerContainer = overlay.querySelector('.theater-player');
  const overlayCloseButton = overlay.querySelector('.theater-close');
  const overlayFavoriteBtn = document.getElementById('overlay-favorite-btn');

  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'loading-more';
  loadingIndicator.textContent = 'Loading more…';
  loadingIndicator.hidden = true;
  videosGrid.after(loadingIndicator);

  const DEFAULT_SORT = 'recorded_desc';
  const PAGE_SIZE = 60;
  const ADVANCED_LIMIT = 100; // Advanced (LLM) results are requested as one page; no infinite scroll
  const DAY_START_HOUR = 5; // a play day runs 05:00-05:00, so late raids stay with their evening
  const SSE_MAX_FAILURES = 5;
  const ADVANCED_PLACEHOLDER = "Describe what you're looking for (e.g., 'find Cinderbrew Meadery with Evandis deaths')...";

  // State Variables
  let allVideos = []; // Every loaded video across pages, in display order (before the favorites filter)
  let sortBy = DEFAULT_SORT;
  let searchQuery = ''; // The query of the list being shown
  let advancedQuery = false; // The list being shown comes from advanced search
  let useAdvancedSearch = false; // The Advanced toggle: Enter / the search button run an advanced search
  let searchTimeout = null;
  let isLoading = false;
  let freshLoadPending = false; // A non-append load is in flight; the grid shows its placeholder
  let showOnlyFavorites = false;
  let currentPage = 1;
  let limit = PAGE_SIZE;
  let totalVideos = 0;
  let offsetShift = 0; // Live adds (+) and deletes (-) inside the loaded range since the last page load
  let listRequestSeq = 0; // Only the newest list request may touch state or the DOM
  let listAbortController = null;
  let renderGeneration = 0; // Bumped on every grid reset; stale chunked renders stop
  const sessionVideos = new WeakMap(); // session <section> -> its videos, for the header summary
  let pendingSseAdds = []; // Adds that arrived during a fresh load; applied once it lands
  let infiniteScrollObserver = null;
  let scanPollTimer = null;
  let scanCheckSeq = 0;
  let scanStatusClearTimer = null;
  let scanWatched = false; // A scan was started here or seen running: report how it ends
  let scanStartedHere = false;
  let sseEventSource = null;
  let sseFailures = 0;

  // Video overlay state
  let overlayPlayer = null;
  let overlayCurrentVideoId = null;
  let overlayGeneration = 0; // Bumped on every open/close; stale async work bails out
  let overlayFetchController = null;
  let overlayMediaListeners = null;
  let overlayReadyTimer = null;
  let historyBackPending = false; // Closing popped the overlay's history entry; the next popstate is ours
  const overlayShareMenu = PlayerCore.bindShareMenu({
    toggle: document.getElementById('overlay-share-toggle-btn'),
    popover: document.getElementById('overlay-share-popover'),
    copyBase: document.getElementById('overlay-copy-base-link-btn'),
    copyTimestamp: document.getElementById('overlay-copy-timestamp-link-btn'),
    timeDisplay: document.getElementById('overlay-popover-current-time')
  }, () => overlayCurrentVideoId, () => overlayPlayer);

  function nextFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  // Warm Plyr on the first card hover so the first overlay opens without waiting for it.
  function handleFirstCardHover(event) {
    if (!event.target.closest('.video-card')) return;
    videosGrid.removeEventListener('pointerover', handleFirstCardHover);
    PlayerCore.loadPlyr().catch(() => {});
  }

  // --- Grid clicks ---
  function renderGridFavorite(button, favorited) {
    button.classList.toggle('favorited', favorited);
    button.setAttribute('aria-pressed', String(favorited));
  }

  function findGridCard(videoId) {
    const id = String(videoId);
    return /^\d+$/.test(id) ? videosGrid.querySelector(`.video-card[data-id="${id}"]`) : null;
  }

  function handleVideoGridClick(event) {
    const favoriteButton = event.target.closest('.favorite-indicator-grid');
    if (favoriteButton) {
      event.preventDefault();
      const isNowFavorited = toggleFavorite(favoriteButton.dataset.videoId);
      renderGridFavorite(favoriteButton, isNowFavorited);
      showToast(isNowFavorited ? 'Added to favorites' : 'Removed from favorites');
      return;
    }

    const tick = event.target.closest('.session-tick');
    if (tick) {
      openVideoOverlay(tick.dataset.id, event);
      return;
    }

    // The card is a real link: modified clicks, middle-click and "open in new tab" stay native.
    const link = event.target.closest('.video-card-link');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    openVideoOverlay(link.closest('.video-card').dataset.id, event);
  }

  // --- Grid content ---

  /**
   * Replace the grid content. Every non-append render goes through here so hover
   * previews are torn down and stale chunked renders stop.
   */
  function resetGrid(...nodes) {
    videoPreviewManager.hideAll();
    renderGeneration += 1;
    videosGrid.replaceChildren(...nodes);
  }

  /**
   * Show an empty or error message in the grid (no spinner)
   */
  function setGridMessage(text, { error = false } = {}) {
    const message = document.createElement('div');
    message.className = error ? 'empty-state is-error' : 'empty-state';
    message.textContent = text;
    resetGrid(message);
  }

  function emptyGridMessage() {
    if (showOnlyFavorites) {
      return 'No favorite videos found. Add videos to your favorites while watching them.';
    }
    if (searchQuery) {
      return 'No videos found matching your search.';
    }
    return 'No videos found. Add videos to your library folder.';
  }

  // --- Loading ---

  function setAdvancedQuery(active) {
    advancedQuery = active;
    // Advanced results are ranked by relevance; the sort does not apply to them.
    sortSelect.disabled = active;
  }

  function setAdvancedMode(enabled) {
    useAdvancedSearch = enabled;
    advancedSearchToggle.checked = enabled;
    searchInput.placeholder = enabled ? ADVANCED_PLACEHOLDER : 'Search';
    searchContainer.classList.toggle('advanced-mode', enabled);
    searchButton.hidden = !enabled;
    if (!enabled) setAdvancedQuery(false);
  }

  /**
   * Hide the Advanced toggle for this session (server has it disabled)
   */
  function hideAdvancedSearch() {
    setAdvancedMode(false);
    advancedSearchLabel.hidden = true;
    searchContainer.classList.add('no-advanced');
  }

  /**
   * Fetch one page of videos (advanced search falls back to regular search in the same request)
   * @returns {Promise<Object>} - { videos, totalCount, page, limit }
   */
  async function fetchVideoPage(page, signal) {
    if (advancedQuery) {
      const response = await fetch(appUrl('/api/videos/advanced-search'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, page: 1, limit: ADVANCED_LIMIT }),
        signal
      });
      if (response.ok) {
        return response.json();
      }

      const body = await response.json().catch(() => ({}));
      if (response.status === 400 && /not enabled/i.test(body.error || '')) {
        hideAdvancedSearch();
        showToast('Advanced search is not enabled on this server. Showing regular results.', 'error');
      } else if (body.fallback || response.status >= 500) {
        setAdvancedMode(false);
        showToast('Advanced search is unavailable right now. Showing regular results.', 'error');
      } else {
        throw new Error(body.error || `Advanced search failed (status: ${response.status})`);
      }
    }

    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: sortBy });
    if (searchQuery) {
      params.set('search', searchQuery);
    }
    const response = await fetch(appUrl(`/api/videos?${params}`), { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch videos (status: ${response.status})`);
    }
    return response.json();
  }

  function hasMorePages() {
    return !advancedQuery && allVideos.length < totalVideos;
  }

  /**
   * Live adds and deletes shift OFFSET pagination. Request the page that holds the first
   * video not loaded yet; any overlap with loaded videos is de-duplicated.
   */
  function nextPageToLoad() {
    return Math.max(1, Math.floor((currentPage * limit + offsetShift) / limit) + 1);
  }

  /**
   * Load videos. A fresh load (append=false) supersedes and aborts any in-flight
   * request; appends load the next page and are skipped while something is loading.
   */
  async function loadVideos(append = false) {
    if (append && isLoading) return;

    if (listAbortController) {
      listAbortController.abort();
    }
    const controller = new AbortController();
    listAbortController = controller;
    const requestSeq = ++listRequestSeq;
    const isCurrent = () => requestSeq === listRequestSeq;
    const page = append ? nextPageToLoad() : 1;
    const shiftAtRequest = append ? offsetShift : 0;

    isLoading = true;
    freshLoadPending = !append;
    if (append) {
      loadingIndicator.hidden = false;
    } else {
      // Reuse the page's initial skeleton so the first load does not shift layout.
      const current = videosGrid.firstElementChild;
      resetGrid(videosGrid.childElementCount === 1 && current.classList.contains('loading') ? current : createSkeleton());
      allVideos = [];
      offsetShift = 0;
    }

    let succeeded = false;
    try {
      const data = await fetchVideoPage(page, controller.signal);
      if (!isCurrent()) return;

      const pageVideos = data.videos || [];
      limit = data.limit || PAGE_SIZE;
      currentPage = data.page || page;
      offsetShift -= shiftAtRequest;
      // Only an appended page can overlap what is already loaded.
      const loadedIds = new Set(append ? allVideos.map((video) => String(video.id)) : []);
      const newVideos = pageVideos.filter((video) => !loadedIds.has(String(video.id)));
      allVideos = append ? allVideos.concat(newVideos) : newVideos;
      // An empty page means the server has nothing more, whatever the count said.
      totalVideos = pageVideos.length ? (data.totalCount || 0) : allVideos.length;
      freshLoadPending = false;

      await renderVideos(newVideos, append);
      succeeded = isCurrent();
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      console.error('Error loading videos:', error);
      if (append) {
        showToast('Could not load more videos.', 'error');
      } else {
        setGridMessage('Error loading videos. Please try again.', { error: true });
      }
    } finally {
      if (isCurrent()) {
        isLoading = false;
        freshLoadPending = false;
        listAbortController = null;
        loadingIndicator.hidden = true;
        updateSentinelState();
        if (succeeded) {
          pendingSseAdds.splice(0).forEach(handleSseAddVideo);
          rearmInfiniteScroll();
        }
      }
    }
  }

  function runSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = null;
    searchQuery = searchInput.value.trim();
    setAdvancedQuery(useAdvancedSearch && Boolean(searchQuery));
    searchContainer.classList.add('searching');
    loadVideos(false).finally(() => {
      searchContainer.classList.remove('searching');
    });
  }

  function handleSearchInput() {
    // Advanced (LLM) search only runs for a submitted query (Enter or the search button)
    if (useAdvancedSearch) return;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(runSearch, 300);
  }

  function handleSearchKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  }

  function handleAdvancedSearchToggle(event) {
    const showingAdvancedResults = advancedQuery;
    setAdvancedMode(event.target.checked);
    // Switching on waits for a submitted query; switching off replaces advanced results.
    if (showingAdvancedResults) {
      runSearch();
    }
  }

  function handleSortChange(event) {
    sortBy = event.target.value;
    loadVideos(false);
  }

  function handleFavoritesToggle(event) {
    showOnlyFavorites = event.target.checked;
    // A fresh load in flight applies the filter when it renders.
    if (freshLoadPending) return;
    // Filters the loaded videos; infinite scroll keeps loading pages while the sentinel is visible.
    renderVideos(allVideos, false).then(rearmInfiniteScroll);
  }

  function createSkeleton() {
    const skeleton = document.createElement('div');
    skeleton.className = 'loading';
    skeleton.setAttribute('aria-label', 'Loading videos');
    for (let i = 0; i < 8; i += 1) {
      skeleton.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton-card' }));
    }
    return skeleton;
  }

  function textElement(tag, className, text) {
    return Object.assign(document.createElement(tag), { className, textContent: text });
  }

  /**
   * Create a video card DOM element (text only via textContent/attributes)
   */
  function createVideoCardElement(video, { highPriorityThumbnail = false } = {}) {
    const videoId = String(video.id);
    const videoCard = document.createElement('div');
    videoCard.className = video.outcome && !video.outcome.good ? 'video-card is-loss' : 'video-card';
    videoCard.dataset.id = videoId;

    const link = document.createElement('a');
    link.className = 'video-card-link';
    link.href = appUrl(`/watch/${videoId}`);

    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.className = 'thumbnail-container';

    const thumbnailImage = document.createElement('img');
    thumbnailImage.className = 'thumbnail';
    thumbnailImage.src = video.thumbnail_path ? appUrl(video.thumbnail_path) : getPlaceholderThumbnail();
    thumbnailImage.alt = ''; // The title is rendered right below
    thumbnailImage.width = 640;
    thumbnailImage.height = 360;
    thumbnailImage.setAttribute('loading', highPriorityThumbnail ? 'eager' : 'lazy');
    thumbnailImage.setAttribute('decoding', 'async');
    thumbnailImage.setAttribute('fetchpriority', highPriorityThumbnail ? 'high' : 'auto');
    thumbnailContainer.appendChild(thumbnailImage);

    // Inside a session the date is in the header; a flat list shows it per card.
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    [...videoDetails(video), isGrouped() ? '' : formatDate(video.recorded_at)].filter(Boolean).forEach((text) => meta.appendChild(textElement('span', '', text)));
    if (video.outcome) {
      meta.appendChild(textElement('span', `outcome ${video.outcome.good ? 'good' : 'bad'}`, video.outcome.label));
    }
    meta.appendChild(textElement('span', 'card-duration', formatVideoDuration(video)));

    link.append(thumbnailContainer, textElement('h3', 'card-title', video.display_title), meta);

    const favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.className = 'favorite-indicator-grid';
    favoriteButton.dataset.videoId = videoId;
    favoriteButton.setAttribute('aria-label', `Favorite: ${video.display_title}`);
    renderGridFavorite(favoriteButton, isFavorite(videoId));

    videoCard.append(link, favoriteButton);

    // Seed list-provided preview metadata without a per-card API request.
    videoPreviewManager.primePreviewInfo(videoId, video.preview);

    return videoCard;
  }

  // --- Sessions: a chronological list is grouped by play day ---
  function isGrouped() {
    return !advancedQuery && (sortBy === 'recorded_desc' || sortBy === 'recorded_asc');
  }

  function recordedTime(video) {
    return new Date(video.recorded_at).getTime() || 0;
  }

  function playDay(video) {
    const date = new Date(recordedTime(video) - DAY_START_HOUR * 60 * 60 * 1000);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function createSession(grouped) {
    const section = document.createElement('section');
    section.className = 'session';
    if (grouped) {
      const header = document.createElement('header');
      header.className = 'session-header';
      const pulls = textElement('div', 'session-pulls', '');
      pulls.append(textElement('div', 'session-strip', ''), textElement('p', 'session-summary', ''), textElement('p', 'session-range', ''));
      header.append(textElement('h2', 'session-date', ''), pulls);
      section.appendChild(header);
    }
    section.appendChild(textElement('div', 'session-grid', ''));
    sessionVideos.set(section, []);
    return section;
  }

  function countLabel(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  function sessionTick(video) {
    const tone = video.outcome ? (video.outcome.good ? ' good' : ' bad') : '';
    const tick = textElement('button', `session-tick${tone}`, '');
    tick.type = 'button';
    tick.dataset.id = String(video.id);
    const label = [video.display_title, video.outcome && video.outcome.label, formatTime(video.recorded_at)].filter(Boolean).join(', ');
    tick.title = label;
    tick.setAttribute('aria-label', `Play ${label}`);
    return tick;
  }

  /** Header: the day, its time range, and a strip of the recordings in the order they happened */
  function updateSessionHeader(section) {
    const videos = sessionVideos.get(section);
    const header = section.querySelector('.session-header');
    if (!header || !videos.length) return;

    const chronological = [...videos].sort((a, b) => recordedTime(a) - recordedTime(b));
    const first = new Date(recordedTime(chronological[0]));
    const last = new Date(recordedTime(chronological[chronological.length - 1]));
    const day = new Date(first.getTime() - DAY_START_HOUR * 60 * 60 * 1000);
    const sameYear = day.getFullYear() === new Date().getFullYear();
    header.querySelector('.session-date').textContent = day.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' })
    });
    const [from, to] = [formatTime(first), formatTime(last)];
    header.querySelector('.session-range').textContent = from === to ? from : `${from} – ${to}`;
    header.querySelector('.session-strip').replaceChildren(...chronological.map(sessionTick));

    const kills = videos.filter((video) => video.outcome && video.outcome.label === 'Kill').length;
    const wipes = videos.filter((video) => video.outcome && video.outcome.label === 'Wipe').length;
    header.querySelector('.session-summary').textContent = [
      countLabel(videos.length, 'recording'),
      kills ? countLabel(kills, 'kill') : '',
      wipes ? countLabel(wipes, 'wipe') : ''
    ].filter(Boolean).join(', ');
  }

  /**
   * Put a card into the session it belongs to, creating a session at that end when
   * it is from another play day than its neighbor (a flat list is one headerless session).
   */
  function placeCard(video, card, { atStart = false } = {}) {
    const grouped = isGrouped();
    const sessions = videosGrid.querySelectorAll(':scope > .session');
    let section = atStart ? sessions[0] : sessions[sessions.length - 1];
    const videos = section && sessionVideos.get(section);
    const neighbor = videos && (atStart ? videos[0] : videos[videos.length - 1]);
    if (!section || (grouped && (!neighbor || playDay(neighbor) !== playDay(video)))) {
      section = createSession(grouped);
      if (atStart) videosGrid.prepend(section); else videosGrid.appendChild(section);
    }
    const grid = section.querySelector('.session-grid');
    if (atStart) {
      sessionVideos.get(section).unshift(video);
      grid.prepend(card);
    } else {
      sessionVideos.get(section).push(video);
      grid.appendChild(card);
    }
    return section;
  }

  function removeCard(card) {
    const section = card.closest('.session');
    card.remove();
    if (!section) return;
    const videos = sessionVideos.get(section).filter((video) => String(video.id) !== card.dataset.id);
    sessionVideos.set(section, videos);
    if (videos.length) updateSessionHeader(section); else section.remove();
  }

  /**
   * Render videos into the grid in rAF-sized chunks
   * @param {Array} videosToRender
   * @param {boolean} append - Append to the grid instead of replacing it
   */
  async function renderVideos(videosToRender, append = false) {
    const displayedVideos = showOnlyFavorites
      ? videosToRender.filter((video) => isFavorite(video.id))
      : videosToRender;

    if (!append) {
      if (displayedVideos.length === 0) {
        setGridMessage(emptyGridMessage());
        return;
      }
      resetGrid();
    } else if (displayedVideos.length === 0) {
      return;
    } else {
      const emptyState = videosGrid.querySelector('.empty-state');
      if (emptyState) emptyState.remove();
    }

    const generation = renderGeneration;
    const chunkSize = 12;
    const baseIndex = append ? videosGrid.querySelectorAll('.video-card').length : 0;

    for (let start = 0; start < displayedVideos.length; start += chunkSize) {
      const touched = new Set();
      displayedVideos.slice(start, start + chunkSize).forEach((video, index) => {
        touched.add(placeCard(video, createVideoCardElement(video, {
          highPriorityThumbnail: !append && baseIndex + start + index < 6
        })));
      });
      touched.forEach(updateSessionHeader);

      if (start + chunkSize < displayedVideos.length) {
        await nextFrame();
        if (generation !== renderGeneration) return; // A newer render replaced the grid
      }
    }
  }

  // --- Infinite scroll ---
  function loadNextPageIfNeeded() {
    if (!isLoading && hasMorePages()) {
      loadVideos(true);
    }
  }

  function updateSentinelState() {
    videosLoadSentinel.classList.toggle('is-idle', !hasMorePages());
  }

  /**
   * IntersectionObserver only reports changes. On tall viewports the sentinel never
   * leaves the (expanded) viewport, so re-observe after each load to get a fresh report.
   */
  function rearmInfiniteScroll() {
    if (!infiniteScrollObserver || !hasMorePages()) {
      return;
    }
    infiniteScrollObserver.unobserve(videosLoadSentinel);
    infiniteScrollObserver.observe(videosLoadSentinel);
  }

  function initializeInfiniteScroll() {
    if (typeof window.IntersectionObserver !== 'function') {
      return;
    }
    infiniteScrollObserver = new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadNextPageIfNeeded();
      }
    }, { root: null, rootMargin: '1200px 0px', threshold: 0 });
    infiniteScrollObserver.observe(videosLoadSentinel);
    updateSentinelState();
  }

  // --- Library scan ---
  function resetRefreshButtonState() {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Rescan';
  }

  function setScanStatus(text, statusClass = 'idle') {
    clearTimeout(scanStatusClearTimer);
    scanStatusElement.textContent = text;
    scanStatusElement.className = `scan-status ${statusClass}`;
    scanStatusElement.hidden = !text;
  }

  /**
   * Show a running scan (from any tab). How it ends is only reported when this page
   * saw it running, so a stale "completed" from an earlier scan never shows.
   * @param {Object|null} statusData - null when the status request failed
   */
  function updateScanStatusUI(statusData) {
    if (statusData && statusData.status === 'running') {
      scanWatched = true;
      setScanStatus(`Scanning... (${statusData.message || ''})`, 'running');
      refreshBtn.disabled = true;
      return;
    }

    resetRefreshButtonState();
    if (!scanWatched) {
      setScanStatus('');
      return;
    }
    scanWatched = false;
    const reloadList = scanStartedHere;
    scanStartedHere = false;

    if (!statusData) {
      setScanStatus('Error fetching scan status.', 'failed');
    } else if (statusData.status === 'completed') {
      setScanStatus(`Scan completed: ${statusData.message || 'Finished.'}`, 'completed');
      if (reloadList) {
        showToast('Scan complete. Reloading video list...');
        setTimeout(() => loadVideos(false), 1500);
      }
    } else if (statusData.status === 'failed') {
      setScanStatus(`Scan failed: ${statusData.message || 'An error occurred.'}`, 'failed');
    } else {
      setScanStatus('');
      return;
    }
    scanStatusClearTimer = setTimeout(() => setScanStatus(''), 10000);
  }

  /**
   * Check the scan status; keeps polling every 5 s only while a scan is running.
   */
  async function checkScanStatus() {
    const seq = ++scanCheckSeq;
    let statusData = null;
    try {
      const response = await fetch(appUrl('/api/scan/status'));
      if (!response.ok) {
        throw new Error(`Failed to fetch scan status: ${response.status}`);
      }
      statusData = await response.json();
    } catch (error) {
      console.error('Error polling scan status:', error);
    }
    if (seq !== scanCheckSeq) return; // A newer check superseded this one

    updateScanStatusUI(statusData);
    const running = Boolean(statusData) && statusData.status === 'running';
    if (running && !scanPollTimer) {
      scanPollTimer = setInterval(checkScanStatus, 5000);
    } else if (!running && scanPollTimer) {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
    }
  }

  /**
   * Start a library scan
   */
  async function refreshLibrary() {
    if (refreshBtn.disabled) {
      return;
    }

    scanWatched = true;
    scanStartedHere = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Scanning…';
    setScanStatus('Initiating Scan...', 'running');
    try {
      const response = await fetch(appUrl('/api/refresh'), { method: 'POST' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to initiate scan (status: ${response.status})`);
      }
      showToast('Library scan initiated.');
      checkScanStatus();
    } catch (error) {
      console.error('Error initiating library scan:', error);
      scanWatched = false;
      scanStartedHere = false;
      resetRefreshButtonState();
      showToast(`Error: ${error.message || 'Failed to initiate scan.'}`, 'error');
      setScanStatus('Failed to initiate scan.', 'failed');
    }
  }

  // --- Live updates (SSE) ---
  function connectSSE() {
    const source = new EventSource(appUrl('/api/updates'));
    sseEventSource = source;

    source.onopen = () => {
      sseFailures = 0;
    };
    // While CONNECTING the browser retries by itself; CLOSED means it gave up (e.g. an HTTP 401).
    source.onerror = () => {
      sseFailures += 1;
      if (source.readyState === 2 || sseFailures >= SSE_MAX_FAILURES) {
        source.close();
        if (sseEventSource === source) sseEventSource = null;
        handleSseLost();
      }
    };
    source.onmessage = (event) => {
      try {
        const updateData = JSON.parse(event.data);
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
   * The update stream closed. An expired session sends the user to the login page;
   * otherwise reconnect a few times, then stop and say so.
   */
  async function handleSseLost() {
    const status = await fetch(appUrl('/api/scan/status')).then((response) => response.status, () => 0);
    if (status === 401) {
      window.location.assign(appUrl('/login.html'));
      return;
    }
    if (sseFailures >= SSE_MAX_FAILURES) {
      showToast('Live updates stopped. Reload the page to reconnect.', 'error');
      return;
    }
    setTimeout(connectSSE, 5000);
  }

  /**
   * A video was added. Only the default view (no search, newest first) can show it
   * in the right place; otherwise just announce it.
   */
  function handleSseAddVideo(newVideo) {
    if (!newVideo || newVideo.id === undefined || newVideo.id === null || typeof newVideo.title !== 'string') {
      return;
    }
    if (freshLoadPending) {
      pendingSseAdds.push(newVideo); // The fresh list replaces allVideos; apply this after it lands
      return;
    }
    const videoId = String(newVideo.id);
    if (allVideos.some((video) => String(video.id) === videoId)) {
      return;
    }

    if (searchQuery || sortBy !== DEFAULT_SORT) {
      showToast(`New video added: ${newVideo.display_title}. Clear the search and sort by newest to see it.`);
      return;
    }

    allVideos.unshift(newVideo);
    totalVideos += 1;
    offsetShift += 1;

    if (!showOnlyFavorites || isFavorite(videoId)) {
      const emptyState = videosGrid.querySelector('.empty-state');
      if (emptyState) emptyState.remove();
      updateSessionHeader(placeCard(newVideo, createVideoCardElement(newVideo), { atStart: true }));
    }
    updateSentinelState();
    showToast(`Video added: ${newVideo.display_title}`);
  }

  function handleSseDeleteVideo(videoId) {
    const id = String(videoId);
    const initialLength = allVideos.length;
    allVideos = allVideos.filter((video) => String(video.id) !== id);
    if (allVideos.length < initialLength) {
      totalVideos = Math.max(0, totalVideos - 1);
      offsetShift -= 1;
    }

    const videoCard = findGridCard(id);
    if (!videoCard) {
      return;
    }
    videoPreviewManager.hidePreview(videoCard, id, { immediate: true });

    removeCard(videoCard);
    if (!videosGrid.querySelector('.video-card')) {
      setGridMessage(emptyGridMessage());
    }
    showToast('Video removed.');
  }

  // --- Video overlay (a modal <dialog>: inert page, focus trap and focus return are native) ---
  function isOverlayOpen() {
    return overlay.open;
  }

  function getOverlayVideo() {
    // Plyr.destroy() swaps in a clone of the element, so always look it up.
    return document.getElementById('overlay-video-player');
  }

  function showOverlayLoading() {
    if (overlayPlayerContainer.querySelector('.theater-loading')) return;
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'theater-loading';
    loadingOverlay.appendChild(textElement('div', 'loading-spinner', ''));
    overlayPlayerContainer.appendChild(loadingOverlay);
  }

  function setOverlayVideoReady(ready) {
    if (overlayMediaListeners) {
      overlayMediaListeners.abort();
      overlayMediaListeners = null;
    }
    clearTimeout(overlayReadyTimer);
    overlayPlayerContainer.querySelectorAll('.theater-loading').forEach((node) => node.remove());
    overlayPlayerContainer.classList.toggle('is-video-ready', ready);
  }

  /**
   * Destroy the overlay player and stop any stream download
   */
  function teardownOverlayPlayer() {
    setOverlayVideoReady(false);

    if (overlayPlayer) {
      try {
        overlayPlayer.destroy();
      } catch (error) {
        console.warn('Error destroying Plyr player:', error);
      }
      overlayPlayer = null;
    }

    const overlayVideo = getOverlayVideo();
    if (overlayVideo.hasAttribute('src')) {
      overlayVideo.pause();
      overlayVideo.removeAttribute('src');
      overlayVideo.load();
    }
  }

  /**
   * Open the overlay player for a video. Uses the card data already loaded and only
   * fetches /api/videos/:id on a miss (back/forward to a video not in the list).
   */
  async function openVideoOverlay(videoId, event, { updateHistory = true } = {}) {
    const id = String(videoId);
    const generation = ++overlayGeneration;
    const isCurrent = () => generation === overlayGeneration;

    if (overlayFetchController) {
      overlayFetchController.abort();
      overlayFetchController = null;
    }
    teardownOverlayPlayer();

    overlayCurrentVideoId = id;
    document.getElementById('overlay-video-title').textContent = '';
    document.getElementById('overlay-video-meta').replaceChildren();
    PlayerCore.renderFavoriteButton(overlayFavoriteBtn, id);
    overlayShareMenu.close();
    showOverlayLoading();

    if (!overlay.open) {
      overlay.showModal();
    }

    // Switching videos inside the overlay replaces its history entry, so one Back always closes it.
    // (Re-opened while a close is still popping the old entry: that popstate re-adds it.)
    if (updateHistory && !historyBackPending) {
      const state = { videoOverlay: true, videoId: id };
      const url = appUrl(`/watch/${id}`);
      if (history.state && history.state.videoOverlay) {
        history.replaceState(state, '', url);
      } else {
        history.pushState(state, '', url);
      }
    }

    videoPreviewManager.pause();

    try {
      let video = allVideos.find((candidate) => String(candidate.id) === id);
      if (!video) {
        const controller = new AbortController();
        overlayFetchController = controller;
        const response = await fetch(appUrl(`/api/videos/${id}`), { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch video (status: ${response.status})`);
        }
        video = await response.json();
        if (!isCurrent()) return;
        overlayFetchController = null;
      }

      document.getElementById('overlay-video-title').textContent = video.display_title;
      PlayerCore.renderVideoMeta(document.getElementById('overlay-video-meta'), video);
      document.title = `${video.display_title} - ${vodsName}`;

      const Plyr = await PlayerCore.loadPlyr().catch((error) => {
        console.warn('Plyr unavailable, using native controls:', error);
        return null;
      });
      if (!isCurrent()) return;

      const overlayVideo = getOverlayVideo();
      if (Plyr) {
        overlayPlayer = PlayerCore.createPlayer(Plyr, overlayVideo, {
          deathTimestamps: PlayerCore.parseDeathTimestamps(video.death_timestamps)
        });
      }

      // Hide the spinner once playback can start (or fails), with a safety timeout.
      overlayMediaListeners = new AbortController();
      ['playing', 'canplay', 'error'].forEach((eventName) => {
        overlayVideo.addEventListener(eventName, () => setOverlayVideoReady(true), { once: true, signal: overlayMediaListeners.signal });
      });
      overlayReadyTimer = setTimeout(() => setOverlayVideoReady(true), 8000);

      overlayVideo.src = appUrl(`/api/videos/${id}/stream`);
      if (!Plyr) {
        overlayVideo.play().catch(() => {});
      }
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      console.error('Error opening video overlay:', error);
      showToast('Failed to load video. Please try again.', 'error');
      closeVideoOverlay();
    }
  }

  /**
   * Close the overlay; cancels any pending open
   */
  function closeVideoOverlay({ updateHistory = true } = {}) {
    if (!isOverlayOpen()) return;
    overlayGeneration += 1;
    if (overlayFetchController) {
      overlayFetchController.abort();
      overlayFetchController = null;
    }

    teardownOverlayPlayer();
    overlayCurrentVideoId = null;
    overlayShareMenu.close();
    overlay.close();
    document.title = vodsName;
    videoPreviewManager.resume();

    if (updateHistory) {
      if (history.state && history.state.videoOverlay) {
        historyBackPending = true;
        history.back(); // Pop the overlay's own entry, so Back does not re-open this video
      } else if (window.location.pathname !== appUrl('/')) {
        history.replaceState(null, '', appUrl('/'));
      }
    }
  }

  function updateGridFavorite(videoId, favorited) {
    const gridCard = findGridCard(videoId);
    const gridButton = gridCard ? gridCard.querySelector('.favorite-indicator-grid') : null;
    if (gridButton) {
      renderGridFavorite(gridButton, favorited);
    }
  }

  function handleOverlayPopState() {
    if (historyBackPending) {
      historyBackPending = false;
      if (overlayCurrentVideoId) {
        history.pushState({ videoOverlay: true, videoId: overlayCurrentVideoId }, '', appUrl(`/watch/${overlayCurrentVideoId}`));
      }
      return;
    }
    const videoId = PlayerCore.videoIdFromPath(window.location.pathname);
    if (videoId) {
      if (overlayCurrentVideoId !== videoId) {
        openVideoOverlay(videoId, null, { updateHistory: false });
      }
    } else if (overlayCurrentVideoId) {
      closeVideoOverlay({ updateHistory: false });
    }
  }

  function updateFavoriteIndicatorsOnGrid() {
    videosGrid.querySelectorAll('.favorite-indicator-grid').forEach((button) => {
      renderGridFavorite(button, isFavorite(button.dataset.videoId));
    });
  }

  // --- Event Listeners ---
  videosGrid.addEventListener('click', handleVideoGridClick);
  videosGrid.addEventListener('pointerover', handleFirstCardHover);
  videoPreviewManager.attachToGrid(videosGrid);

  searchInput.addEventListener('input', handleSearchInput);
  searchInput.addEventListener('keydown', handleSearchKeyDown);
  searchButton.addEventListener('click', runSearch);
  advancedSearchToggle.addEventListener('change', handleAdvancedSearchToggle);
  refreshBtn.addEventListener('click', refreshLibrary);
  sortSelect.addEventListener('change', handleSortChange);
  favoritesToggle.addEventListener('change', handleFavoritesToggle);

  // A click on the dialog element itself is a click on its backdrop.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeVideoOverlay();
  });
  overlayCloseButton.addEventListener('click', () => closeVideoOverlay());
  PlayerCore.bindFavoriteButton(overlayFavoriteBtn, () => overlayCurrentVideoId, updateGridFavorite);
  window.addEventListener('popstate', handleOverlayPopState);

  // Escape: close through closeVideoOverlay so history and the player are cleaned up too.
  overlay.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (overlayPlayer && overlayPlayer.fullscreen && overlayPlayer.fullscreen.active) return; // Plyr exits fullscreen first
    closeVideoOverlay();
  });

  // Back/forward cache: favorites may have changed on the player page; the update stream was closed.
  window.addEventListener('pagehide', () => {
    if (sseEventSource) {
      sseEventSource.close();
      sseEventSource = null;
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reloadFavorites();
      updateFavoriteIndicatorsOnGrid();
      if (!sseEventSource) connectSSE();
    }
  });

  // --- Initial Load ---
  getAppConfig().then((config) => {
    vodsName = config.vodsName;
    document.getElementById('app-title').textContent = vodsName;
    document.getElementById('footer-text').textContent = vodsName;
    if (!overlayCurrentVideoId) {
      document.title = vodsName;
    }
    if (config.advancedSearch !== true) {
      hideAdvancedSearch();
    }
  });

  sortSelect.value = sortBy;
  loadVideos(false);
  checkScanStatus();
  connectSSE();
  initializeInfiniteScroll();
}
