/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.resolve(__dirname, '..', '..', 'public/index.html');
const SCRIPT_PATHS = ['public/js/utils.js', 'public/js/video-preview.js', 'public/js/player.js', 'public/js/main.js'];

const jsonResponse = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

/**
 * Deferred promise helper for controlling response order.
 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Page-aware /api/videos handler over an in-memory list.
 */
function listResponse(videos, urlString) {
  const params = new URL(urlString, 'http://localhost').searchParams;
  const page = Number(params.get('page') || 1);
  const limit = Number(params.get('limit') || 20);
  const search = params.get('search');
  const matching = search ? videos.filter((video) => video.title.includes(search)) : videos;
  return {
    videos: matching.slice((page - 1) * limit, page * limit),
    totalCount: matching.length,
    page,
    limit
  };
}

/**
 * Boot the index page in jsdom.
 * @param {string} baseHref
 * @param {Array} videos
 * @param {Object} [options]
 * @returns {JSDOM}
 */
function bootApp(baseHref, videos, options = {}) {
  const {
    configResponse = jsonResponse({ vodsName: 'Test', advancedSearch: true }),
    urlPath = '/',
    scanStatusResponses = [],
    listHandler = null,
    detailHandler = null,
    advancedHandler = null,
    intersectionObserver = false
  } = options;

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  if (baseHref !== '/') {
    html = html.replace('<base href="/">', `<base href="${baseHref}">`);
  }
  const dom = new JSDOM(html, { url: `http://localhost${urlPath}`, runScripts: 'outside-only' });
  const { window } = dom;

  // jsdom gaps used by main.js
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  window.setInterval = jest.fn(() => 1); // Scan polling must not keep the test alive
  window.clearInterval = jest.fn();
  window.HTMLMediaElement.prototype.load = jest.fn();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  window.EventSource = class MockEventSource {
    constructor(url) {
      this.url = url;
      MockEventSource.instances.push(this);
    }
    close() {}
    addEventListener() {}
  };
  window.EventSource.instances = [];
  window.Plyr = class MockPlyr {
    constructor(element, config) {
      this.element = element;
      this.config = config;
      this.currentTime = 0;
      MockPlyr.instances.push(this);
    }
    on() {}
    pause() {}
    destroy() {}
  };
  window.Plyr.instances = [];

  if (intersectionObserver) {
    // 'tall': a viewport tall enough that the sentinel is always within rootMargin (a real
    // IntersectionObserver reports once per observe() call and then only on changes).
    // 'manual': the test scrolls by calling window.scrollSentinelIntoView().
    window.IntersectionObserver = class MockIntersectionObserver {
      constructor(callback) {
        this.callback = callback;
        window.scrollSentinelIntoView = () => callback([{ isIntersecting: true }]);
      }
      observe(target) {
        if (intersectionObserver === 'manual') return;
        setTimeout(() => this.callback([{ target, isIntersecting: true }]), 0);
      }
      unobserve() {}
      disconnect() {}
    };
  }

  const videosById = new Map(videos.map((video) => [String(video.id), video]));
  window.fetch = jest.fn((url, init) => {
    const urlString = String(url);
    if (urlString.includes('/api/config')) {
      return configResponse;
    }
    if (urlString.includes('/api/scan/status')) {
      return scanStatusResponses.length > 0
        ? scanStatusResponses.shift()
        : jsonResponse({ status: 'idle' });
    }
    if (urlString.includes('/api/refresh')) {
      return jsonResponse({}, 202);
    }
    if (urlString.includes('/api/videos/advanced-search')) {
      return advancedHandler ? advancedHandler(urlString, init) : jsonResponse({ error: 'Advanced search is not enabled' }, 400);
    }
    if (urlString.includes('/api/videos?')) {
      return listHandler ? listHandler(urlString, init) : jsonResponse(listResponse(videos, urlString));
    }
    const detailMatch = urlString.match(/\/api\/videos\/(\d+)$/);
    if (detailMatch) {
      if (detailHandler) return detailHandler(detailMatch[1], init);
      const video = videosById.get(detailMatch[1]);
      return video ? jsonResponse(video) : jsonResponse({}, 404);
    }
    return jsonResponse({}, 404);
  });

  for (const script of SCRIPT_PATHS) {
    window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', script), 'utf8'));
  }
  return dom;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Let jsdom's natural DOMContentLoaded fire, then allow async init to settle.
 * @param {JSDOM} dom
 * @returns {Promise<Window>}
 */
async function startApp(dom) {
  await wait(0);
  await wait(150);
  return dom.window;
}

const fetchedUrls = (window) => window.fetch.mock.calls.map((call) => String(call[0]));

const sampleVideo = {
  id: 42,
  title: 'Evandis Pull +1',
  duration: 65,
  duration_formatted: '01:05',
  thumbnail_path: '/thumbnails/evandis.jpg',
  added_date: '2026-08-01T12:00:00.000Z',
  death_timestamps: null
};

function makeVideos(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: count - index,
    title: `Mythic run number ${count - index}`,
    duration: 1500,
    duration_formatted: '25:00',
    thumbnail_path: null,
    added_date: '2026-01-01T00:00:00.000Z',
    death_timestamps: '[12.5, 80]',
    preview: { hasPreview: false, status: 'pending', firstTimestamp: null }
  }));
}

