/**
 * Public URL configuration helpers.
 *
 * Normalizes the BASE_PATH environment value and validates the public share
 * base URL so share links are always built from an http(s) origin plus a
 * normalized base path - never from credentials, query strings, fragments,
 * or non-root paths.
 */

// Rejects backslashes, query strings, and fragments anywhere in the path.
const INVALID_PATH_RE = /[\\?#]/;

/**
 * Normalize a base path to empty or a single-leading, no-trailing slash path.
 * Rejects non-strings, backslashes, dot segments, and query/hash fragments.
 * @param {*} raw - Raw BASE_PATH value
 * @returns {string} Normalized path, or '' when invalid
 */
function normalizeBasePath(raw) {
  if (typeof raw !== 'string') {
    return '';
  }

  const trimmed = raw.trim();
  if (trimmed === '' || INVALID_PATH_RE.test(trimmed)) {
    return '';
  }

  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return '';
  }

  const stripped = trimmed.replace(/\/+$/, '');
  if (stripped === '') {
    return '';
  }

  return '/' + stripped.replace(/^\/+/, '');
}

/**
 * Parse and validate a public base URL, then append the normalized base path.
 * Accepts only http(s) URLs with no credentials, query, hash, or non-root
 * pathname. Returns null for missing or invalid input.
 * @param {*} raw - Raw SHARE_BASE_URL value
 * @param {*} basePath - Raw BASE_PATH value
 * @returns {string|null} `<origin><normalized base path>` with no trailing slash
 */
function parsePublicBaseUrl(raw, basePath) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  if (url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return null;
  }

  return url.origin + normalizeBasePath(basePath);
}

module.exports = { normalizeBasePath, parsePublicBaseUrl };
