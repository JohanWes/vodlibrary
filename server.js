// Express server with API endpoints for the video sharing/viewing software
const path = require('path');
const fs = require('fs');

// Load .env before requiring modules that read environment variables
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const express = require('express');
const cookieParser = require('cookie-parser');
const chokidar = require('chokidar');

const {
  initializeDatabase,
  getVideoByPath,
  deleteVideo,
  getVideoById
} = require('./db/database');
const { scanLibrary, processVideoFile, isVideoFile } = require('./lib/scanner');
const videoCache = require('./lib/cache');
const cdnManager = require('./lib/cdn');
const {
  issueSessionToken,
  verifySessionToken,
  verifyShareToken
} = require('./lib/security-tokens');
const { toVideoCard } = require('./lib/client-video');
const { normalizeBasePath, parsePublicBaseUrl } = require('./lib/url-config');

const app = express();

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const FIXED_STREAM_SEGMENT_SIZE = 2 * 1024 * 1024;

function debugLog(...args) {
  if (LOG_LEVEL === 'debug') {
    console.log(...args);
  }
}

function sliceCanonicalSegmentForRange(cachedSegment, segmentStart, start, end) {
  if (!Buffer.isBuffer(cachedSegment)) {
    return null;
  }

  const offsetStart = start - segmentStart;
  const offsetEndExclusive = (end - segmentStart) + 1;
  if (offsetStart < 0 || offsetEndExclusive > cachedSegment.length || offsetStart >= offsetEndExclusive) {
    return null;
  }

  return cachedSegment.subarray(offsetStart, offsetEndExclusive);
}

// Get port and IP from environment variables with fallbacks
const port = process.env.PORT || 8005;
const publicIp = process.env.HOST_IP || 'localhost';
const basePath = normalizeBasePath(process.env.BASE_PATH || '');
const vodsName = process.env.VODS_NAME || 'VODlibrary';

// Initialize server-side caching
const cacheMaxSize = parseInt(process.env.CACHE_MAX_SIZE || '500', 10) * 1024 * 1024;
const cacheTtl = parseInt(process.env.CACHE_TTL || '3600', 10);
const cachePopularityThreshold = parseInt(process.env.CACHE_POPULARITY_THRESHOLD || '0', 10);
const cacheMaxSegmentsPerVideo = parseInt(process.env.CACHE_MAX_SEGMENTS_PER_VIDEO || '3', 10);

videoCache.updateConfig({
  maxCacheSize: cacheMaxSize,
  stdTTL: cacheTtl,
  popularityThreshold: cachePopularityThreshold,
  maxSegmentsPerVideo: cacheMaxSegmentsPerVideo
});

// Initialize CDN if configured
const cdnEnabled = process.env.CDN_ENABLED === 'true';
const cdnProvider = process.env.CDN_PROVIDER || 'custom';
const cdnBaseUrl = process.env.CDN_BASE_URL || '';
const cdnToken = process.env.CDN_TOKEN || '';
const cdnSignedUrls = process.env.CDN_SIGNED_URLS === 'true';
const cdnSignedUrlsSecret = process.env.CDN_SIGNED_URLS_SECRET || '';
const cdnRegion = process.env.CDN_REGION || 'auto';

cdnManager.initCdn({
  enabled: cdnEnabled,
  provider: cdnProvider,
  baseUrl: cdnBaseUrl,
  token: cdnToken,
  region: cdnRegion,
  pathPrefix: basePath.replace(/^\//, ''),
  signedUrls: cdnSignedUrls,
  signedUrlsSecret: cdnSignedUrlsSecret
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

let sseClients = new Set();

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
const thumbnailDir = path.join(publicDir, 'thumbnails');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
if (!fs.existsSync(thumbnailDir)) {
  fs.mkdirSync(thumbnailDir, { recursive: true });
}

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

function isApiOrMediaRequest(req) {
  return req.path.startsWith(basePath + '/api/')
    || req.path.startsWith(basePath + '/previews/')
    || req.path.startsWith(basePath + '/thumbnails/');
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
  return html.replace('<base href="/">', `<base href="${escapeHtml(baseHref)}">`);
}

async function loadTemplate(req, name) {
  const key = `${name}Template`;
  if (!req.app.locals[key]) {
    req.app.locals[key] = await fs.promises.readFile(path.join(publicDir, name), 'utf8');
  }
  return applyBasePath(req.app.locals[key]);
}

const privateStaticOptions = {
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', `${ENABLE_AUTH ? 'private' : 'public'}, max-age=86400`);
  }
};

// Login and immutable assets required to boot a scoped shared player.
app.get(basePath + '/login.html', async (req, res) => {
  try {
    return res.send(await loadTemplate(req, 'login.html'));
  } catch (error) {
    console.error('Error serving login page:', error);
    return res.status(500).send('Internal Server Error');
  }
});
app.get(basePath + '/css/style.css', (_req, res) => {
  res.sendFile(path.join(publicDir, 'css', 'style.css'));
});
app.get(basePath + '/js/utils.js', (_req, res) => {
  res.sendFile(path.join(publicDir, 'js', 'utils.js'));
});
app.get(basePath + '/js/player.js', (_req, res) => {
  res.sendFile(path.join(publicDir, 'js', 'player.js'));
});
app.get(basePath + '/favicon.ico', (_req, res) => {
  res.sendFile(path.join(publicDir, 'favicon.ico'));
});

app.post(basePath + '/login', (req, res) => {
  if (!SESSION_KEY || !SESSION_SECRET) {
    return res.status(500).send('Server configuration error: authentication secrets are required.');
  }

  if (typeof req.body.sessionKey === 'string' && req.body.sessionKey === SESSION_KEY) {
    res.cookie(
      AUTH_COOKIE_NAME,
      issueSessionToken(SESSION_SECRET),
      AUTH_COOKIE_OPTIONS
    );
    return res.redirect(basePath + '/');
  }

  return res.redirect(basePath + '/login.html?error=1');
});

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
  return res.redirect(303, `${basePath}/watch/${share.videoId}`);
});

