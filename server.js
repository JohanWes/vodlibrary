// Express server with API endpoints for the video sharing/viewing software
require('dotenv').config();
console.log('SHARE_BASE_URL from .env:', process.env.SHARE_BASE_URL);

const express = require('express');
const cookieParser = require('cookie-parser'); // Added cookie-parser
const app = express();
const { initializeDatabase, getVideoByPath, deleteVideo, getVideoById } = require('./db/database'); // Added getVideoByPath, deleteVideo, getVideoById
const { scanLibrary, processVideoFile, isVideoFile } = require('./lib/scanner'); // Added processVideoFile, isVideoFile
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar'); // Added chokidar
const videoCache = require('./lib/cache');
const cdnManager = require('./lib/cdn');

// Get port and IP from environment variables with fallbacks
const port = process.env.PORT || 8005;
const publicIp = process.env.HOST_IP || 'localhost';
const basePath = process.env.BASE_PATH || '';
const vodsName = process.env.VODS_NAME || 'VODlibrary';
console.log(`Using base path: "${basePath}", VODs name: "${vodsName}"`);

// Initialize server-side caching
const cacheMaxSize = parseInt(process.env.CACHE_MAX_SIZE || '500', 10) * 1024 * 1024; // Convert MB to bytes
const cacheTtl = parseInt(process.env.CACHE_TTL || '3600', 10);
const cachePopularityThreshold = parseInt(process.env.CACHE_POPULARITY_THRESHOLD || '0', 10);
const cacheMaxSegmentsPerVideo = parseInt(process.env.CACHE_MAX_SEGMENTS_PER_VIDEO || '3', 10);

videoCache.updateConfig({
  maxCacheSize: cacheMaxSize,
  stdTTL: cacheTtl,
  popularityThreshold: cachePopularityThreshold,
  maxSegmentsPerVideo: cacheMaxSegmentsPerVideo
});

console.log(`Server-side cache initialized with max size: ${cacheMaxSize / (1024 * 1024)}MB`);

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
  pathPrefix: basePath.replace(/^\//, ''), // Remove leading slash if present
  signedUrls: cdnSignedUrls,
  signedUrlsSecret: cdnSignedUrlsSecret
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added for parsing form data
app.use(cookieParser()); // Use cookie-parser middleware

// --- SSE Setup ---
let sseClients = new Set();

function sendSseUpdate(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.res.write(message));
  console.log(`Sent SSE update (${data.type}) to ${sseClients.size} clients.`);
}
// --- End SSE Setup ---

const thumbnailDir = path.join(__dirname, 'public', 'thumbnails');
if (!fs.existsSync(path.join(__dirname, 'public'))) {
  fs.mkdirSync(path.join(__dirname, 'public'));
}
if (!fs.existsSync(thumbnailDir)) {
  fs.mkdirSync(thumbnailDir);
}

// --- Authentication Setup ---
const SESSION_KEY = process.env.SESSION_KEY;
const ENABLE_AUTH = process.env.ENABLE_AUTH === 'true'; // New: Master switch for authentication
const AUTH_COOKIE_NAME = 'auth_token';
const AUTH_COOKIE_VALUE = 'valid-session'; // Simple token value
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true, // Prevent client-side JS access
  maxAge: 7 * 24 * 60 * 60 * 10000, // 70 days
  // secure: process.env.NODE_ENV === 'production', // Use only with HTTPS
  path: basePath || '/', // Ensure cookie path matches base path
};

// Middleware to check authentication
function checkAuth(req, res, next) {
  // If authentication is explicitly disabled, allow all access
  if (!ENABLE_AUTH) {
    // console.log('Authentication is disabled. Allowing access.'); // Removed excessive log
    return next();
  }

  // If authentication is enabled but SESSION_KEY is not set, prevent access
  if (!SESSION_KEY) {
    console.error('Authentication is enabled but SESSION_KEY is not set. Please set SESSION_KEY or disable authentication (ENABLE_AUTH=false).');
    // Render a simple error page or redirect to a configuration error page
    return res.status(500).send('Server configuration error: SESSION_KEY is required when authentication is enabled.');
  }

  // Allow access to login page, login POST, CSS, and favicon without auth
  const allowedPaths = [
    basePath + '/login.html',
    basePath + '/login',
    basePath + '/css/style.css',
    basePath + '/favicon.ico'
  ];
  if (allowedPaths.includes(req.path) || (req.path === basePath + '/login' && req.method === 'POST')) {
    return next();
  }

  // Check for the authentication cookie
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME] === AUTH_COOKIE_VALUE) {
    return next(); // User is authenticated
  }

  // User is not authenticated, redirect to login
  console.log(`Auth failed for ${req.path}, redirecting to login.`);
  res.redirect(basePath + '/login.html');
}
// --- End Authentication Setup ---


