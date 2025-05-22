// Express server with API endpoints for the video sharing/viewing software
require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser'); // Added cookie-parser
const app = express();
const { initializeDatabase, getVideoByPath, deleteVideo } = require('./db/database'); // Added getVideoByPath, deleteVideo
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
const vodsName = process.env.VODS_NAME || 'Johan';
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
const AUTH_COOKIE_NAME = 'auth_token';
const AUTH_COOKIE_VALUE = 'valid-session'; // Simple token value
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true, // Prevent client-side JS access
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  // secure: process.env.NODE_ENV === 'production', // Use only with HTTPS
  path: basePath || '/', // Ensure cookie path matches base path
};

// Middleware to check authentication
function checkAuth(req, res, next) {
  // Skip auth if SESSION_KEY is not set
  if (!SESSION_KEY) {
    return next();
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


// Apply authentication middleware (protects routes below this)
app.use(checkAuth);

// Serve the rest of the public directory (now protected)
app.use(basePath, express.static(path.join(__dirname, 'public')));

// Serve main index page (protected)
app.get(basePath + '/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve player page (protected)
app.get(basePath + '/watch/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// API routes (protected by checkAuth middleware applied above)
const apiRoutes = require('./routes/api');
app.use(basePath + '/api', apiRoutes);

// --- End Routes & Middleware Order ---

app.get(basePath + '/api/config', (req, res) => {
  res.json({
    vodsName: vodsName,
    cdnEnabled: cdnEnabled
  });
});

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
