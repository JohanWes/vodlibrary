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

// SSE Endpoint is now handled directly in server.js before authentication middleware

module.exports = router;
