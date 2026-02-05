/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

function loadMainScript() {
  const filePath = path.resolve(__dirname, '..', '..', 'public/js/main.js');
  return fs.readFileSync(filePath, 'utf8');
}

function loadStyleSheet() {
  const filePath = path.resolve(__dirname, '..', '..', 'public/css/style.css');
  return fs.readFileSync(filePath, 'utf8');
}

describe('Overlay motion contract', () => {
  test('main script applies origin-based opening/closing state classes', () => {
    const source = loadMainScript();

    expect(source.includes('setOverlayOriginFromEvent')).toBe(true);
    expect(source.includes("overlay.classList.add('is-opening');")).toBe(true);
    expect(source.includes("overlay.classList.add('is-closing');")).toBe(true);
    expect(source.includes("overlay.classList.add('has-origin');")).toBe(true);
  });

  test('stylesheet includes overlay opening and closing motion states', () => {
    const css = loadStyleSheet();

    expect(css.includes('.video-overlay.is-opening.has-origin .video-overlay-container')).toBe(true);
    expect(css.includes('.video-overlay.is-closing')).toBe(true);
    expect(css.includes('.video-overlay.is-closing .video-overlay-container')).toBe(true);
  });
});
