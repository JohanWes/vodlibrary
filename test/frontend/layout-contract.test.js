/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadDom(relativePath) {
  const filePath = path.resolve(__dirname, '..', '..', relativePath);
  const html = fs.readFileSync(filePath, 'utf8');
  return new JSDOM(html).window.document;
}

describe('Frontend layout contract', () => {
  test('index page has a single favicon declaration', () => {
    const document = loadDom('public/index.html');
    const favicons = document.querySelectorAll('link[rel="icon"]');

    expect(favicons).toHaveLength(1);
  });

  test('index page contains required root UI hooks', () => {
    const document = loadDom('public/index.html');

    expect(document.getElementById('search-input')).toBeTruthy();
    expect(document.getElementById('videos-grid')).toBeTruthy();
    expect(document.getElementById('videos-load-sentinel')).toBeTruthy();
    expect(document.getElementById('video-overlay')).toBeTruthy();
    expect(document.getElementById('overlay-video-player')).toBeTruthy();
    expect(document.getElementById('scan-status')).toBeTruthy();
  });

  test('index scan status uses aria-live polite announcements', () => {
    const document = loadDom('public/index.html');
    const scanStatus = document.getElementById('scan-status');

    expect(scanStatus.getAttribute('aria-live')).toBe('polite');
  });

  test('fonts are self-hosted: every @font-face source and font preload exists locally', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public/css/style.css'), 'utf8');
    const fontSources = [...css.matchAll(/url\((?:'|")?\.\.\/(fonts\/[^'")]+)/g)].map((match) => match[1]);
    expect(fontSources.length).toBeGreaterThanOrEqual(2);
    ['public/index.html', 'public/player.html', 'public/login.html'].forEach((page) => {
      const preloads = Array.from(loadDom(page).querySelectorAll('link[rel="preload"][as="font"]'))
        .map((link) => link.getAttribute('href'));
      expect(preloads.length).toBeGreaterThan(0);
      fontSources.concat(preloads).forEach((file) => {
        expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'public', file))).toBe(true);
      });
    });
  });

  test('player page loads plyr.css before the app stylesheet (so app overrides win)', () => {
    const stylesheets = Array.from(loadDom('public/player.html').querySelectorAll('link[rel="stylesheet"]'))
      .map((link) => link.getAttribute('href'));
    expect(stylesheets.indexOf('vendor/plyr/plyr.css')).toBeGreaterThanOrEqual(0);
    expect(stylesheets.indexOf('vendor/plyr/plyr.css')).toBeLessThan(stylesheets.indexOf('css/style.css'));
  });

  test.each(['public/index.html', 'public/player.html', 'public/login.html'])(
    '%s is ready for a strict CSP (no inline scripts, handlers, styles or third-party resources)',
    (page) => {
      const document = loadDom(page);
      const scripts = Array.from(document.querySelectorAll('script'));

      expect(scripts.filter((script) => !script.getAttribute('src'))).toHaveLength(0);
      scripts.forEach((script) => {
        expect(script.hasAttribute('defer')).toBe(true);
        expect(script.getAttribute('src')).toMatch(/^js\//);
      });
      expect(document.querySelectorAll('style, [style]')).toHaveLength(0);
      const handlerAttributes = Array.from(document.querySelectorAll('*'))
        .flatMap((element) => element.getAttributeNames().filter((name) => name.startsWith('on')));
      expect(handlerAttributes).toEqual([]);
      const references = Array.from(document.querySelectorAll('link[href], script[src], img[src]'))
        .map((element) => element.getAttribute('href') || element.getAttribute('src'));
      expect(references.filter((ref) => /^(https?:)?\/\//i.test(ref))).toEqual([]);
    }
  );

  test('Plyr is vendored locally with its license', () => {
    const vendorDir = path.resolve(__dirname, '..', '..', 'public/vendor/plyr');
    ['plyr.js', 'plyr.css', 'plyr.svg', 'blank.mp4', 'LICENSE.md'].forEach((file) => {
      expect(fs.existsSync(path.join(vendorDir, file))).toBe(true);
    });
  });

  test('no frontend source references a third-party origin', () => {
    const sources = ['public/js/main.js', 'public/js/player.js', 'public/js/utils.js', 'public/js/video-preview.js', 'public/js/login.js', 'public/css/style.css'];
    sources.forEach((file) => {
      const text = fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');
      expect(text).not.toMatch(/cdn\.plyr\.io|fonts\.googleapis|fonts\.gstatic/);
    });
  });

  test('index page does not block on Plyr', () => {
    const document = loadDom('public/index.html');
    const references = Array.from(document.querySelectorAll('script[src], link[href]'))
      .map((element) => element.getAttribute('src') || element.getAttribute('href'));

    expect(references.some((ref) => ref.includes('plyr'))).toBe(false);
  });
});