// Define cache duration (1 day in milliseconds)
const staticCacheDuration = 86400 * 1000; // 86400 seconds * 1000 ms/sec

// Serve previews with caching headers
app.use(basePath + '/previews', express.static(path.join(__dirname, 'public', 'previews'), {
  maxAge: staticCacheDuration
}));

// Serve thumbnails with caching headers
app.use(basePath + '/thumbnails', express.static(path.join(__dirname, 'public', 'thumbnails'), {
  maxAge: staticCacheDuration
}));

// --- Routes & Middleware Order ---

// Serve login page explicitly (before auth middleware)
app.get(basePath + '/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve CSS explicitly (needed for login page, before auth middleware)
app.get(basePath + '/css/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'css', 'style.css'));
});

// Serve favicon explicitly (before auth middleware)
app.get(basePath + '/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// Handle login form submission (before auth middleware)
app.post(basePath + '/login', (req, res) => {
  if (!SESSION_KEY) {
    console.log('Login attempt skipped: SESSION_KEY not set.');
    return res.redirect(basePath + '/'); // Redirect to main page if auth disabled
  }

  const submittedKey = req.body.sessionKey;
  if (submittedKey === SESSION_KEY) {
    console.log('Login successful, setting auth cookie.');
    res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, AUTH_COOKIE_OPTIONS);
    res.redirect(basePath + '/'); // Redirect to the main index page
  } else {
    console.log('Login failed: Invalid key submitted.');
    res.redirect(basePath + '/login.html?error=1'); // Redirect back to login with error
  }
});

// Handle URL-based session key (before auth middleware)
app.get(basePath + '/:sessionKeyParam/*', (req, res, next) => {
  if (!SESSION_KEY) {
    return next(); // No session key configured, skip
  }

  const sessionKeyParam = req.params.sessionKeyParam;
  if (sessionKeyParam === SESSION_KEY) {
    console.log('URL session key valid, setting auth cookie and redirecting.');
    res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, AUTH_COOKIE_OPTIONS);

    // Reconstruct the URL without the session key parameter
    // req.originalUrl includes query parameters
    const originalUrl = req.originalUrl;
    const newPath = originalUrl.replace(`/${sessionKeyParam}`, '');
    
    // Ensure the newPath starts with basePath if it was originally present
    const redirectUrl = newPath.startsWith(basePath) ? newPath : basePath + newPath;

    return res.redirect(redirectUrl);
  }
  next(); // Session key in URL is invalid or not present, proceed to next middleware (checkAuth)
});

// --- Server-Sent Events Endpoint (Moved Before Auth) ---
app.get(basePath + '/api/updates', (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n'); // Initial newline to establish connection

  // Generate a unique ID for this client
  const clientId = Date.now();
  const newClient = {
    id: clientId,
    res: res, // Store the response object to send events
  };

  // Add the new client to the set managed via app.locals
  const sseClients = req.app.locals.sseClients; // Access clients via app.locals
  if (!sseClients) {
      console.error("sseClients not found in app.locals. SSE will not work.");
      return res.end(); // End response if setup failed
  }
  sseClients.add(newClient);
  console.log(`SSE client connected: ${clientId}. Total clients: ${sseClients.size}`);

  // Send a simple connected message (optional)
  // res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    sseClients.delete(newClient);
    console.log(`SSE client disconnected: ${clientId}. Total clients: ${sseClients.size}`);
    res.end(); // Ensure response is ended
  });

  // Keep connection open, further messages are sent via sendSseUpdate
});
// --- End SSE Endpoint ---


