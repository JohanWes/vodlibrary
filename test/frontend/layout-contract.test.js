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

  test('index does not load the unused GSAP bundle', () => {
    const document = loadDom('public/index.html');
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map(script => script.getAttribute('src'));

    expect(scripts.some(src => src && src.toLowerCase().includes('gsap'))).toBe(false);
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

  test('player page shares global typography includes', () => {
    const document = loadDom('public/player.html');
    const fontStylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map(link => link.getAttribute('href'));

    expect(fontStylesheets.some(href => href && href.includes('fonts.googleapis.com'))).toBe(true);
  });

  test('login page avoids page-scoped inline style blocks', () => {
    const document = loadDom('public/login.html');
    const inlineStyles = document.querySelectorAll('style');

    expect(inlineStyles).toHaveLength(0);
  });
});
