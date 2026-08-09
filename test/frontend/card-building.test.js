/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.resolve(__dirname, '..', '..', 'public/index.html');
const SCRIPT_PATHS = ['public/js/utils.js', 'public/js/video-preview.js', 'public/js/main.js'];

/**
 * Boot the index page in jsdom with the given base href and video payload.
 * @param {Promise<Object>} configResponse - Mocked config fetch response
 * @param {string} urlPath - Initial browser path
 * @returns {JSDOM} - The booted DOM
 */
function bootApp(
  baseHref,
  videos,
  configResponse = Promise.resolve({ ok: true, json: async () => ({ vodsName: 'Test' }) }),
  urlPath = '/',
  scanStatusResponses = []
) {
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
  window.EventSource = class MockEventSource {
    constructor(url) {
      this.url = url;
      MockEventSource.instances.push(url);
    }
    close() {}
    addEventListener() {}
  };
  window.EventSource.instances = [];
  window.Plyr = class MockPlyr {
    constructor() {
      this.currentTime = 0;
    }
    on() {}
    pause() {}
    destroy() {}
  };

  const videosById = new Map(videos.map((video) => [String(video.id), video]));
  window.fetch = jest.fn((url) => {
    const urlString = String(url);
    if (urlString.includes('/api/config')) {
      return configResponse;
    }
    if (urlString.includes('/api/scan/status')) {
      const response = scanStatusResponses.length > 0
        ? scanStatusResponses.shift()
        : Promise.resolve({ ok: true, json: async () => ({ status: 'idle' }) });
      return response;
    }
    if (urlString.includes('/api/refresh')) {
      return Promise.resolve({ ok: true, status: 202, json: async () => ({}) });
    }
    if (urlString.includes('/api/videos?')) {
      return Promise.resolve({ ok: true, json: async () => ({ videos, totalCount: videos.length, limit: 20, page: 1 }) });
    }
    const detailMatch = urlString.match(/\/api\/videos\/(\d+)$/);
    if (detailMatch) {
      const video = videosById.get(detailMatch[1]);
      return video
        ? Promise.resolve({ ok: true, json: async () => video })
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });

  for (const script of SCRIPT_PATHS) {
    window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', script), 'utf8'));
  }
  return dom;
}

/**
 * Let jsdom's natural DOMContentLoaded fire, then allow async init to settle.
 * @param {JSDOM} dom - The booted DOM
 * @returns {Promise<Window>} - The page window
 */
async function startApp(dom) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return dom.window;
}

const sampleVideo = {
  id: 42,
  title: 'Evandis Pull +1',
  duration: 65,
  duration_formatted: '01:05',
  thumbnail_path: '/thumbnails/evandis.jpg',
  added_date: '2026-08-01T12:00:00.000Z',
  death_timestamps: null
};

