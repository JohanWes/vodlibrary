const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
// Import scanLibrary and getScanStatus
const { scanLibrary, getScanStatus } = require('../lib/scanner'); 
// Import getVideosPaginated instead of getAllVideos
const { getVideosPaginated, getVideoById } = require('../db/database'); 
const videoCache = require('../lib/cache');
const cdnManager = require('../lib/cdn');

// Helper function to format duration in seconds to MM:SS format
function formatDuration(seconds) {
  if (!seconds) return '00:00';
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

router.get('/videos', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const searchQuery = req.query.search || null;
    // Get page and limit from query params, with defaults
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20; // Reduced default limit for better scrolling performance
    const sort = req.query.sort || 'date_added_desc'; // Default sort

    // Fetch paginated videos and total count
    const { videos, totalCount } = await getVideosPaginated(db, page, limit, searchQuery, sort); // Pass sort parameter

    const formattedVideos = videos.map(video => {
      return {
        ...video,
        duration_formatted: formatDuration(video.duration)
      };
    });
    
    // Return videos and total count for pagination controls
    res.json({
      videos: formattedVideos,
      totalCount: totalCount,
      page: page,
      limit: limit
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

router.get('/videos/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    video.duration_formatted = formatDuration(video.duration);
    
    res.json(video);
  } catch (error) {
    console.error(`Error fetching video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

router.get('/share/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const sessionKey = process.env.SESSION_KEY;
    const shareBaseUrl = process.env.SHARE_BASE_URL;
    const shareLink = `${shareBaseUrl}/${sessionKey}/watch/${video.id}`;
    
    res.json({ shareLink });
  } catch (error) {
    console.error(`Error generating share link for video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to generate share link' });
  }
});



router.post('/refresh', (req, res) => { // Changed to POST as it initiates an action
  try {
    const db = req.app.locals.db;
    
    // Trigger scan asynchronously (don't await)
    scanLibrary(db).catch(err => {
      // Log error if scan fails unexpectedly after starting
      console.error('Background scan failed:', err); 
    }); 
    
    // Immediately respond that the scan has been initiated
    res.status(202).json({ message: 'Library scan initiated' }); 
  } catch (error) {
    // Catch synchronous errors during initiation
    console.error('Error initiating library scan:', error);
    res.status(500).json({ error: 'Failed to initiate library scan' });
  }
});

// New endpoint to get scan status
router.get('/scan/status', (req, res) => {
  try {
    const status = getScanStatus();
    res.json(status);
  } catch (error) {
    console.error('Error fetching scan status:', error);
    res.status(500).json({ error: 'Failed to fetch scan status' });
  }
});


router.get('/cache/stats', (req, res) => {
  try {
    const stats = videoCache.getCacheStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

router.post('/cache/clear', (req, res) => {
  try {
    videoCache.clearCache();
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

router.post('/cache/config', (req, res) => {
  try {
    const newConfig = req.body;
    videoCache.updateConfig(newConfig);
    res.json({ 
      message: 'Cache configuration updated successfully',
      config: videoCache.config
    });
  } catch (error) {
    console.error('Error updating cache config:', error);
    res.status(500).json({ error: 'Failed to update cache config' });
  }
});

router.get('/cdn/config', (req, res) => {
  try {
    const config = cdnManager.getConfig();
    res.json(config);
  } catch (error) {
    console.error('Error getting CDN config:', error);
    res.status(500).json({ error: 'Failed to get CDN config' });
  }
});

router.post('/cdn/config', (req, res) => {
  try {
    const newConfig = req.body;
    const updatedConfig = cdnManager.updateConfig(newConfig);
    res.json({
      message: 'CDN configuration updated successfully',
      config: updatedConfig
    });
  } catch (error) {
    console.error('Error updating CDN config:', error);
    res.status(500).json({ error: 'Failed to update CDN config' });
  }
});

// Preview API endpoints
router.get('/videos/:id/preview/:timestamp?', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const videoId = req.params.id;
    const timestamp = parseInt(req.params.timestamp || '10', 10);
    
    const video = await getVideoById(db, videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Parse preview clips JSON
    const previewClips = video.preview_clips ? JSON.parse(video.preview_clips) : null;
    
    if (!previewClips || !previewClips.clips) {
      // Fallback to range request from main video
      return serveVideoSegment(req, res, video, timestamp);
    }
    
    // Find matching preview clip
    const clip = previewClips.clips.find(c => c.timestamp === timestamp);
    if (!clip) {
      return res.status(404).json({ error: 'Preview clip not found' });
    }
    
    // Serve preview file with caching headers
    const previewPath = path.join(__dirname, '..', 'public', clip.path);
    
    if (!fs.existsSync(previewPath)) {
      return res.status(404).json({ error: 'Preview file not found' });
    }
    
    const stat = fs.statSync(previewPath);
    
    // CDN integration
    if (cdnManager.shouldUseCdn(req.originalUrl, 'preview')) {
      const cdnUrl = cdnManager.getCdnUrl(clip.path, 'preview');
      return res.redirect(cdnUrl);
    }
    
    // Set aggressive caching for preview clips
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = fs.createReadStream(previewPath);
    stream.pipe(res);
    
  } catch (error) {
    console.error(`Error serving preview for video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to serve preview' });
  }
});

// Preview metadata endpoint
router.get('/videos/:id/preview-info', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const previewInfo = {
      hasPreview: !!video.preview_clips,
      status: video.preview_generation_status || 'pending',
      clips: video.preview_clips ? JSON.parse(video.preview_clips).clips : []
    };
    
    res.json(previewInfo);
  } catch (error) {
    console.error(`Error getting preview info for video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to get preview info' });
  }
});

// Fallback video segment serving for when preview clips don't exist
async function serveVideoSegment(req, res, video, startTime) {
  try {
    const videoPath = video.path;
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    
    // Calculate approximate byte range for the requested time segment
    const bytesPerSecond = fileSize / video.duration;
    const startByte = Math.floor(startTime * bytesPerSecond);
    const endByte = Math.min(Math.floor((startTime + 3) * bytesPerSecond), fileSize - 1);
    const chunksize = (endByte - startByte) + 1;
    
    const head = {
      'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=3600'
    };
    
    res.writeHead(206, head);
    
    const file = fs.createReadStream(videoPath, { start: startByte, end: endByte });
    file.pipe(res);
    
  } catch (error) {
    console.error(`Error serving video segment fallback:`, error);
    res.status(500).json({ error: 'Failed to serve video segment' });
  }
}

// Video segments endpoint for preview functionality
router.get('/videos/:id/segments/:segmentNumber', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const videoId = req.params.id;
    const segmentNumber = parseInt(req.params.segmentNumber, 10);
    const quality = req.query.quality || 'medium';
    
    const video = await getVideoById(db, videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const videoPath = video.path;
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    
    // Calculate segment size based on quality
    let segmentSize;
    switch (quality) {
      case 'low':
        segmentSize = 512 * 1024; // 512KB for low quality
        break;
      case 'high':
        segmentSize = 2 * 1024 * 1024; // 2MB for high quality
        break;
      default:
        segmentSize = 1 * 1024 * 1024; // 1MB for medium quality
    }
    
    // Calculate byte range for the requested segment
    const startByte = segmentNumber * segmentSize;
    const endByte = Math.min(startByte + segmentSize - 1, fileSize - 1);
    
    if (startByte >= fileSize) {
      return res.status(416).json({ error: 'Requested segment beyond file size' });
    }
    
    const chunksize = (endByte - startByte) + 1;
    
    // Check CDN integration
    if (cdnManager.shouldUseCdn(req.originalUrl, 'video')) {
      const protocol = req.protocol;
      const host = req.get('host');
      const originalUrl = `${protocol}://${host}${req.originalUrl}`;
      const cdnUrl = cdnManager.getCdnUrl(originalUrl, 'video');
      return res.redirect(cdnUrl);
    }
    
    // Check cache for this segment
    const cachedSegment = videoCache.getCachedSegment(videoId, segmentNumber);
    
    // Set headers for partial content
    const headers = {
      'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=3600', // 1 hour cache
      'ETag': `"${videoId}-${segmentNumber}-${quality}"`
    };
    
    res.writeHead(206, headers);
    
    if (cachedSegment) {
      console.log(`Serving segment ${segmentNumber} from cache for video ${videoId}`);
      res.end(cachedSegment);
    } else {
      // Stream from file and cache if possible
      const file = fs.createReadStream(videoPath, { start: startByte, end: endByte });
      file.pipe(res);
      
      // Cache this segment for future requests
      videoCache.cacheSegmentFromFile(
        videoId,
        segmentNumber,
        videoPath,
        startByte,
        endByte
      ).catch(err => console.error(`Error caching segment ${segmentNumber} for video ${videoId}:`, err));
    }
    
  } catch (error) {
    console.error(`Error serving segment ${req.params.segmentNumber} for video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to serve video segment' });
  }
});

// SSE Endpoint is now handled directly in server.js before authentication middleware

module.exports = router;
