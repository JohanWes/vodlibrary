/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

function loadStyleSheet() {
  const filePath = path.resolve(__dirname, '..', '..', 'public/css/style.css');
  return fs.readFileSync(filePath, 'utf8');
}

describe('Frontend stylesheet contract', () => {
  test('defines design token roots for overhaul theme', () => {
    const css = loadStyleSheet();

    expect(css.includes('--font-display')).toBe(true);
    expect(css.includes('--font-body')).toBe(true);
    expect(css.includes('--accent')).toBe(true);
    expect(css.includes('--surface-glass')).toBe(true);
  });

  test('includes required state classes used by runtime scripts', () => {
    const css = loadStyleSheet();

    expect(css.includes('.fade-out')).toBe(true);
    expect(css.includes('.video-loading-overlay')).toBe(true);
    expect(css.includes('.video-loading-spinner')).toBe(true);
    expect(css.includes('body.overlay-open')).toBe(true);
    expect(css.includes('.search-container.focused .search-input')).toBe(true);
  });

  test('does not rely on css @import font loading', () => {
    const css = loadStyleSheet();
    expect(css.includes('@import url(')).toBe(false);
  });
});