// Serve player page (protected) - Moved before checkAuth
app.get(basePath + '/watch/:id', async (req, res) => {
  const videoId = req.params.id;
  const db = req.app.locals.db; // Access the database instance from app.locals

  try {
    const video = await getVideoById(db, videoId);

    if (!video) {
      return res.status(404).send('Video not found');
    }

    // Read the player.html file
    let playerHtml = fs.readFileSync(path.join(__dirname, 'public', 'player.html'), 'utf8');

    // Construct Open Graph meta tags
    const ogTitle = video.title;
    const ogType = 'video.movie'; // Or video.episode, video.tv_show, video.other
    let ogImage = `${req.protocol}://${req.get('host')}${basePath}${video.thumbnail_path}`; // Ensure absolute URL for og:image, including basePath
    // If CDN is enabled, use the CDN URL
    if (cdnEnabled) {
      ogImage = cdnManager.getCdnUrl(video.thumbnail_path, 'thumbnail'); // cdnManager should handle basePath internally if needed
    }
    const ogUrl = `${req.protocol}://${req.get('host')}${basePath}/watch/${videoId}`; // Canonical URL
    const videoStreamUrl = `${req.protocol}://${req.get('host')}${basePath}/api/video/${videoId}`; // Direct video stream URL

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

    // Inject meta tags into the <head> section
    playerHtml = playerHtml.replace('</head>', `${ogTags}\n</head>`);

    // Update the title dynamically as well
    playerHtml = playerHtml.replace('<title>Loading...</title>', `<title>${ogTitle}</title>`);

    res.send(playerHtml);

  } catch (error) {
    console.error(`Error serving video ${videoId}:`, error);
    res.status(500).send('Internal Server Error');
  }
});