describe('Video card building with base href', () => {
  test('base "/" keeps all local URLs root-relative', async () => {
    const dom = bootApp('/', [sampleVideo]);
    const window = await startApp(dom);

    const fetched = fetchedUrls(window);
    expect(fetched).toContain('/api/config');
    expect(fetched).toContain('/api/videos?page=1&limit=20&sort=date_added_desc');
    expect(fetched).toContain('/api/scan/status');
    expect(window.EventSource.instances.map((source) => source.url)).toEqual(['/api/updates']);
    expect(window.setInterval).not.toHaveBeenCalled();

    const card = window.document.querySelector('.video-card');
    expect(card).toBeTruthy();
    expect(card.querySelector('.video-card-link').getAttribute('href')).toBe('/watch/42');
    expect(card.querySelector('.thumbnail').getAttribute('src')).toBe('/thumbnails/evandis.jpg');
    expect(card.querySelector('.thumbnail').getAttribute('loading')).toBe('eager');
    expect(card.querySelector('.thumbnail').getAttribute('width')).toBe('640');
    expect(card.querySelector('.duration-badge').textContent).toBe('01:05');
    expect(card.querySelector('.video-title').textContent).toBe('Evandis Pull +1');
    expect(card.querySelector('.outcome-indicator').className).toBe('outcome-indicator success');
    const favorite = card.querySelector('.favorite-indicator-grid');
    expect(favorite.tagName).toBe('BUTTON');
    expect(favorite.getAttribute('data-video-id')).toBe('42');
    expect(favorite.getAttribute('aria-pressed')).toBe('false');

    // Opening the overlay uses the card data: no detail request, base-relative media/history URLs
    const overlayVideo = window.document.getElementById('overlay-video-player');
    card.querySelector('.video-card-link').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await wait(50);
    expect(window.location.pathname).toBe('/watch/42');
    expect(overlayVideo.getAttribute('src')).toBe('/api/videos/42/stream');
    expect(fetchedUrls(window)).not.toContain('/api/videos/42');
    expect(window.document.getElementById('overlay-video-title').textContent).toBe('Evandis Pull +1');
    expect(window.document.title).toBe('Test - Evandis Pull +1');
    expect(window.Plyr.instances).toHaveLength(1);
    expect(window.Plyr.instances[0].config.iconUrl).toBe('/vendor/plyr/plyr.svg');
    expect(window.Plyr.instances[0].config.blankVideo).toBe('/vendor/plyr/blank.mp4');
    overlayVideo.dispatchEvent(new window.Event('canplay'));

    // Closing (close button, no inline handler) restores the root home URL and stops the stream
    window.document.querySelector('.video-overlay-close').click();
    await wait(350);
    expect(window.location.pathname).toBe('/');
    expect(window.document.getElementById('overlay-video-player').hasAttribute('src')).toBe(false);
    expect(window.document.title).toBe('Test');
  });

  test('base "/vod/" resolves every local URL beneath /vod exactly once', async () => {
    const secondVideo = {
      id: 77,
      title: 'A wipe',
      duration: 120,
      duration_formatted: '02:00',
      thumbnail_path: '/thumbnails/wipe.jpg',
      added_date: '2026-08-02T12:00:00.000Z',
      death_timestamps: null
    };
    const dom = bootApp('/vod/', [sampleVideo, secondVideo], { urlPath: '/vod/' });
    const window = await startApp(dom);

    const fetched = fetchedUrls(window);
    expect(fetched).toContain('/vod/api/config');
    expect(fetched).toContain('/vod/api/videos?page=1&limit=20&sort=date_added_desc');
    expect(fetched).toContain('/vod/api/scan/status');
    expect(window.EventSource.instances.map((source) => source.url)).toEqual(['/vod/api/updates']);

    const card = window.document.querySelector('.video-card');
    expect(card.querySelector('.video-card-link').getAttribute('href')).toBe('/vod/watch/42');
    expect(card.querySelector('.thumbnail').getAttribute('src')).toBe('/vod/thumbnails/evandis.jpg');

    const overlayVideo = window.document.getElementById('overlay-video-player');
    card.querySelector('.video-card-link').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await wait(50);
    expect(window.location.pathname).toBe('/vod/watch/42');
    expect(overlayVideo.getAttribute('src')).toBe('/vod/api/videos/42/stream');
    expect(window.Plyr.instances[0].config.iconUrl).toBe('/vod/vendor/plyr/plyr.svg');
    overlayVideo.dispatchEvent(new window.Event('canplay'));

    window.document.querySelector('.video-overlay-backdrop').click();
    await wait(350);
    expect(window.location.pathname).toBe('/vod/');

    // Popstate with a base-prefixed watch path reopens the right video
    window.history.pushState({}, '', '/vod/watch/77');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await wait(50);
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(true);
    expect(window.document.getElementById('overlay-video-player').getAttribute('src')).toBe('/vod/api/videos/77/stream');
  });

  test('renders videos without waiting for a slow config response', async () => {
    const dom = bootApp('/', [sampleVideo], { configResponse: new Promise(() => {}) });
    const window = await startApp(dom);

    expect(fetchedUrls(window)).toContain('/api/videos?page=1&limit=20&sort=date_added_desc');
    expect(window.document.querySelector('.video-card')).toBeTruthy();
  });

  test('closing the overlay pops its history entry, so Back does not re-open the video', async () => {
    const dom = bootApp('/', [sampleVideo, { ...sampleVideo, id: 43, title: 'Second' }]);
    const window = await startApp(dom);
    const lengthBefore = window.history.length;
    const openCard = (id) => window.document.querySelector(`.video-card[data-id="${id}"] .video-card-link`)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    openCard(42);
    await wait(20);
    // Switching videos inside the overlay (e.g. via Back/Forward) replaces the entry instead of stacking
    window.history.replaceState(window.history.state, '', '/watch/42');
    expect(window.history.length).toBe(lengthBefore + 1);

    window.document.querySelector('.video-overlay-close').click();
    await wait(50);
    expect(window.location.pathname).toBe('/');
    expect(window.history.length).toBe(lengthBefore + 1); // no extra entry to go "Back" into
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(false);

    // Forward (the browser's own entry) re-opens it, as expected
    window.history.forward();
    await wait(50);
    expect(window.location.pathname).toBe('/watch/42');
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(true);
  });

  test('stops polling when a pre-existing scan reaches a terminal state', async () => {
    const scanResponses = [
      jsonResponse({ status: 'running' }),
      jsonResponse({ status: 'completed' })
    ];
    const dom = bootApp('/', [sampleVideo], { scanStatusResponses: scanResponses });
    const window = await startApp(dom);

    expect(window.setInterval).toHaveBeenCalledTimes(1);
    await window.setInterval.mock.calls[0][0]();
    expect(window.clearInterval).toHaveBeenCalledWith(1);
  });

  test('a scan running elsewhere is shown, and a stale "completed" status is not', async () => {
    const running = bootApp('/', [sampleVideo], { scanStatusResponses: [jsonResponse({ status: 'running', message: '3/10' })] });
    const runningWindow = await startApp(running);
    const status = runningWindow.document.getElementById('scan-status');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Scanning... (3/10)');
    expect(runningWindow.document.getElementById('refresh-btn').disabled).toBe(true);

    const stale = bootApp('/', [sampleVideo], { scanStatusResponses: [jsonResponse({ status: 'completed', message: 'old' })] });
    const staleWindow = await startApp(stale);
    expect(staleWindow.document.getElementById('scan-status').hidden).toBe(true);
    expect(staleWindow.setInterval).not.toHaveBeenCalled();
  });

  test('a refresh started here reports completion and reloads the list once', async () => {
    const scanResponses = [jsonResponse({ status: 'idle' }), jsonResponse({ status: 'running' })];
    const dom = bootApp('/', [sampleVideo], { scanStatusResponses: scanResponses });
    const window = await startApp(dom);

    window.document.getElementById('refresh-btn').click();
    await wait(20);
    expect(window.document.getElementById('scan-status').textContent).toBe('Scanning... ()');
    expect(window.setInterval).toHaveBeenCalledTimes(1);

    scanResponses.push(jsonResponse({ status: 'completed', message: '2 added' }));
    await window.setInterval.mock.calls[0][0]();
    await wait(1700);
    expect(window.document.getElementById('scan-status').textContent).toBe('Scan completed: 2 added');
    expect(window.clearInterval).toHaveBeenCalledWith(1);
    expect(fetchedUrls(window).filter((url) => url.startsWith('/api/videos?'))).toHaveLength(2);
    expect(window.document.getElementById('refresh-btn').disabled).toBe(false);
  });

  test('malicious title/thumbnail payload stays inert', async () => {
    const maliciousVideo = {
      id: 999,
      title: '<img src=x onerror="window.__pwned=1"><svg onload="window.__pwned=1"></svg>',
      duration: 65,
      duration_formatted: '01:05',
      thumbnail_path: '/thumbnails/"><img src=x onerror="window.__pwned=1">.jpg',
      added_date: '2026-08-01T12:00:00.000Z',
      death_timestamps: null
    };
    const dom = bootApp('/', [maliciousVideo]);
    const window = await startApp(dom);

    const card = window.document.querySelector('.video-card');
    expect(card).toBeTruthy();
    expect(card.querySelectorAll('svg').length).toBe(0);
    expect(card.querySelectorAll('script').length).toBe(0);
    expect(card.querySelectorAll('iframe').length).toBe(0);
    expect(card.querySelectorAll('img').length).toBe(1);
    expect(card.querySelectorAll('[onerror]').length).toBe(0);
    expect(card.querySelectorAll('[onload]').length).toBe(0);

    // The payload is inert data: title renders as text, thumbnail stays a raw src value
    expect(card.querySelector('.video-title').textContent).toBe(maliciousVideo.title);
    expect(card.querySelector('.thumbnail').getAttribute('src')).toBe(maliciousVideo.thumbnail_path);
    expect(window.__pwned).toBeUndefined();

    const grid = window.document.getElementById('videos-grid');
    expect(grid.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length).toBe(0);
  });

  test('durations over an hour render as H:MM:SS on cards', async () => {
    const longVideo = { ...sampleVideo, id: 5, duration: 4530, duration_formatted: '75:30' };
    const dom = bootApp('/', [longVideo]);
    const window = await startApp(dom);

    expect(window.document.querySelector('.duration-badge').textContent).toBe('1:15:30');
  });
});

