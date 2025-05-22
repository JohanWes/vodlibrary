/**
 * CDN integration module
 * 
 * This module provides functionality for integrating with Content Delivery Networks (CDNs)
 * to improve video delivery performance and reduce origin server load.
 */

// Default configuration
const config = {
  // Enable/disable CDN
  enabled: false,
  // CDN provider (supported: 'custom', 'cloudflare', 'bunny', 'keycdn')
  provider: 'custom',
  // CDN base URL (for custom provider)
  baseUrl: '',
  // CDN token (if required by provider)
  token: '',
  // CDN region (if applicable)
  region: 'auto',
  // Path prefix for CDN URLs
  pathPrefix: '',
  // Content types to serve via CDN
  contentTypes: ['video', 'thumbnail'],
  // Cache TTL in seconds (for CDN)
  cacheTtl: 86400, // 24 hours
  // Enable/disable signed URLs
  signedUrls: false,
  // Secret key for signed URLs
  signedUrlsSecret: '',
  // Signed URLs expiration time in seconds
  signedUrlsExpiration: 3600 // 1 hour
};

/**
 * Initialize the CDN module with configuration
 * @param {Object} newConfig - Configuration options
 */
function initCdn(newConfig = {}) {
  Object.assign(config, newConfig);
  
  console.log(`CDN module initialized with provider: ${config.provider}`);
  console.log(`CDN enabled: ${config.enabled}`);
  
  return config;
}

/**
 * Generate a CDN URL for a resource
 * @param {string} originalUrl - The original URL of the resource
 * @param {string} contentType - The type of content ('video', 'thumbnail', etc.)
 * @param {Object} options - Additional options for URL generation
 * @returns {string} - The CDN URL
 */
function getCdnUrl(originalUrl, contentType = 'video', options = {}) {
  if (!config.enabled || !config.contentTypes.includes(contentType)) {
    return originalUrl;
  }
  
  try {
    const parsedUrl = new URL(originalUrl, 'http://localhost');
    const path = parsedUrl.pathname;
    
    switch (config.provider) {
      case 'cloudflare':
        return generateCloudflareUrl(path, contentType, options);
      case 'bunny':
        return generateBunnyUrl(path, contentType, options);
      case 'keycdn':
        return generateKeyCdnUrl(path, contentType, options);
      case 'custom':
      default:
        return generateCustomCdnUrl(path, contentType, options);
    }
  } catch (error) {
    console.error('Error generating CDN URL:', error);
    return originalUrl;
  }
}

/**
 * Generate a Cloudflare CDN URL
 * @private
 */
function generateCloudflareUrl(path, contentType, options) {
  const baseUrl = config.baseUrl || '';
  
  const prefixedPath = config.pathPrefix ? `/${config.pathPrefix}${path}` : path;
  
  let url = `${baseUrl}${prefixedPath}`;
  
  if (options.queryParams) {
    url += '?' + new URLSearchParams(options.queryParams).toString();
  }
  
  return url;
}

/**
 * Generate a BunnyCDN URL
 * @private
 */
function generateBunnyUrl(path, contentType, options) {
  const baseUrl = config.baseUrl || '';
  
  const prefixedPath = config.pathPrefix ? `/${config.pathPrefix}${path}` : path;
  
  let url = `${baseUrl}${prefixedPath}`;
  
  if (options.queryParams) {
    url += '?' + new URLSearchParams(options.queryParams).toString();
  }
  
  if (config.token && contentType === 'video') {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}token=${config.token}`;
  }
  
  return url;
}

/**
 * Generate a KeyCDN URL
 * @private
 */
function generateKeyCdnUrl(path, contentType, options) {
  const baseUrl = config.baseUrl || '';
  
  const prefixedPath = config.pathPrefix ? `/${config.pathPrefix}${path}` : path;
  
  let url = `${baseUrl}${prefixedPath}`;
  
  if (options.queryParams) {
    url += '?' + new URLSearchParams(options.queryParams).toString();
  }
  
  return url;
}

/**
 * Generate a custom CDN URL
 * @private
 */
function generateCustomCdnUrl(path, contentType, options) {
  const baseUrl = config.baseUrl || '';
  
  const prefixedPath = config.pathPrefix ? `/${config.pathPrefix}${path}` : path;
  
  let url = `${baseUrl}${prefixedPath}`;
  
  if (options.queryParams) {
    url += '?' + new URLSearchParams(options.queryParams).toString();
  }
  
  if (config.signedUrls && config.signedUrlsSecret) {
    url = generateSignedUrl(url);
  }
  
  return url;
}

/**
 * Generate a signed URL for secure CDN access
 * @param {string} url - The URL to sign
 * @returns {string} - The signed URL
 * @private
 */
function generateSignedUrl(url) {
  try {
    const crypto = require('crypto');
    
    const expires = Math.floor(Date.now() / 1000) + config.signedUrlsExpiration;
    
    const separator = url.includes('?') ? '&' : '?';
    const urlWithExpires = `${url}${separator}expires=${expires}`;
    
    const signature = crypto
      .createHmac('sha1', config.signedUrlsSecret)
      .update(urlWithExpires)
      .digest('hex');
    
    return `${urlWithExpires}&signature=${signature}`;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return url;
  }
}

/**
 * Check if a URL should be served via CDN
 * @param {string} url - The URL to check
 * @param {string} contentType - The type of content
 * @returns {boolean} - Whether the URL should be served via CDN
 */
function shouldUseCdn(url, contentType = 'video') {
  return config.enabled && config.contentTypes.includes(contentType);
}

/**
 * Update CDN configuration
 * @param {Object} newConfig - New configuration values
 * @returns {Object} - Updated configuration
 */
function updateConfig(newConfig) {
  Object.assign(config, newConfig);
  console.log('CDN configuration updated:', config);
  return config;
}

/**
 * Get current CDN configuration
 * @returns {Object} - Current configuration
 */
function getConfig() {
  return { ...config };
}

module.exports = {
  initCdn,
  getCdnUrl,
  shouldUseCdn,
  updateConfig,
  getConfig
};
