// Express server with API endpoints for the video sharing/viewing software
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load .env before requiring modules that read environment variables. Tests
// set their own environment and must not inherit the developer's .env.
const envFile = path.join(__dirname, '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const express = require('express');
const cookieParser = require('cookie-parser');

const {
  initializeDatabase,
  closeDatabase,
  getVideoCardByPath,
  getVideoStreamInfo
} = require('./db/database');
const { scanLibrary, stopMediaPipeline } = require('./lib/scanner');
const { startLibraryWatcher } = require('./lib/watcher');
const cdnManager = require('./lib/cdn');
const {
  issueSessionToken,
  verifySessionToken,
  verifyShareToken
} = require('./lib/security-tokens');
const { toVideoCard } = require('./lib/client-video');
const { normalizeBasePath, parsePublicBaseUrl } = require('./lib/url-config');
const { parseCanonicalInt } = require('./lib/parse');
const { createLoginThrottle } = require('./lib/login-throttle');

const app = express();

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function debugLog(...args) {
  if (LOG_LEVEL === 'debug') {
    console.log(...args);
  }
}

const port = process.env.PORT || 8005;
const publicIp = process.env.HOST_IP || 'localhost';
const basePath = normalizeBasePath(process.env.BASE_PATH || '');
const vodsName = process.env.VODS_NAME || 'VODlibrary';

// TRUST_PROXY: 'true'/'false', a hop count, or an Express trust list such as
// 'loopback, 10.0.0.0/8'. Defaults to 'loopback': Caddy runs on the same host.
function parseTrustProxy(raw) {
  const value = (raw || '').trim() || 'loopback';
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return /^\d+$/.test(value) ? Number(value) : value;
}

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.disable('x-powered-by');

// Initialize CDN if configured. Redirect URLs are built from req.originalUrl,
// which already includes BASE_PATH, so no path prefix is configured here.
const cdnEnabled = process.env.CDN_ENABLED === 'true';
const cdnProvider = process.env.CDN_PROVIDER || 'custom';
const cdnBaseUrl = process.env.CDN_BASE_URL || '';

cdnManager.initCdn({
  enabled: cdnEnabled,
  provider: cdnProvider,
  baseUrl: cdnBaseUrl,
  token: process.env.CDN_TOKEN || '',
  signedUrls: process.env.CDN_SIGNED_URLS === 'true',
  signedUrlsSecret: process.env.CDN_SIGNED_URLS_SECRET || ''
});

// Everything the pages load is same-origin (fonts and Plyr are vendored). The
// one exception is media: with the CDN enabled, /stream redirects to CDN_BASE_URL.
function buildContentSecurityPolicy(mediaOrigin = '') {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    `media-src 'self' blob:${mediaOrigin ? ` ${mediaOrigin}` : ''}`,
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ');
}

function httpOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : '';
  } catch (_error) {
    return '';
  }
}

const cspHeaderName = process.env.CSP_REPORT_ONLY === 'true'
  ? 'Content-Security-Policy-Report-Only'
  : 'Content-Security-Policy';
const contentSecurityPolicy = buildContentSecurityPolicy(cdnEnabled ? httpOrigin(cdnBaseUrl) : '');