describe('Video list loading', () => {
  test('infinite scroll re-arms after each page so tall viewports reach every video', async () => {
    const videos = makeVideos(45);
    const dom = bootApp('/', videos, { intersectionObserver: 'tall' });
    const window = await startApp(dom);
    await wait(300);

    const listCalls = fetchedUrls(window).filter((url) => url.includes('/api/videos?'));
    expect(listCalls).toEqual([
      '/api/videos?page=1&limit=20&sort=date_added_desc',
      '/api/videos?page=2&limit=20&sort=date_added_desc',
      '/api/videos?page=3&limit=20&sort=date_added_desc'
    ]);
    const renderedIds = [...window.document.querySelectorAll('.video-card')].map((card) => card.dataset.id);
    expect(renderedIds).toHaveLength(45);
    expect(new Set(renderedIds).size).toBe(45);
    expect(window.document.getElementById('videos-load-sentinel').classList.contains('is-idle')).toBe(true);
  });

  test('a search typed during the initial load wins over the stale initial response', async () => {
    const videos = makeVideos(30);
    const initial = deferred();
    const signals = [];
    const listHandler = jest.fn((url, init) => {
      signals.push(init && init.signal);
      if (!url.includes('search=')) return initial.promise;
      return jsonResponse(listResponse(videos, url));
    });
    const dom = bootApp('/', videos, { listHandler });
    const window = await startApp(dom);

    const searchInput = window.document.getElementById('search-input');
    searchInput.value = 'number 7';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(400);

    expect(listHandler).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);

    // The superseded initial response arrives last and must be ignored
    initial.resolve({ ok: true, json: async () => listResponse(videos, '/api/videos?page=1&limit=20') });
    await wait(100);

    const titles = [...window.document.querySelectorAll('.video-title')].map((node) => node.textContent);
    expect(titles).toEqual(['Mythic run number 7']);
    expect(window.document.querySelector('.loading:not([hidden])')).toBeNull();
  });

  test('a sort change during an in-flight load is not dropped', async () => {
    const videos = makeVideos(5);
    const first = deferred();
    const listHandler = jest.fn((url) => (url.includes('sort=title_asc')
      ? jsonResponse({ ...listResponse(videos, url), videos: [...videos].reverse() })
      : first.promise));
    const dom = bootApp('/', videos, { listHandler });
    const window = await startApp(dom);

    const sortSelect = window.document.getElementById('sort-select');
    sortSelect.value = 'title_asc';
    sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(100);
    first.resolve({ ok: true, json: async () => listResponse(videos, '/api/videos?page=1') });
    await wait(100);

    const ids = [...window.document.querySelectorAll('.video-card')].map((card) => card.dataset.id);
    expect(ids).toEqual(['1', '2', '3', '4', '5']);
  });

  test('empty and error states are messages, not spinners', async () => {
    const dom = bootApp('/', [], {});
    const window = await startApp(dom);
    const grid = window.document.getElementById('videos-grid');
    expect(grid.querySelector('.loading')).toBeNull();
    expect(grid.querySelector('.empty-state').textContent).toBe('No videos found. Add videos to your library folder.');

    const failing = bootApp('/', [], { listHandler: () => jsonResponse({ error: 'boom' }, 500) });
    const failingWindow = await startApp(failing);
    const failingGrid = failingWindow.document.getElementById('videos-grid');
    expect(failingGrid.querySelector('.loading')).toBeNull();
    expect(failingGrid.querySelector('.empty-state.is-error').textContent).toBe('Error loading videos. Please try again.');
  });

  test('a disabled advanced search falls back to regular results and hides the toggle', async () => {
    const videos = makeVideos(12);
    const dom = bootApp('/', videos);
    const window = await startApp(dom);

    const toggle = window.document.getElementById('advanced-search-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(window.document.getElementById('search-button').hidden).toBe(false);

    const searchInput = window.document.getElementById('search-input');
    searchInput.value = 'number 1';
    searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(150);

    expect(fetchedUrls(window)).toContain('/api/videos/advanced-search');
    expect(fetchedUrls(window)).toContain('/api/videos?page=1&limit=20&sort=date_added_desc&search=number+1');
    expect(window.document.querySelector('.empty-state.is-error')).toBeNull();
    expect(window.document.querySelectorAll('.video-card').length).toBe(4); // 1, 10, 11, 12
    expect(window.document.querySelector('.advanced-search-label').hidden).toBe(true);
    expect(toggle.checked).toBe(false);
  });

  test('the Advanced toggle is hidden when /api/config reports it disabled', async () => {
    const enabled = await startApp(bootApp('/', [sampleVideo]));
    expect(enabled.document.querySelector('.advanced-search-label').hidden).toBe(false);

    const dom = bootApp('/', [sampleVideo], { configResponse: jsonResponse({ vodsName: 'Test', advancedSearch: false }) });
    const window = await startApp(dom);
    expect(window.document.querySelector('.advanced-search-label').hidden).toBe(true);
  });

  test('hover previews stop on re-render and still work on the new cards', async () => {
    const videos = makeVideos(3).map((video) => ({ ...video, preview: { hasPreview: true, firstTimestamp: 0 } }));
    const dom = bootApp('/', videos);
    const window = await startApp(dom);
    const hover = (id) => window.document.querySelector(`.video-card[data-id="${id}"] .thumbnail`)
      .dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));

    hover(2);
    await wait(350);
    const firstPreview = window.document.querySelector('.video-card[data-id="2"] video');
    expect(firstPreview.getAttribute('src')).toBe('/api/videos/2/preview/0');

    const sortSelect = window.document.getElementById('sort-select');
    sortSelect.value = 'title_asc';
    sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(50);
    expect(firstPreview.isConnected).toBe(false);
    expect(firstPreview.hasAttribute('src')).toBe(false);

    hover(3);
    await wait(350);
    expect(window.document.querySelector('.video-card[data-id="3"] video').getAttribute('src')).toBe('/api/videos/3/preview/0');
  });

  test('the card entry animation only plays on the first render', async () => {
    const dom = bootApp('/', makeVideos(3));
    const window = await startApp(dom);
    expect(window.document.querySelectorAll('.video-card.card-enter')).toHaveLength(3);

    const sortSelect = window.document.getElementById('sort-select');
    sortSelect.value = 'title_asc';
    sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(50);
    expect(window.document.querySelectorAll('.video-card')).toHaveLength(3);
    expect(window.document.querySelectorAll('.video-card.card-enter')).toHaveLength(0);
  });

  test('toggling favorites during a load keeps the spinner instead of an empty state', async () => {
    const videos = makeVideos(3);
    const pending = deferred();
    const listHandler = jest.fn((url) => (url.includes('sort=title_asc') ? pending.promise : jsonResponse(listResponse(videos, url))));
    const dom = bootApp('/', videos, { listHandler });
    const window = await startApp(dom);
    window.VideoUtils.toggleFavorite(2);

    const sortSelect = window.document.getElementById('sort-select');
    sortSelect.value = 'title_asc';
    sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    const favoritesToggle = window.document.getElementById('favorites-toggle');
    favoritesToggle.checked = true;
    favoritesToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    const grid = window.document.getElementById('videos-grid');
    expect(grid.querySelector('.empty-state')).toBeNull();
    expect(grid.querySelector('.loading')).toBeTruthy();

    pending.resolve({ ok: true, json: async () => listResponse(videos, '/api/videos?page=1') });
    await wait(50);
    expect([...grid.querySelectorAll('.video-card')].map((card) => card.dataset.id)).toEqual(['2']);
  });
});

