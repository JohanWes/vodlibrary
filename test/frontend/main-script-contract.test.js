/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

function loadMainScript() {
  const filePath = path.resolve(__dirname, '..', '..', 'public/js/main.js');
  return fs.readFileSync(filePath, 'utf8');
}

describe('Main script contract', () => {
  test('uses passive scroll listener for infinite scrolling', () => {
    const source = loadMainScript();
    expect(source.includes("window.addEventListener('scroll', handleInfiniteScroll, { passive: true });")).toBe(true);
  });

  test('does not inject search focus or preload info styles via runtime <style> tags', () => {
    const source = loadMainScript();
    expect(source.includes('limited-preload-styles')).toBe(false);
    expect(source.includes('.search-container.focused .search-input')).toBe(false);
  });
});
