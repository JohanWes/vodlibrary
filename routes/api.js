const express = require('express');
const router = express.Router();
// Import scanLibrary and getScanStatus
const { scanLibrary, getScanStatus } = require('../lib/scanner'); 
// Import getVideosPaginated instead of getAllVideos
const { getVideosPaginated, getVideoById, getVideosWithMetadata } = require('../db/database'); 
const OpenRouterClient = require('../lib/llm');

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

// Advanced search endpoint using LLM
router.post('/videos/advanced-search', async (req, res) => {
  try {
    const { query, page = 1, limit = 20 } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required and must be a string' });
    }
    
    // Check if advanced search is enabled
    const advancedSearchEnabled = process.env.ADVANCED_SEARCH_ENABLED === 'true';
    if (!advancedSearchEnabled) {
      return res.status(400).json({ error: 'Advanced search is not enabled' });
    }
    
    const db = req.app.locals.db;
    const llmClient = new OpenRouterClient();
    
    // Check if LLM is available
    if (!llmClient.isAvailable()) {
      return res.status(503).json({ 
        error: 'Advanced search temporarily unavailable - OpenRouter API key not configured' 
      });
    }
    
    // Get all videos with metadata
    const videosWithMetadata = await getVideosWithMetadata(db);
    
    if (videosWithMetadata.length === 0) {
      return res.json({
        videos: [],
        totalCount: 0,
        page: 1,
        limit: limit,
        message: 'No videos with metadata available for advanced search'
      });
    }
    
    // Use LLM to search
    const matchedVideos = await llmClient.searchVideos(query, videosWithMetadata);

    // Enrich LLM results with complete video data
    const enrichedVideos = [];
    for (const matchedVideo of matchedVideos) {
      try {
        // Fetch complete video record using existing getVideoById function
        const completeVideo = await getVideoById(db, matchedVideo.id);
        if (completeVideo) {
          // Merge LLM search reasoning with complete video data
          enrichedVideos.push({
            ...completeVideo,
            searchReason: matchedVideo.searchReason // Preserve LLM reasoning
          });
        }
      } catch (error) {
        console.warn(`Failed to enrich video ${matchedVideo.id}:`, error);
        // Fallback to partial data if enrichment fails
        enrichedVideos.push(matchedVideo);
      }
    }

    // Paginate enriched results
    const totalCount = enrichedVideos.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedVideos = enrichedVideos.slice(startIndex, endIndex);

    // Format videos similar to regular search
    const formattedVideos = paginatedVideos.map(video => {
      return {
        ...video,
        duration_formatted: formatDuration(video.duration)
      };
    });
    
    res.json({
      videos: formattedVideos,
      totalCount: totalCount,
      page: page,
      limit: limit,
      searchType: 'advanced',
      query: query
    });
    
  } catch (error) {
    console.error('Advanced search error:', error);
    
    // Check if it's an LLM-specific error and provide fallback
    if (error.message.includes('API') || error.message.includes('OpenRouter')) {
      res.status(503).json({ 
        error: 'Advanced search temporarily unavailable. Please try regular search.',
        fallback: true
      });
    } else {
      res.status(500).json({ error: 'Advanced search failed' });
    }
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

module.exports = router;