describe('Advanced search', () => {
  const enableAdvanced = (window) => {
    const toggle = window.document.getElementById('advanced-search-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const advancedCalls = (window) => window.fetch.mock.calls.filter((call) => String(call[0]).includes('advanced-search'));

  test('only a submitted query runs, once, as a single page; typing and scrolling do not', async () => {
    const videos = makeVideos(45);
    const advancedHandler = jest.fn(() => jsonResponse({ videos: videos.slice(0, 30), totalCount: 130, page: 1, limit: 100 }));
    const dom = bootApp('/', videos, { advancedHandler, intersectionObserver: 'tall' });
    const window = await startApp(dom);
    await wait(300);
    enableAdvanced(window);

    const searchInput = window.document.getElementById('search-input');
    searchInput.value = 'deaths on Evandis';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(400);
    expect(advancedCalls(window)).toHaveLength(0);

    searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(300);
    expect(advancedCalls(window)).toHaveLength(1);
    expect(JSON.parse(advancedCalls(window)[0][1].body)).toEqual({ query: 'deaths on Evandis', page: 1, limit: 100 });
    expect(window.document.querySelectorAll('.video-card')).toHaveLength(30);
    expect(window.document.getElementById('sort-select').disabled).toBe(true);

    // Unsubmitted edits and more "scrolling" do not call the LLM again
    searchInput.value = 'something else';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.scrollSentinelIntoView();
    await wait(400);
    expect(advancedCalls(window)).toHaveLength(1);

    // Switching Advanced off replaces the results with a regular search of the input
    const toggle = window.document.getElementById('advanced-search-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(100);
    expect(fetchedUrls(window)).toContain('/api/videos?page=1&limit=20&sort=date_added_desc&search=something+else');
    expect(window.document.getElementById('sort-select').disabled).toBe(false);
    expect(advancedCalls(window)).toHaveLength(1);
  });
});

describe('Live updates', () => {
  const sseMessage = (window, data) => {
    window.EventSource.instances[0].onmessage({ data: JSON.stringify(data) });
  };

  test('an added video is prepended once in the default view', async () => {
    const videos = makeVideos(3);
    const dom = bootApp('/', videos);
    const window = await startApp(dom);

    const added = { ...makeVideos(1)[0], id: 100, title: 'Fresh pull' };
    sseMessage(window, { type: 'add', video: added });
    sseMessage(window, { type: 'add', video: added });
    const ids = [...window.document.querySelectorAll('.video-card')].map((card) => card.dataset.id);
    expect(ids).toEqual(['100', '3', '2', '1']);
  });

  test('an added video is not prepended into a search or non-default sort', async () => {
    const videos = makeVideos(3);
    const dom = bootApp('/', videos);
    const window = await startApp(dom);

    const sortSelect = window.document.getElementById('sort-select');
    sortSelect.value = 'title_asc';
    sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(50);

    sseMessage(window, { type: 'add', video: { ...makeVideos(1)[0], id: 100, title: 'Fresh pull' } });
    const ids = [...window.document.querySelectorAll('.video-card')].map((card) => card.dataset.id);
    expect(ids).not.toContain('100');
    expect(window.document.querySelector('.toast').textContent).toContain('Fresh pull');
  });

  test('a video added while a fresh list is loading is kept', async () => {
    const videos = makeVideos(3);
    const added = { ...makeVideos(1)[0], id: 100, title: 'Fresh pull' };
    const pending = [];
    const listHandler = jest.fn((url) => {
      if (listHandler.mock.calls.length === 1) return jsonResponse(listResponse(videos, url));
      const next = deferred();
      pending.push(next);
      return next.promise;
    });
    const dom = bootApp('/', videos, { listHandler });
    const window = await startApp(dom);
    const ids = () => [...window.document.querySelectorAll('.video-card')].map((card) => card.dataset.id);
    const reload = () => {
      const sortSelect = window.document.getElementById('sort-select');
      sortSelect.value = 'date_added_desc';
      sortSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    // The response was computed before the add: the video is applied after the list lands
    reload();
    await wait(10);
    sseMessage(window, { type: 'add', video: added });
    pending[0].resolve({ ok: true, json: async () => listResponse(videos, '/api/videos?page=1') });
    await wait(50);
    expect(ids()).toEqual(['100', '3', '2', '1']);

    // The response already contains it: shown once
    reload();
    await wait(10);
    sseMessage(window, { type: 'add', video: added });
    pending[1].resolve({ ok: true, json: async () => listResponse([added, ...videos], '/api/videos?page=1') });
    await wait(50);
    expect(ids()).toEqual(['100', '3', '2', '1']);
  });

  test('a deleted video does not make the next page skip one', async () => {
    const videos = makeVideos(45);
    const dom = bootApp('/', videos, { intersectionObserver: 'manual' });
    const window = await startApp(dom);
    expect(window.document.querySelectorAll('.video-card')).toHaveLength(20);

    // Server side the video is gone, which shifts every later offset by one
    videos.splice(videos.findIndex((video) => video.id === 40), 1);
    sseMessage(window, { type: 'delete', videoId: 40 });
    for (let i = 0; i < 4; i += 1) {
      window.scrollSentinelIntoView();
      await wait(50);
    }

    const renderedIds = [...window.document.querySelectorAll('.video-card:not(.fade-out)')].map((card) => Number(card.dataset.id));
    expect(renderedIds).toEqual(videos.map((video) => video.id));
  });
});

describe('Video overlay races', () => {
  test('closing before metadata arrives never starts the stream or retitles the page', async () => {
    const detail = deferred();
    const detailSignals = [];
    const dom = bootApp('/', [sampleVideo], {
      detailHandler: (id, init) => {
        detailSignals.push(init && init.signal);
        return detail.promise;
      }
    });
    const window = await startApp(dom);
    const titleBefore = window.document.title;

    // Back/forward to a video that is not in the loaded list needs a metadata request
    window.history.pushState({}, '', '/watch/999');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await wait(10);
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(true);

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(detailSignals[0].aborted).toBe(true);

    detail.resolve({ ok: true, json: async () => ({ ...sampleVideo, id: 999, title: 'Late arrival' }) });
    await wait(300);

    const overlayVideo = window.document.getElementById('overlay-video-player');
    expect(overlayVideo.hasAttribute('src')).toBe(false);
    expect(window.Plyr.instances).toHaveLength(0);
    expect(window.document.title).toBe(titleBefore);
    expect(window.document.getElementById('overlay-video-title').textContent).toBe('');
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(false);
  });

  test('opening B while A is loading shows only B', async () => {
    const detail = deferred();
    const secondVideo = { ...sampleVideo, id: 43, title: 'Second' };
    const dom = bootApp('/', [sampleVideo, secondVideo], {
      detailHandler: (id) => (id === '999' ? detail.promise : jsonResponse(secondVideo))
    });
    const window = await startApp(dom);

    window.history.pushState({}, '', '/watch/999');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await wait(10);
    window.document.querySelector('.video-card[data-id="43"] .video-card-link')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await wait(10);
    detail.resolve({ ok: true, json: async () => ({ ...sampleVideo, id: 999, title: 'Late arrival' }) });
    await wait(50);

    expect(window.document.getElementById('overlay-video-title').textContent).toBe('Second');
    expect(window.document.getElementById('overlay-video-player').getAttribute('src')).toBe('/api/videos/43/stream');
    expect(window.Plyr.instances).toHaveLength(1);
  });

  test('death timestamps become Plyr markers', async () => {
    const dom = bootApp('/', [{ ...sampleVideo, death_timestamps: '[79.998, 80.2, 3725]' }]);
    const window = await startApp(dom);
    window.document.querySelector('.video-card-link')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await wait(20);

    expect(window.Plyr.instances[0].config.markers).toEqual({
      enabled: true,
      points: [
        { time: 80, label: 'Death at 01:20' },
        { time: 3725, label: 'Death at 1:02:05' }
      ]
    });
  });

  test('the overlay focuses the dialog, so Space reaches the player instead of the close button', async () => {
    const dom = bootApp('/', [sampleVideo]);
    const window = await startApp(dom);
    const card = window.document.querySelector('.video-card-link');
    card.focus();
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await wait(20);

    const container = window.document.querySelector('.video-overlay-container');
    expect(window.document.activeElement).toBe(container);
    expect(window.Plyr.instances[0].config.keyboard.global).toBe(true);
    window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(window.document.getElementById('video-overlay').getAttribute('aria-hidden')).toBe('false');

    // The Favorite button keeps its name; aria-pressed carries the state
    const favorite = window.document.getElementById('overlay-favorite-btn');
    favorite.click();
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    expect(favorite.textContent.trim()).toBe('Favorite');

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(20);
    expect(window.document.getElementById('video-overlay').getAttribute('aria-hidden')).toBe('true');
    expect(window.document.activeElement).toBe(card);
  });

  test('with open/close motion, a second close or a re-open during the fade leaves a consistent overlay', async () => {
    const dom = bootApp('/', [sampleVideo, { ...sampleVideo, id: 43, title: 'Second' }]);
    const window = await startApp(dom);
    // Web Animations stand-in: finishes after 40 ms, rejects when cancelled
    window.Element.prototype.animate = function animate() {
      let reject;
      let timer;
      const finished = new Promise((resolve, rej) => {
        reject = rej;
        timer = setTimeout(resolve, 40);
      });
      finished.catch(() => {});
      return { finished, cancel: () => { clearTimeout(timer); reject(new Error('AbortError')); } };
    };
    const overlay = window.document.getElementById('video-overlay');
    const open = (id) => window.document.querySelector(`.video-card[data-id="${id}"] .video-card-link`)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    open(42);
    await wait(10);
    window.document.querySelector('.video-overlay-close').click();
    window.document.querySelector('.video-overlay-backdrop').click(); // a stray second close
    await wait(100);
    expect(overlay.classList.contains('visible')).toBe(false);

    open(42);
    await wait(10);
    window.document.querySelector('.video-overlay-close').click();
    open(43); // re-open while the close motion runs
    await wait(100);
    expect(overlay.classList.contains('visible')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(window.document.getElementById('overlay-video-title').textContent).toBe('Second');
    expect(window.location.pathname).toBe('/watch/43');

    window.document.querySelector('.video-overlay-close').click();
    await wait(100);
    expect(window.location.pathname).toBe('/');
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  test('favoriting from the grid is a pressed-state button', async () => {
    const dom = bootApp('/', [sampleVideo]);
    const window = await startApp(dom);
    const button = window.document.querySelector('.favorite-indicator-grid');

    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(window.VideoUtils.isFavorite('42')).toBe(true);
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(window.VideoUtils.isFavorite('42')).toBe(false);
  });
});
