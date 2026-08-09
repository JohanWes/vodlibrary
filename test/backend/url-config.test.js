const { normalizeBasePath, parsePublicBaseUrl } = require('../../lib/url-config');

describe('normalizeBasePath', () => {
  test('returns empty for non-string values', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath(null)).toBe('');
    expect(normalizeBasePath(42)).toBe('');
    expect(normalizeBasePath({})).toBe('');
  });

  test('returns empty for empty or root-only input', () => {
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('//')).toBe('');
    expect(normalizeBasePath('///')).toBe('');
  });

  test('normalizes to a single leading slash with no trailing slash', () => {
    expect(normalizeBasePath('/vods')).toBe('/vods');
    expect(normalizeBasePath('vods')).toBe('/vods');
    expect(normalizeBasePath('/vods/')).toBe('/vods');
    expect(normalizeBasePath('vods/')).toBe('/vods');
    expect(normalizeBasePath('///vods//')).toBe('/vods');
    expect(normalizeBasePath('/a/b')).toBe('/a/b');
    expect(normalizeBasePath('a/b/')).toBe('/a/b');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeBasePath('  /vods  ')).toBe('/vods');
    expect(normalizeBasePath('\t/vods\n')).toBe('/vods');
  });

  test('rejects backslashes', () => {
    expect(normalizeBasePath('/a\\b')).toBe('');
    expect(normalizeBasePath('\\vods')).toBe('');
  });

  test('rejects query strings and fragments', () => {
    expect(normalizeBasePath('/vods?x=1')).toBe('');
    expect(normalizeBasePath('/vods#frag')).toBe('');
    expect(normalizeBasePath('vods?')).toBe('');
  });

  test('rejects dot segments', () => {
    expect(normalizeBasePath('/a/../b')).toBe('');
    expect(normalizeBasePath('/a/./b')).toBe('');
    expect(normalizeBasePath('/..')).toBe('');
    expect(normalizeBasePath('/a/..')).toBe('');
  });

  test('never returns a trailing slash', () => {
    for (const input of ['/', '/vods/', 'vods/', '///a//b///', '/vods']) {
      const result = normalizeBasePath(input);
      expect(result.endsWith('/')).toBe(false);
    }
  });
});

describe('parsePublicBaseUrl', () => {
  test('returns null for empty or non-string input', () => {
    expect(parsePublicBaseUrl('', '/vods')).toBeNull();
    expect(parsePublicBaseUrl('   ', '/vods')).toBeNull();
    expect(parsePublicBaseUrl(undefined, '/vods')).toBeNull();
    expect(parsePublicBaseUrl(null, '/vods')).toBeNull();
    expect(parsePublicBaseUrl(42, '/vods')).toBeNull();
  });

  test('rejects non-http(s) schemes', () => {
    expect(parsePublicBaseUrl('ftp://shares.example.com', '')).toBeNull();
    expect(parsePublicBaseUrl('file:///etc/passwd', '')).toBeNull();
    expect(parsePublicBaseUrl('javascript:alert(1)', '')).toBeNull();
    expect(parsePublicBaseUrl('localhost:8005', '')).toBeNull();
  });

  test('rejects credentials', () => {
    expect(parsePublicBaseUrl('https://user:pass@shares.example.com', '')).toBeNull();
    expect(parsePublicBaseUrl('https://user@shares.example.com', '')).toBeNull();
    expect(parsePublicBaseUrl('https://shares.example.com@evil.example.com', '')).toBeNull();
  });

  test('rejects query strings, fragments, and non-root pathnames', () => {
    expect(parsePublicBaseUrl('https://shares.example.com?x=1', '')).toBeNull();
    expect(parsePublicBaseUrl('https://shares.example.com#frag', '')).toBeNull();
    expect(parsePublicBaseUrl('https://shares.example.com/path', '')).toBeNull();
    expect(parsePublicBaseUrl('https://shares.example.com/vods', '')).toBeNull();
    expect(parsePublicBaseUrl('https://shares.example.com//', '')).toBeNull();
  });

  test('rejects unparsable input', () => {
    expect(parsePublicBaseUrl('not a url', '')).toBeNull();
    expect(parsePublicBaseUrl('https://exa mple.com', '')).toBeNull();
  });

  test('returns the origin without a trailing slash', () => {
    expect(parsePublicBaseUrl('https://shares.example.com', '')).toBe('https://shares.example.com');
    expect(parsePublicBaseUrl('https://shares.example.com/', '')).toBe('https://shares.example.com');
    expect(parsePublicBaseUrl('http://localhost:8005', '')).toBe('http://localhost:8005');
    expect(parsePublicBaseUrl('https://shares.example.com:8443', '')).toBe('https://shares.example.com:8443');
  });

  test('appends the normalized base path exactly once', () => {
    expect(parsePublicBaseUrl('https://shares.example.com', '/vods')).toBe('https://shares.example.com/vods');
    expect(parsePublicBaseUrl('https://shares.example.com', 'vods')).toBe('https://shares.example.com/vods');
    expect(parsePublicBaseUrl('https://shares.example.com/', '/vods/')).toBe('https://shares.example.com/vods');
    expect(parsePublicBaseUrl('https://shares.example.com', '///vods//')).toBe('https://shares.example.com/vods');
    expect(parsePublicBaseUrl('https://shares.example.com', '/a/b')).toBe('https://shares.example.com/a/b');
  });

  test('appends nothing when the base path is empty or invalid', () => {
    expect(parsePublicBaseUrl('https://shares.example.com', '')).toBe('https://shares.example.com');
    expect(parsePublicBaseUrl('https://shares.example.com', undefined)).toBe('https://shares.example.com');
    expect(parsePublicBaseUrl('https://shares.example.com', '/a/../b')).toBe('https://shares.example.com');
    expect(parsePublicBaseUrl('https://shares.example.com', '/a?x=1')).toBe('https://shares.example.com');
  });

  test('never returns a trailing slash', () => {
    const inputs = [
      ['https://shares.example.com', ''],
      ['https://shares.example.com/', '/vods/'],
      ['http://localhost:8005', '/vods'],
      ['https://shares.example.com', '/']
    ];
    for (const [raw, basePath] of inputs) {
      const result = parsePublicBaseUrl(raw, basePath);
      expect(result.endsWith('/')).toBe(false);
    }
  });
});
