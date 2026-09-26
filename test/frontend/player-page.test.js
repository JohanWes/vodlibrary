/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..', '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function bootPage(page, url, fetchImpl, { plyr = true } = {}) {
  const html = fs.readFileSync(path.join(root, 'public', page), 'utf8');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  window.HTMLMediaElement.prototype.load = jest.fn();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
  window.Plyr = !plyr ? undefined : class MockPlyr {
    constructor(element, config) {
      this.element = element;
      this.config = config;
      this.currentTime = 0;
      MockPlyr.instances.push(this);
    }
    on() {}
  };
  if (window.Plyr) window.Plyr.instances = [];
  window.fetch = jest.fn(fetchImpl);
  const scripts = [...dom.window.document.querySelectorAll('script[src]')].map((script) => script.getAttribute('src'));
  scripts.forEach((src) => window.eval(fs.readFileSync(path.join(root, 'public', src), 'utf8')));
  return window;
}

describe('Standalone player page', () => {
  test('requests config and video metadata in parallel, then starts the stream', async () => {
    const config = deferred();
    const video = deferred();
    const window = bootPage('player.html', 'http://localhost/watch/42?t=90', (url) => {
      if (String(url).endsWith('/api/config')) return config.promise;
      if (String(url).endsWith('/api/videos/42')) return video.promise;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    await wait(0);
    const urls = window.fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(expect.arrayContaining(['/api/config', '/api/videos/42']));
    const videoElement = window.document.getElementById('video-player');
    expect(videoElement.hasAttribute('src')).toBe(false);

    video.resolve({
      ok: true,
      json: async () => ({
        id: 42,
        title: 'Long pull',
        duration: 4530,
        duration_formatted: '75:30',
        added_date: '2026-08-01T12:00:00.000Z',
        death_timestamps: '[30]'
      })
    });
    await wait(10);

    // Metadata alone is enough to start playback; the site name arrives later
    expect(window.document.getElementById('video-title').textContent).toBe('Long pull');
    expect(window.document.getElementById('video-duration').textContent).toBe('1:15:30');
    expect(videoElement.getAttribute('src')).toBe('/api/videos/42/stream');
    expect(window.Plyr.instances).toHaveLength(1);
    expect(window.Plyr.instances[0].config.markers.points).toEqual([{ time: 30, label: 'Death at 00:30' }]);

    // ?t=90 seeks once the duration is known
    videoElement.dispatchEvent(new window.Event('loadedmetadata'));
    expect(videoElement.currentTime).toBe(90);

    config.resolve({ ok: true, json: async () => ({ vodsName: 'Test' }) });
    await wait(10);
    expect(window.document.title).toBe('Test - Long pull');
    expect(window.document.getElementById('app-title').textContent).toBe('Test');
  });
});

describe('Plyr loading', () => {
  const videoResponse = () => Promise.resolve({
    ok: true,
    json: async () => ({ id: 42, title: 'Pull', duration: 60, added_date: '2026-08-01T12:00:00.000Z', death_timestamps: null })
  });

  test('a failed Plyr download falls back to native controls and is not retried on every open', async () => {
    const window = bootPage('player.html', 'http://localhost/watch/42', (url) => (
      String(url).endsWith('/api/videos/42') ? videoResponse() : new Promise(() => {})
    ), { plyr: false });
    const plyrScripts = () => window.document.querySelectorAll('script[src$="vendor/plyr/plyr.js"]');
    await wait(0);
    expect(plyrScripts()).toHaveLength(1);

    plyrScripts()[0].dispatchEvent(new window.Event('error'));
    await wait(10);
    expect(plyrScripts()).toHaveLength(0);
    expect(window.document.getElementById('video-player').getAttribute('src')).toBe('/api/videos/42/stream');

    await expect(window.PlayerCore.loadPlyr()).rejects.toThrow(/plyr/i);
    expect(plyrScripts()).toHaveLength(0);
  });

  test('the lazily added plyr.css goes before the app stylesheet', async () => {
    const window = bootPage('index.html', 'http://localhost/', () => new Promise(() => {}), { plyr: false });
    window.PlayerCore.loadPlyr().catch(() => {});
    const stylesheets = [...window.document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute('href'));
    expect(stylesheets).toEqual(['/vendor/plyr/plyr.css', 'css/style.css']);
  });
});

describe('Login page', () => {
  test('shows the error banner only after a failed attempt', () => {
    const okWindow = bootPage('login.html', 'http://localhost/login.html', () => new Promise(() => {}));
    expect(okWindow.document.getElementById('errorMessage').hidden).toBe(true);

    const errorWindow = bootPage('login.html', 'http://localhost/login.html?error=1', () => new Promise(() => {}));
    expect(errorWindow.document.getElementById('errorMessage').hidden).toBe(false);
  });
});
