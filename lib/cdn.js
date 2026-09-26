/**
 * CDN redirect URLs.
 *
 * Maps a local media path onto CDN_BASE_URL. Only used when authentication is
 * disabled (private media never leaves the origin). Providers differ only in
 * how the URL is signed:
 *   - bunny:  Bunny token authentication, ?token=<sha256 b64url>&expires=<unix s>
 *   - custom: optional HMAC-SHA1 ?expires=..&signature=.. (CDN_SIGNED_URLS)
 *   - cloudflare / keycdn: unsigned
 * The raw CDN_TOKEN / signing secret is never placed in a URL.
 */

const crypto = require('crypto');

const config = {
  enabled: false,
  provider: 'custom',
  baseUrl: '',
  token: '',
  contentTypes: ['video', 'thumbnail'],
  signedUrls: false,
  signedUrlsSecret: '',
  signedUrlsExpiration: 3600
};

function initCdn(newConfig = {}) {
  Object.assign(config, newConfig);
  if (config.enabled) {
    console.log(`CDN enabled with provider: ${config.provider}`);
  }
  return config;
}

function shouldUseCdn(_url, contentType = 'video') {
  return Boolean(config.enabled && config.baseUrl && config.contentTypes.includes(contentType));
}

/**
 * Build the CDN URL for a local URL or path.
 * @param {string} originalUrl - Request URL/path, e.g. req.originalUrl (never built from Host)
 * @param {string} contentType - 'video' | 'thumbnail'
 * @returns {string|null} CDN URL, the input unchanged when the CDN does not
 *   apply, or null when no valid CDN URL can be built (serve locally instead).
 */
function getCdnUrl(originalUrl, contentType = 'video') {
  if (!shouldUseCdn(originalUrl, contentType)) {
    return originalUrl;
  }

  try {
    const { pathname } = new URL(originalUrl, 'http://localhost');
    const url = `${new URL(config.baseUrl).href.replace(/\/+$/, '')}${pathname}`;
    const expires = Math.floor(Date.now() / 1000) + config.signedUrlsExpiration;

    if (config.provider === 'bunny' && config.token && contentType === 'video') {
      // Bunny token auth signs the path as the CDN receives it, base URL path included.
      const signedPath = new URL(url).pathname;
      const token = crypto.createHash('sha256').update(`${config.token}${signedPath}${expires}`).digest('base64url');
      return `${url}?token=${token}&expires=${expires}`;
    }
    if (config.provider === 'custom' && config.signedUrls && config.signedUrlsSecret) {
      const urlWithExpires = `${url}?expires=${expires}`;
      const signature = crypto.createHmac('sha1', config.signedUrlsSecret).update(urlWithExpires).digest('hex');
      return `${urlWithExpires}&signature=${signature}`;
    }
    return url;
  } catch (error) {
    console.error('Error generating CDN URL:', error);
    return null;
  }
}

module.exports = {
  initCdn,
  getCdnUrl,
  shouldUseCdn
};