// Baseline security headers. /watch and /s tighten Referrer-Policy further.
app.use((_req, res, next) => {
  res.setHeader(cspHeaderName, contentSecurityPolicy);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

const sseClients = new Set();

function removeSseClient(client) {
  if (!client) {
    return;
  }

  if (client.heartbeatInterval) {
    clearInterval(client.heartbeatInterval);
  }

  sseClients.delete(client);
}

function sendSseUpdate(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  const staleClients = [];

  for (const client of sseClients) {
    if (client.res.writableEnded || client.res.destroyed) {
      staleClients.push(client);
      continue;
    }

    try {
      client.res.write(message);
    } catch (_error) {
      staleClients.push(client);
    }
  }

  staleClients.forEach(removeSseClient);
  debugLog(`Sent SSE update (${data.type}) to ${sseClients.size} clients.`);
}

const publicDir = path.join(__dirname, 'public');

const SESSION_KEY = process.env.SESSION_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET;
const ENABLE_AUTH = process.env.ENABLE_AUTH === 'true';
const AUTH_COOKIE_NAME = 'auth_token';
const SHARE_COOKIE_NAME = 'share_auth';
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.AUTH_COOKIE_SECURE === 'true',
  maxAge: AUTH_COOKIE_MAX_AGE,
  path: basePath || '/'
};

// Express routing is case-insensitive, so the 401-vs-redirect choice is too.
function isApiOrMediaRequest(req) {
  const requestPath = req.path.toLowerCase();
  const base = basePath.toLowerCase();
  return ['/api/', '/previews/', '/thumbnails/'].some((prefix) => requestPath.startsWith(base + prefix));
}

function getSharedVideoId(req) {
  const share = verifyShareToken(
    req.cookies && req.cookies[SHARE_COOKIE_NAME],
    SHARE_TOKEN_SECRET
  );
  if (!share || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return null;
  }

  const allowedPaths = new Set([
    `${basePath}/watch/${share.videoId}`,
    `${basePath}/api/videos/${share.videoId}`,
    `${basePath}/api/videos/${share.videoId}/stream`
  ]);
  return allowedPaths.has(req.path) ? share.videoId : null;
}

function checkAuth(req, res, next) {
  if (!ENABLE_AUTH) {
    return next();
  }

  if (!SESSION_KEY || !SESSION_SECRET) {
    console.error('Authentication is enabled but SESSION_KEY or SESSION_SECRET is not set.');
    return res.status(500).send('Server configuration error: authentication secrets are required.');
  }

  if (verifySessionToken(
    req.cookies && req.cookies[AUTH_COOKIE_NAME],
    SESSION_SECRET
  )) {
    return next();
  }

  if (getSharedVideoId(req) !== null) {
    return next();
  }

  if (isApiOrMediaRequest(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.redirect(basePath + '/login.html');
}

// 5 failed logins per IPv4 address or IPv6 /64 within 15 minutes lock it out for 15 minutes.
const loginThrottle = createLoginThrottle();

// Constant-time comparison: hash both sides so the buffers always have equal length.
function secretsMatch(candidate, expected) {
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyBasePath(html) {
  const baseHref = basePath ? `${basePath}/` : '/';
  return html.replace('<base href="/">', () => `<base href="${escapeHtml(baseHref)}">`);
}

// VODS_NAME is used verbatim; the login page title is rendered server-side.
function applySiteName(html) {
  return html.replace('<title>Login</title>', () => `<title>Login - ${escapeHtml(vodsName)}</title>`);
}

const templateCache = new Map();

async function loadTemplate(name) {
  if (!templateCache.has(name)) {
    templateCache.set(name, await fs.promises.readFile(path.join(publicDir, name), 'utf8'));
  }
  return applySiteName(applyBasePath(templateCache.get(name)));
}

async function sendHtmlPage(res, name) {
  try {
    const html = await loadTemplate(name);
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(html);
  } catch (error) {
    console.error(`Error serving ${name}:`, error);
    return res.status(500).send('Internal Server Error');
  }
}

const mediaVisibility = ENABLE_AUTH ? 'private' : 'public';

// Thumbnails and preview clips: behind auth, cacheable for a day.
const mediaStaticOptions = {
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', `${mediaVisibility}, max-age=86400`);
  }
};

// App shell assets (JS/CSS/icons): revalidated hourly; HTML always revalidated.
const appStaticOptions = {
  cacheControl: false,
  setHeaders: (res, filePath) => {
    res.setHeader(
      'Cache-Control',
      filePath.endsWith('.html') ? 'no-cache' : `${mediaVisibility}, max-age=3600`
    );
  }
};

// Pre-auth app shell: what the login page and a share-link viewer need, public
// and revalidated hourly. Only exact file paths (no dot segments can match) and
// the vendor/ and fonts/ directories (own static roots, so `..` cannot leave
// them). A missing file falls through to checkAuth like any other path.
const PRE_AUTH_FILES = new Set(['/css/style.css', '/js/utils.js', '/js/player.js', '/js/login.js', '/favicon.ico']);
const preAuthStaticOptions = { maxAge: '1h' };
const servePreAuthFile = express.static(publicDir, preAuthStaticOptions);
app.get(basePath + '/login.html', (_req, res) => sendHtmlPage(res, 'login.html'));
app.use(basePath, (req, res, next) => (PRE_AUTH_FILES.has(req.path) ? servePreAuthFile(req, res, next) : next()));
for (const dir of ['vendor', 'fonts']) {
  app.use(`${basePath}/${dir}`, express.static(path.join(publicDir, dir), preAuthStaticOptions));
}

app.post(basePath + '/login', (req, res) => {
  if (!SESSION_KEY || !SESSION_SECRET) {
    return res.status(500).send('Server configuration error: authentication secrets are required.');
  }

  const now = Date.now();
  const clientIp = req.ip || 'unknown';
  const lockoutMs = loginThrottle.lockoutRemaining(clientIp, now);
  if (lockoutMs > 0) {
    res.setHeader('Retry-After', String(Math.ceil(lockoutMs / 1000)));
    return res.status(429).send('Too many failed login attempts. Try again later.');
  }

  const candidate = req.body && req.body.sessionKey;
  if (typeof candidate === 'string' && secretsMatch(candidate, SESSION_KEY)) {
    loginThrottle.clear(clientIp);
    res.cookie(
      AUTH_COOKIE_NAME,
      issueSessionToken(SESSION_SECRET),
      AUTH_COOKIE_OPTIONS
    );
    return res.redirect(basePath + '/');
  }

  loginThrottle.recordFailure(clientIp, now);
  console.warn(`Failed login attempt from ${clientIp}`);
  return res.redirect(basePath + '/login.html?error=1');
});

// Forward a share link's start time (seconds, decimals allowed); drop anything else.
function shareStartTime(raw) {
  if (typeof raw !== 'string' || !/^\d{1,7}(\.\d{1,3})?$/.test(raw)) {
    return '';
  }
  const seconds = Number(raw);
  return seconds < 1e6 ? `?t=${seconds}` : '';
}

app.get(basePath + '/s/:token', (req, res) => {
  const share = verifyShareToken(req.params.token, SHARE_TOKEN_SECRET);
  if (!share) {
    return res.status(404).send('Share link not found');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.cookie(SHARE_COOKIE_NAME, req.params.token, {
    ...AUTH_COOKIE_OPTIONS,
    maxAge: share.expiresAt - Date.now()
  });
  return res.redirect(303, `${basePath}/watch/${share.videoId}${shareStartTime(req.query.t)}`);
});

app.get(basePath + '/api/config', (_req, res) => {
  res.json({ vodsName, advancedSearch: process.env.ADVANCED_SEARCH_ENABLED === 'true' });
});

// Everything below this point is private when authentication is enabled.
app.use(checkAuth);

app.use(basePath + '/previews', express.static(
  process.env.PREVIEWS_CACHE_DIR || path.join(publicDir, 'previews'),
  mediaStaticOptions
));
app.use(basePath + '/thumbnails', express.static(
  process.env.THUMBNAIL_CACHE_DIR || path.join(publicDir, 'thumbnails'),
  mediaStaticOptions
));

const sseMaxClients = Math.max(1, Number.parseInt(process.env.SSE_MAX_CLIENTS || '100', 10) || 100);
app.get(basePath + '/api/updates', (req, res) => {
  if (sseClients.size >= sseMaxClients) {
    return res.status(503).json({ error: 'Too many update connections' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 5000\n\n');

  const client = { res, heartbeatInterval: null };
  client.heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      removeSseClient(client);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch (_error) {
      removeSseClient(client);
    }
  }, 25000);
  sseClients.add(client);

  const close = () => {
    removeSseClient(client);
    if (!res.writableEnded) {
      res.end();
    }
  };
  req.on('close', close);
  res.on('error', close);
});

// Media routes: preview clips and /api/videos/:id/stream.
const publicApiRoutes = require('./routes/public-api');
app.use(basePath + '/api', publicApiRoutes);

app.get(basePath + '/watch/:id', async (req, res) => {
  const videoId = parseCanonicalInt(req.params.id);
  if (videoId === null) {
    return res.status(404).send('Video not found');
  }

  try {
    const video = await getVideoStreamInfo(req.app.locals.db, videoId);
    if (!video) {
      return res.status(404).send('Video not found');
    }

    let playerHtml = await loadTemplate('player.html');
    const title = escapeHtml(video.title);
    const siteName = escapeHtml(vodsName);
    const publicBase = parsePublicBaseUrl(process.env.SHARE_BASE_URL, basePath);
    const width = Number.isFinite(video.width) && video.width > 0 ? video.width : 1280;
    const height = Number.isFinite(video.height) && video.height > 0 ? video.height : 720;
    const absoluteTags = !ENABLE_AUTH && publicBase
      ? `
  <meta property="og:url" content="${escapeHtml(`${publicBase}/watch/${videoId}`)}" />
  <meta property="og:video" content="${escapeHtml(`${publicBase}/api/videos/${videoId}/stream`)}" />
  <meta property="og:video:secure_url" content="${escapeHtml(`${publicBase}/api/videos/${videoId}/stream`)}" />`
      : '';
    const ogTags = `
  <meta property="og:title" content="${title}" />
  <meta property="og:type" content="video.movie" />
  <meta property="og:description" content="Watch ${title} on ${siteName}" />
  <meta property="og:site_name" content="${siteName}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="${width}" />
  <meta property="og:video:height" content="${height}" />${absoluteTags}
    `;

    // Replacer functions: a string replacement would expand `$&`, `$'`, etc. in titles.
    playerHtml = playerHtml.replace('</head>', () => `${ogTags}\n</head>`);
    playerHtml = playerHtml.replace('<title>Loading...</title>', () => `<title>${title}</title>`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(playerHtml);
  } catch (error) {
    console.error(`Error serving video ${req.params.id}:`, error);
    return res.status(500).send('Internal Server Error');
  }
});

app.get(basePath + '/', (_req, res) => sendHtmlPage(res, 'index.html'));

app.use(basePath, express.static(publicDir, appStaticOptions));

const apiRoutes = require('./routes/api');
app.use(basePath + '/api', apiRoutes);

// Library watcher with live SSE updates to open clients.
function setupLibraryWatcher(db) {
  return startLibraryWatcher(db, {
    onAdd: async (filePath) => {
      const video = await getVideoCardByPath(db, filePath);
      if (video) {
        sendSseUpdate({ type: 'add', video: toVideoCard(video) });
      }
    },
    onDelete: (videoId) => {
      sendSseUpdate({ type: 'delete', videoId });
    }
  });
}

const SHUTDOWN_TIMEOUT_MS = 10000;
const FORCED_DB_CLOSE_MS = 2000;

/**
 * Close the HTTP server (dropping open SSE and media connections; players
 * resume with a Range request), stop the media pipeline (scan, watchers,
 * preview queue, ffmpeg children) and close the database. Exits 0 on a clean
 * stop, 1 on error or after `timeoutMs`; the database is closed either way.
 */
function createShutdownHandler({ server, db, stopPipeline = stopMediaPipeline, exit = process.exit, timeoutMs = SHUTDOWN_TIMEOUT_MS }) {
  let shuttingDown = false;
  let exited = false;
  let dbClosed = null;
  const finish = (code) => {
    if (!exited) {
      exited = true;
      exit(code);
    }
  };
  const closeDb = () => {
    dbClosed ||= closeDatabase(db).then(() => true, (error) => {
      console.error('Error closing database:', error);
      return false;
    });
    return dbClosed;
  };

  return async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    const forceExitTimer = setTimeout(() => {
      console.error(`Shutdown did not finish within ${timeoutMs} ms; forcing exit.`);
      setTimeout(() => finish(1), FORCED_DB_CLOSE_MS); // in case closing the database hangs
      closeDb().finally(() => finish(1));
    }, timeoutMs);
    forceExitTimer.unref();

    for (const client of [...sseClients]) {
      removeSseClient(client);
      client.res.end();
    }
    const serverClosed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();

    const results = await Promise.allSettled([serverClosed, Promise.resolve().then(stopPipeline)]);
    const dbOk = await closeDb();
    clearTimeout(forceExitTimer);
    finish(dbOk && results.every((result) => result.status === 'fulfilled') ? 0 : 1);
  };
}

async function startServer() {
  if (ENABLE_AUTH && (!SESSION_KEY || !SESSION_SECRET)) {
    throw new Error('SESSION_KEY and SESSION_SECRET are required when authentication is enabled.');
  }
  try {
    const db = await initializeDatabase();
    app.locals.db = db;

    setupLibraryWatcher(db);

    const server = app.listen({ port, host: publicIp }, () => {
      console.log('Video server running at:');
      console.log(`- Local: http://localhost:${port}${basePath}`);
      console.log(`- Public: http://${publicIp}:${port}${basePath}`);

      if (cdnEnabled && cdnBaseUrl) {
        console.log(`- CDN base URL: ${cdnBaseUrl}`);
      }

      scanLibrary(db).catch((scanError) => {
        console.error('Background startup scan failed:', scanError);
      });
    });

    const shutdown = createShutdownHandler({ server, db });
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
    return null;
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildContentSecurityPolicy,
  createShutdownHandler,
  parseTrustProxy,
  resetLoginThrottle: loginThrottle.reset
};