describe('Video card building with base href', () => {
  test('base "/" keeps all local URLs root-relative', async () => {
    const dom = bootApp('/', [sampleVideo]);
    const window = await startApp(dom);

    const fetched = window.fetch.mock.calls.map((call) => String(call[0]));
    expect(fetched).toContain('/api/config');
    expect(fetched).toContain('/api/videos?page=1&limit=20&sort=date_added_desc');
    expect(fetched).toContain('/api/scan/status');
    expect(window.EventSource.instances).toEqual(['/api/updates']);
    expect(window.setInterval).not.toHaveBeenCalled();

    const card = window.document.querySelector('.video-card');
    expect(card).toBeTruthy();
    expect(card.querySelector('.video-card-link').getAttribute('href')).toBe('/watch/42');
    expect(card.querySelector('.thumbnail').getAttribute('src')).toBe('/thumbnails/evandis.jpg');
    expect(card.querySelector('.duration-badge').textContent).toBe('01:05');
    expect(card.querySelector('.video-title').textContent).toBe('Evandis Pull +1');
    expect(card.querySelector('.outcome-indicator').className).toBe('outcome-indicator success');
    expect(card.querySelector('.favorite-indicator-grid').getAttribute('data-video-id')).toBe('42');

    // Opening the overlay from a card click uses base-relative media and history URLs
    const overlayVideo = window.document.getElementById('overlay-video-player');
    card.querySelector('.video-card-link').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe('/watch/42');
    expect(overlayVideo.getAttribute('src')).toBe('/api/videos/42/stream');
    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain('/api/videos/42');
    // Simulate the media becoming ready so the loading fallback timer is cleared
    overlayVideo.dispatchEvent(new window.Event('canplay'));

    // Closing restores the root home URL
    window.closeVideoOverlay();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(window.location.pathname).toBe('/');
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
    const dom = bootApp('/vod/', [sampleVideo, secondVideo]);
    const window = await startApp(dom);

    const fetched = window.fetch.mock.calls.map((call) => String(call[0]));
    expect(fetched).toContain('/vod/api/config');
    expect(fetched).toContain('/vod/api/videos?page=1&limit=20&sort=date_added_desc');
    expect(fetched).toContain('/vod/api/scan/status');
    expect(window.EventSource.instances).toEqual(['/vod/api/updates']);

    const card = window.document.querySelector('.video-card');
    expect(card.querySelector('.video-card-link').getAttribute('href')).toBe('/vod/watch/42');
    expect(card.querySelector('.thumbnail').getAttribute('src')).toBe('/vod/thumbnails/evandis.jpg');

    // Card click opens the overlay with base-relative media and history URLs
    const overlayVideo = window.document.getElementById('overlay-video-player');
    card.querySelector('.video-card-link').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe('/vod/watch/42');
    expect(overlayVideo.getAttribute('src')).toBe('/vod/api/videos/42/stream');
    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain('/vod/api/videos/42');
    overlayVideo.dispatchEvent(new window.Event('canplay'));

    // Closing restores the base home URL
    window.closeVideoOverlay();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(window.location.pathname).toBe('/vod/');

    // Popstate with a base-prefixed watch path reopens the right video
    window.history.pushState({}, '', '/vod/watch/77');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain('/vod/api/videos/77');
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(true);
    expect(overlayVideo.getAttribute('src')).toBe('/vod/api/videos/77/stream');
    overlayVideo.dispatchEvent(new window.Event('canplay'));
  });

  test('renders videos without waiting for a slow config response', async () => {
    const neverResolvingConfig = new Promise(() => {});
    const dom = bootApp('/', [sampleVideo], neverResolvingConfig);
    const window = await startApp(dom);

    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain(
      '/api/videos?page=1&limit=20&sort=date_added_desc'
    );
    expect(window.document.querySelector('.video-card')).toBeTruthy();
  });

  test('opens a direct watch URL without an artificial timer', async () => {
    const dom = bootApp('/', [sampleVideo], undefined, '/watch/42');
    const window = await startApp(dom);

    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain('/api/videos/42');
    expect(window.document.getElementById('video-overlay').classList.contains('visible')).toBe(true);
    window.document.getElementById('overlay-video-player').dispatchEvent(new window.Event('canplay'));
  });
  test('stops polling when a pre-existing scan reaches a terminal state', async () => {
    const scanResponses = [
      Promise.resolve({ ok: true, json: async () => ({ status: 'running' }) }),
      Promise.resolve({ ok: true, json: async () => ({ status: 'completed' }) })
    ];
    const dom = bootApp('/', [sampleVideo], undefined, '/', scanResponses);
    const window = await startApp(dom);

    expect(window.setInterval).toHaveBeenCalledTimes(1);
    await window.setInterval.mock.calls[0][0]();
    expect(window.clearInterval).toHaveBeenCalledWith(1);
  });

  test('a newer refresh check is the only poll allowed to install an interval', async () => {
    let resolveInitialScan;
    const initialScan = new Promise((resolve) => {
      resolveInitialScan = resolve;
    });
    const scanResponses = [
      initialScan,
      Promise.resolve({ ok: true, json: async () => ({ status: 'running' }) })
    ];
    const dom = bootApp('/', [sampleVideo], undefined, '/', scanResponses);
    const window = await startApp(dom);

    window.document.getElementById('refresh-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveInitialScan({ ok: true, json: async () => ({ status: 'running' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.setInterval).toHaveBeenCalledTimes(1);
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

    // No handler-bearing nodes anywhere in the grid
    const grid = window.document.getElementById('videos-grid');
    expect(grid.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length).toBe(0);
  });
});
