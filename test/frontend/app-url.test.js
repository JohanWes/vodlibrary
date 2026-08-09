/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const UTILS_PATH = path.resolve(__dirname, '..', '..', 'public/js/utils.js');

/**
 * Load utils.js into the jsdom global scope with the given base href.
 * @param {string|null} baseHref - Base href to install, or null for no base element
 * @returns {Object} - window.VideoUtils
 */
function loadUtilsWithBase(baseHref) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  if (baseHref !== null) {
    const base = document.createElement('base');
    base.href = baseHref;
    document.head.appendChild(base);
  }
  const source = fs.readFileSync(UTILS_PATH, 'utf8');
  // Indirect eval runs utils.js in the jsdom global scope so window.VideoUtils is defined
  (0, eval)(source);
  return window.VideoUtils;
}

describe('VideoUtils.appUrl', () => {
  test('base "/" keeps root-relative URLs unchanged', () => {
    const utils = loadUtilsWithBase('/');

    expect(utils.appUrl('/api/videos')).toBe('/api/videos');
    expect(utils.appUrl('api/videos')).toBe('/api/videos');
    expect(utils.appUrl('/watch/5')).toBe('/watch/5');
    expect(utils.appUrl('/thumbnails/abc.jpg')).toBe('/thumbnails/abc.jpg');
    expect(utils.appUrl('/')).toBe('/');
  });

  test('base "/" preserves query and hash', () => {
    const utils = loadUtilsWithBase('/');

    expect(utils.appUrl('/api/videos?page=2&limit=20&sort=title_asc')).toBe('/api/videos?page=2&limit=20&sort=title_asc');
    expect(utils.appUrl('/watch/5?t=90')).toBe('/watch/5?t=90');
    expect(utils.appUrl('/api/videos/5#details')).toBe('/api/videos/5#details');
    expect(utils.appUrl('/watch/5?t=90#frag')).toBe('/watch/5?t=90#frag');
  });

  test('base "/vod/" prefixes every application URL exactly once', () => {
    const utils = loadUtilsWithBase('/vod/');

    expect(utils.appUrl('/api/videos')).toBe('/vod/api/videos');
    expect(utils.appUrl('api/videos')).toBe('/vod/api/videos');
    expect(utils.appUrl('/watch/5')).toBe('/vod/watch/5');
    expect(utils.appUrl('/thumbnails/abc.jpg')).toBe('/vod/thumbnails/abc.jpg');
    expect(utils.appUrl('/api/videos?page=2&limit=20')).toBe('/vod/api/videos?page=2&limit=20');
    expect(utils.appUrl('/watch/5?t=90')).toBe('/vod/watch/5?t=90');
    expect(utils.appUrl('/api/videos/5#details')).toBe('/vod/api/videos/5#details');
  });

  test('base "/vod/" home resolves to the base itself', () => {
    const utils = loadUtilsWithBase('/vod/');

    expect(utils.appUrl('/')).toBe('/vod/');
  });

  test('no base element falls back to root-relative behavior', () => {
    const utils = loadUtilsWithBase(null);

    expect(utils.appUrl('/api/videos?page=1')).toBe('/api/videos?page=1');
    expect(utils.appUrl('/watch/5')).toBe('/watch/5');
  });
});