app.get(basePath + '/api/config', (_req, res) => {
  res.json({ vodsName });
});

// Everything below this point is private when authentication is enabled.
app.use(checkAuth);

app.use(basePath + '/previews', express.static(
  process.env.PREVIEWS_CACHE_DIR || path.join(publicDir, 'previews'),
  privateStaticOptions
));
app.use(basePath + '/thumbnails', express.static(
  process.env.THUMBNAIL_CACHE_DIR || path.join(publicDir, 'thumbnails'),
  privateStaticOptions
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

  const client = {
    id: Date.now() + Math.random(),
    res,
    heartbeatInterval: null
  };
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

const publicApiRoutes = require('./routes/public-api');
app.use(basePath + '/api', publicApiRoutes);

app.get(basePath + '/watch/:id', async (req, res) => {
  const videoId = req.params.id;
  const db = req.app.locals.db;

  try {
    const video = await getVideoById(db, videoId);
    if (!video) {
      return res.status(404).send('Video not found');
    }

    let playerHtml = await loadTemplate(req, 'player.html');
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

    playerHtml = playerHtml.replace('</head>', `${ogTags}\n</head>`);
    playerHtml = playerHtml.replace('<title>Loading...</title>', `<title>${title}</title>`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.send(playerHtml);
  } catch (error) {
    console.error(`Error serving video ${videoId}:`, error);
    return res.status(500).send('Internal Server Error');
  }
});

app.get(basePath + '/api/videos/:id/stream', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const stat = await fs.promises.stat(video.path);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Cache-Control', `${ENABLE_AUTH ? 'private' : 'public'}, max-age=3600`);
    res.setHeader('ETag', `"${video.id}-${stat.mtime.getTime()}"`);

    if (!ENABLE_AUTH && cdnManager.shouldUseCdn(req.originalUrl, 'video')) {
      const protocol = req.protocol;
      const host = req.get('host');
      const originalUrl = `${protocol}://${host}${req.originalUrl}`;
      const cdnUrl = cdnManager.getCdnUrl(originalUrl, 'video');
      return res.redirect(cdnUrl);
    }

    videoCache.recordAccess(video.id, { namespace: 'stream' });

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(parts[0], 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= fileSize) {
        return res.status(416).json({ error: 'Invalid range request' });
      }

      const segmentNumber = Math.floor(start / FIXED_STREAM_SEGMENT_SIZE);
      const segmentStart = segmentNumber * FIXED_STREAM_SEGMENT_SIZE;
      const segmentEnd = Math.min(segmentStart + FIXED_STREAM_SEGMENT_SIZE - 1, fileSize - 1);
      const isCanonicalSegment = start === segmentStart && end === segmentEnd;

      const cacheOptions = {
        namespace: 'stream',
        quality: 'fixed_2mb',
        startByte: segmentStart,
        endByte: segmentEnd
      };

      const cachedSegment = videoCache.getCachedSegment(video.id, segmentNumber, cacheOptions);
      const isSingleSegmentRange = start >= segmentStart && end <= segmentEnd;

      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4'
      });

      let responseChunk = null;
      if (cachedSegment && isSingleSegmentRange) {
        responseChunk = isCanonicalSegment
          ? cachedSegment
          : sliceCanonicalSegmentForRange(cachedSegment, segmentStart, start, end);
      }

      if (responseChunk && responseChunk.length === chunkSize) {
        res.end(responseChunk);
        return;
      }

      fs.createReadStream(video.path, { start, end }).pipe(res);

      if (isCanonicalSegment) {
        videoCache.cacheSegmentFromFile(
          video.id,
          segmentNumber,
          video.path,
          segmentStart,
          segmentEnd,
          {
            namespace: 'stream',
            quality: 'fixed_2mb'
          }
        ).catch((cacheError) => {
          console.error('Error caching stream segment:', cacheError);
        });
      }

      return;
    }

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    });

    fs.createReadStream(video.path).pipe(res);

    const firstSegmentEnd = Math.min(FIXED_STREAM_SEGMENT_SIZE - 1, fileSize - 1);
    videoCache.cacheSegmentFromFile(
      video.id,
      0,
      video.path,
      0,
      firstSegmentEnd,
      {
        namespace: 'stream',
        quality: 'fixed_2mb'
      }
    ).catch((cacheError) => {
      console.error('Error caching first stream segment:', cacheError);
    });

    return;
  } catch (error) {
    console.error(`Error streaming video ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to stream video' });
  }
});

app.get(basePath + '/', async (req, res) => {
  try {
    return res.send(await loadTemplate(req, 'index.html'));
  } catch (error) {
    console.error('Error serving index page:', error);
    return res.status(500).send('Internal Server Error');
  }
});

app.use(basePath, express.static(publicDir));

const apiRoutes = require('./routes/api');
app.use(basePath + '/api', apiRoutes);

function getLibraryPaths() {
  const raw = process.env.VIDEO_LIBRARY;
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((libraryPath) => libraryPath.trim())
    .filter(Boolean);
}

function createWatcherQueue({ concurrency = 2, debounceMs = 500 } = {}) {
  const queue = [];
  const pendingTimers = new Map();
  let active = 0;

  const runNext = () => {
    while (active < concurrency && queue.length > 0) {
      const task = queue.shift();
      active += 1;

      Promise.resolve()
        .then(task)
        .catch((error) => {
          console.error('Watcher task failed:', error);
        })
        .finally(() => {
          active -= 1;
          runNext();
        });
    }
  };

  const schedule = (key, task) => {
    const existing = pendingTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      pendingTimers.delete(key);
      queue.push(task);
      runNext();
    }, debounceMs);

    pendingTimers.set(key, timer);
  };

  const shutdown = () => {
    for (const timer of pendingTimers.values()) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    queue.length = 0;
  };

  return {
    schedule,
    shutdown,
    getDepth: () => queue.length + pendingTimers.size,
    getActive: () => active
  };
}

function setupLibraryWatcher(db) {
  const libraryPaths = getLibraryPaths();
  if (libraryPaths.length === 0) {
    console.warn('VIDEO_LIBRARY environment variable not set or empty. File watcher not started.');
    return null;
  }

  const watcherConcurrency = parseInt(process.env.WATCHER_CONCURRENCY || '2', 10);
  const watcherDebounceMs = parseInt(process.env.WATCHER_DEBOUNCE_MS || '500', 10);
  const watcherQueue = createWatcherQueue({
    concurrency: Math.max(1, watcherConcurrency),
    debounceMs: Math.max(0, watcherDebounceMs)
  });

  const watcher = chokidar.watch(libraryPaths, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher
    .on('add', (filePath) => {
      if (!isVideoFile(filePath)) {
        return;
      }

      watcherQueue.schedule(filePath, async () => {
        await processVideoFile(db, filePath);
        const newVideo = await getVideoByPath(db, filePath);
        if (newVideo) {
          sendSseUpdate({ type: 'add', video: toVideoCard(newVideo) });
        }
      });
    })
    .on('unlink', (filePath) => {
      if (!isVideoFile(filePath)) {
        return;
      }

      watcherQueue.schedule(filePath, async () => {
        const videoToRemove = await getVideoByPath(db, filePath);
        if (!videoToRemove) {
          return;
        }

        await deleteVideo(db, videoToRemove.id);
        sendSseUpdate({ type: 'delete', videoId: videoToRemove.id });
      });
    })
    .on('error', (error) => {
      console.error(`Watcher error: ${error}`);
    });

  console.log(`File watcher is running for: ${libraryPaths.join(', ')}`);

  return {
    watcher,
    queue: watcherQueue
  };
}

async function startServer() {
  if (ENABLE_AUTH && (!SESSION_KEY || !SESSION_SECRET)) {
    throw new Error('SESSION_KEY and SESSION_SECRET are required when authentication is enabled.');
  }
  try {
    const db = await initializeDatabase();

    app.locals.db = db;
    app.locals.sseClients = sseClients;
    app.locals.sendSseUpdate = sendSseUpdate;
    app.locals.playerTemplate = null;
    app.locals['index.htmlTemplate'] = null;
    app.locals['login.htmlTemplate'] = null;
    app.locals['player.htmlTemplate'] = null;

    const watcherState = setupLibraryWatcher(db);
    app.locals.watcherState = watcherState;

    const server = app.listen({ port, host: publicIp }, () => {
      console.log('Video server running at:');
      console.log(`- Local: http://localhost:${port}${basePath}`);
      console.log(`- Public: http://${publicIp}:${port}${basePath}`);

      if (cdnEnabled) {
        console.log(`- CDN enabled with provider: ${cdnProvider}`);
        if (cdnBaseUrl) {
          console.log(`- CDN base URL: ${cdnBaseUrl}`);
        }
      }

      // Non-blocking startup scan.
      scanLibrary(db).catch((scanError) => {
        console.error('Background startup scan failed:', scanError);
      });
    });

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
  startServer,
  checkAuth,
  createWatcherQueue,
  getLibraryPaths,
  sendSseUpdate,
  sliceCanonicalSegmentForRange
};