// Video stream route - Moved before checkAuth
app.get(basePath + '/api/videos/:id/stream', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const videoPath = video.path;
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    const cacheMaxAge = 3600; // 1 hour in seconds
    res.setHeader('Cache-Control', `public, max-age=${cacheMaxAge}`);
    res.setHeader('ETag', `"${video.id}-${stat.mtime.getTime()}"`);
    
    if (cdnManager.shouldUseCdn(req.originalUrl, 'video')) {
      const protocol = req.protocol;
      const host = req.get('host');
      const originalUrl = `${protocol}://${host}${req.originalUrl}`;
      const cdnUrl = cdnManager.getCdnUrl(originalUrl, 'video');
      
      return res.redirect(cdnUrl);
    }
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      const cachedSegment = videoCache.getCachedSegment(video.id, Math.floor(start / (2 * 1024 * 1024)));
      
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      
      res.writeHead(206, head);
      
      if (cachedSegment) {
        console.log(`Serving segment from cache for video ${video.id}`);
        
        if (cachedSegment.length === chunksize) {
          res.end(cachedSegment);
        } else {
          const bufferStream = require('stream').Readable.from(cachedSegment);
          bufferStream.pipe(res);
        }
      } else {
        const file = fs.createReadStream(videoPath, { start, end });
        file.pipe(res);
        
        // Only cache if it's a standard segment size or the first segment
        if (start % (2 * 1024 * 1024) === 0 || start === 0) {
          const segmentNumber = Math.floor(start / (2 * 1024 * 1024));
          videoCache.cacheSegmentFromFile(
            video.id, 
            segmentNumber, 
            videoPath, 
            start, 
            Math.min(start + (2 * 1024 * 1024) - 1, fileSize - 1)
          ).catch(err => console.error('Error caching segment:', err));
        }
      }
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      
      res.writeHead(200, head);
      
      fs.createReadStream(videoPath).pipe(res);
      
      videoCache.cacheSegmentFromFile(
        video.id, 
        0, 
        videoPath, 
        0, 
        Math.min(2 * 1024 * 1024 - 1, fileSize - 1)
      ).catch(err => console.error('Error caching first segment:', err));
    }
  } catch (error) {
    console.error(`Error streaming video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to stream video' });
  }
});

// Serve previews with caching headers (Moved before checkAuth)
app.use(basePath + '/previews', express.static(path.join(__dirname, 'public', 'previews'), {
  maxAge: staticCacheDuration
}));

// Serve thumbnails with caching headers (Moved before checkAuth)
app.use(basePath + '/thumbnails', express.static(path.join(__dirname, 'public', 'thumbnails'), {
  maxAge: staticCacheDuration
}));

// Serve API config (Moved before checkAuth)
app.get(basePath + '/api/config', (req, res) => {
  res.json({
    vodsName: process.env.VODS_NAME || 'VODlibrary' // Provide VODS_NAME from env
  });
});

// Apply authentication middleware (protects routes below this)
app.use(checkAuth);

// Serve main index page (protected)
app.get(basePath + '/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the rest of the public directory (Moved after checkAuth)
app.use(basePath, express.static(path.join(__dirname, 'public')));

// API routes (protected by checkAuth middleware applied above)
const apiRoutes = require('./routes/api');
app.use(basePath + '/api', apiRoutes);

// --- End Routes & Middleware Order ---

async function startServer() {
  try {
    const db = await initializeDatabase();

    // Make db and SSE functions available to routes
    app.locals.db = db;
    app.locals.sseClients = sseClients; // Make clients available
    app.locals.sendSseUpdate = sendSseUpdate; // Make send function available

    console.log('Performing initial library scan...');
    await scanLibrary(db); // Initial scan on startup

    // --- Chokidar File Watcher Setup ---
    const libraryPaths = process.env.VIDEO_LIBRARY.split(',').map(p => p.trim());
    if (libraryPaths.length > 0 && libraryPaths[0]) { // Check if paths are defined
      console.log(`Initializing file watcher for: ${libraryPaths.join(', ')}`);
      const watcher = chokidar.watch(libraryPaths, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        ignoreInitial: true, // Don't trigger 'add' events for existing files on startup
        awaitWriteFinish: { // Helps avoid triggering events before file is fully written
          stabilityThreshold: 2000,
          pollInterval: 100
        }
      });

      watcher
        .on('add', async filePath => {
          console.log(`Watcher: File added - ${filePath}`);
          if (isVideoFile(filePath)) {
            try {
              // Process the new video (adds to DB, generates thumbnail)
              await processVideoFile(db, filePath);
              // Fetch the newly added video data to send to clients
              const newVideo = await getVideoByPath(db, filePath);
              if (newVideo) {
                sendSseUpdate({ type: 'add', video: newVideo });
              } else {
                 console.error(`Watcher: Could not retrieve new video data after adding: ${filePath}`);
              }
            } catch (error) {
              console.error(`Watcher: Error processing added file ${filePath}:`, error);
            }
          }
        })
        .on('unlink', async filePath => {
          console.log(`Watcher: File removed - ${filePath}`);
          if (isVideoFile(filePath)) {
            try {
              // Find the video in the DB by its path
              const videoToRemove = await getVideoByPath(db, filePath);
              if (videoToRemove) {
                await deleteVideo(db, videoToRemove.id);
                console.log(`Watcher: Removed video from DB (ID: ${videoToRemove.id})`);
                sendSseUpdate({ type: 'delete', videoId: videoToRemove.id });
                // Optionally: Clean up thumbnails/previews if needed
                // const thumbPath = path.join(__dirname, 'public', videoToRemove.thumbnail_path);
                // if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
              } else {
                console.log(`Watcher: File removed, but not found in DB: ${filePath}`);
              }
            } catch (error) {
              console.error(`Watcher: Error processing removed file ${filePath}:`, error);
            }
          }
        })
        .on('error', error => console.error(`Watcher error: ${error}`));

      console.log('File watcher is running.');
    } else {
      console.warn('VIDEO_LIBRARY environment variable not set or empty. File watcher not started.');
    }
    // --- End Chokidar Setup ---

    app.listen(port, '0.0.0.0', () => {
      console.log(`Video server running at:`);
      console.log(`- Local: http://localhost:${port}${basePath}`);
      console.log(`- Public: http://${publicIp}:${port}${basePath}`);
      
      if (cdnEnabled) {
        console.log(`- CDN enabled with provider: ${cdnProvider}`);
        if (cdnBaseUrl) {
          console.log(`- CDN base URL: ${cdnBaseUrl}`);
        }
      }
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
