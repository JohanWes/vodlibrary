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
    expect(source.includes('transitionend')).toBe(true);
    expect(source.includes('watchOverlayContainerTransition')).toBe(true);
  });

  test('stylesheet includes overlay opening and closing motion states', () => {
    const css = loadStyleSheet();

    expect(css.includes('.video-overlay.is-opening.has-origin .video-overlay-container')).toBe(true);
    expect(css.includes('.video-overlay.is-closing')).toBe(true);
    expect(css.includes('.video-overlay.is-closing .video-overlay-container')).toBe(true);
    expect(css.includes('visibility: hidden')).toBe(true);
    expect(css.includes('pointer-events: none')).toBe(true);
    expect(css.includes('body.overlay-open header')).toBe(true);
    expect(css.includes('body.overlay-open main')).toBe(true);
    expect(css.includes('body.overlay-open footer')).toBe(true);
    expect(css.includes('.video-overlay.visible ~ header')).toBe(false);
    expect(css.includes('.video-overlay.visible ~ main')).toBe(false);
    expect(css.includes('.video-overlay.visible ~ footer')).toBe(false);
  });
});
