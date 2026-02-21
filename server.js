// Express server with API endpoints for the video sharing/viewing software
require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
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
const basePath = process.env.BASE_PATH || '';
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
const ENABLE_AUTH = process.env.ENABLE_AUTH === 'true';
const AUTH_COOKIE_NAME = 'auth_token';
const AUTH_COOKIE_VALUE = 'valid-session';
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: 7 * 24 * 60 * 60 * 10000,
  path: basePath || '/'
};

function checkAuth(req, res, next) {
  if (!ENABLE_AUTH) {
    return next();
  }

  if (!SESSION_KEY) {
    console.error('Authentication is enabled but SESSION_KEY is not set.');
    return res.status(500).send('Server configuration error: SESSION_KEY is required when authentication is enabled.');
  }

  const allowedPaths = [
    basePath + '/login.html',
    basePath + '/login',
    basePath + '/css/style.css',
    basePath + '/favicon.ico'
  ];

  if (allowedPaths.includes(req.path) || (req.path === basePath + '/login' && req.method === 'POST')) {
    return next();
  }

  if (req.cookies && req.cookies[AUTH_COOKIE_NAME] === AUTH_COOKIE_VALUE) {
    return next();
  }

  return res.redirect(basePath + '/login.html');
}

const staticCacheDuration = 86400 * 1000;

// Static public media. These are intentionally public for preview UX.
app.use(basePath + '/previews', express.static(path.join(publicDir, 'previews'), {
  maxAge: staticCacheDuration
}));
const configuredPreviewDir = process.env.PREVIEWS_CACHE_DIR;
if (configuredPreviewDir && path.resolve(configuredPreviewDir) !== path.resolve(path.join(publicDir, 'previews'))) {
  app.use(basePath + '/previews', express.static(configuredPreviewDir, {
    maxAge: staticCacheDuration
  }));
}
app.use(basePath + '/thumbnails', express.static(path.join(publicDir, 'thumbnails'), {
  maxAge: staticCacheDuration
}));
// Also serve from THUMBNAIL_CACHE_DIR if configured separately from public/thumbnails
const configuredThumbnailDir = process.env.THUMBNAIL_CACHE_DIR;
if (configuredThumbnailDir && path.resolve(configuredThumbnailDir) !== path.resolve(path.join(publicDir, 'thumbnails'))) {
  app.use(basePath + '/thumbnails', express.static(configuredThumbnailDir, {
    maxAge: staticCacheDuration
  }));
}

// Login/public assets
app.get(basePath + '/login.html', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get(basePath + '/css/style.css', (_req, res) => {
  res.sendFile(path.join(publicDir, 'css', 'style.css'));
});

app.get(basePath + '/favicon.ico', (_req, res) => {
  res.sendFile(path.join(publicDir, 'favicon.ico'));
});

app.post(basePath + '/login', (req, res) => {
  if (!SESSION_KEY) {
    return res.redirect(basePath + '/');
  }

  const submittedKey = req.body.sessionKey;
  if (submittedKey === SESSION_KEY) {
    res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, AUTH_COOKIE_OPTIONS);
    return res.redirect(basePath + '/');
  }

  return res.redirect(basePath + '/login.html?error=1');
});

app.get(basePath + '/:sessionKeyParam/*', (req, res, next) => {
  if (!SESSION_KEY) {
    return next();
  }

  const sessionKeyParam = req.params.sessionKeyParam;
  if (sessionKeyParam !== SESSION_KEY) {
    return next();
  }

  res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, AUTH_COOKIE_OPTIONS);
  const newPath = req.originalUrl.replace(`/${sessionKeyParam}`, '');
  const redirectUrl = newPath.startsWith(basePath) ? newPath : basePath + newPath;
  return res.redirect(redirectUrl);
});

// SSE endpoint is public by design (live library updates for grid view).
app.get(basePath + '/api/updates', (req, res) => {
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

  req.on('close', () => {
    removeSseClient(client);
    res.end();
  });
});

app.get(basePath + '/api/config', (_req, res) => {
  res.json({
    vodsName: process.env.VODS_NAME || 'VODlibrary'
  });
});

// Public preview APIs are explicitly mounted before auth.
const publicApiRoutes = require('./routes/public-api');
app.use(basePath + '/api', publicApiRoutes);

// Protected routes below this line.
app.use(checkAuth);

app.get(basePath + '/watch/:id', async (req, res) => {
  const videoId = req.params.id;
  const db = req.app.locals.db;

  try {
    const video = await getVideoById(db, videoId);
    if (!video) {
      return res.status(404).send('Video not found');
    }

    let playerHtml = req.app.locals.playerTemplate;
    if (!playerHtml) {
      playerHtml = await fs.promises.readFile(path.join(publicDir, 'player.html'), 'utf8');
      req.app.locals.playerTemplate = playerHtml;
    }

    const ogTitle = video.title;
    const ogType = 'video.movie';
    const thumbnailPath = video.thumbnail_path || '/favicon.ico';
    let ogImage = `${req.protocol}://${req.get('host')}${basePath}${thumbnailPath}`;
    if (cdnEnabled && video.thumbnail_path) {
      ogImage = cdnManager.getCdnUrl(video.thumbnail_path, 'thumbnail');
    }

    const ogUrl = `${req.protocol}://${req.get('host')}${basePath}/watch/${videoId}`;
    const videoStreamUrl = `${req.protocol}://${req.get('host')}${basePath}/api/videos/${videoId}/stream`;

    const ogTags = `
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:url" content="${ogUrl}" />
  <meta property="og:description" content="Watch ${ogTitle} on ${vodsName}" />
  <meta property="og:site_name" content="${vodsName}" />
  <meta property="og:video" content="${videoStreamUrl}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:secure_url" content="${videoStreamUrl}" />
  <meta property="og:video:width" content="${video.width || 1280}" />
  <meta property="og:video:height" content="${video.height || 720}" />
    `;

    playerHtml = playerHtml.replace('</head>', `${ogTags}\n</head>`);
    playerHtml = playerHtml.replace('<title>Loading...</title>', `<title>${ogTitle}</title>`);

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

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', `"${video.id}-${stat.mtime.getTime()}"`);

    if (cdnManager.shouldUseCdn(req.originalUrl, 'video')) {
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

app.get(basePath + '/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
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
          sendSseUpdate({ type: 'add', video: newVideo });
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
  try {
    const db = await initializeDatabase();

    app.locals.db = db;
    app.locals.sseClients = sseClients;
    app.locals.sendSseUpdate = sendSseUpdate;
    app.locals.playerTemplate = null;

    try {
      app.locals.playerTemplate = await fs.promises.readFile(path.join(publicDir, 'player.html'), 'utf8');
    } catch (templateError) {
      console.warn('Could not preload player template, using lazy load fallback.', templateError.message);
    }

    const watcherState = setupLibraryWatcher(db);
    app.locals.watcherState = watcherState;

    const server = app.listen(port, '0.0.0.0', () => {
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
