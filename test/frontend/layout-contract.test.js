/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..', '..');

test.each(['web/index.html', 'web/player.html', 'web/login.html'])(
  '%s is ready for a strict CSP (no inline scripts, handlers, styles or third-party resources)',
  (page) => {
    const { document } = new JSDOM(fs.readFileSync(path.join(root, page), 'utf8')).window;
    const scripts = Array.from(document.querySelectorAll('script'));

    expect(scripts.filter((script) => !script.getAttribute('src'))).toHaveLength(0);
    expect(document.querySelectorAll('style, [style]')).toHaveLength(0);
    const handlerAttributes = Array.from(document.querySelectorAll('*'))
      .flatMap((element) => element.getAttributeNames().filter((name) => name.startsWith('on')));
    expect(handlerAttributes).toEqual([]);
    const references = Array.from(document.querySelectorAll('link[href], script[src], img[src]'))
      .map((element) => element.getAttribute('href') || element.getAttribute('src'));
    expect(references.filter((ref) => /^(https?:)?\/\//i.test(ref))).toEqual([]);
  }
);
