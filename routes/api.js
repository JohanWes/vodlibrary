const express = require('express');
const router = express.Router();
// Import scanLibrary and getScanStatus
const { scanLibrary, getScanStatus } = require('../lib/scanner');
// Import getVideosPaginated instead of getAllVideos
const { getVideosPaginated, getVideoById, getVideosWithMetadata, getVideosByIds } = require('../db/database');
const OpenRouterClient = require('../lib/llm');
const { toVideoCard, toVideoDetail } = require('../lib/client-video');
const { issueShareToken } = require('../lib/security-tokens');
const { parsePublicBaseUrl } = require('../lib/url-config');

// Canonical positive safe-integer string: no sign, no leading zeros, no decimals.
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 500;

/**
 * Parse a canonical positive safe-integer string. Returns null when the raw
 * value is not a string or not canonical (e.g. '0', '01', '-1', '1.5', '1e2').
 * @param {*} raw - Query or path parameter value
 * @returns {number|null} Parsed value, or null when invalid
 */
function parsePositiveIntParam(raw) {
  if (typeof raw !== 'string' || !POSITIVE_INT_RE.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

router.get('/videos', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const rawSearch = req.query.search;
    let searchQuery = null;
    if (rawSearch !== undefined) {
      if (typeof rawSearch !== 'string' || rawSearch.length > MAX_SEARCH_LENGTH) {
        return res.status(400).json({ error: 'Search must be a string of at most 500 characters' });
      }
      searchQuery = rawSearch === '' ? null : rawSearch;
    }

    let page = DEFAULT_PAGE;
    let limit = DEFAULT_LIMIT;
    if (req.query.page !== undefined) {
      page = parsePositiveIntParam(req.query.page);
      if (page === null) {
        return res.status(400).json({ error: 'Page must be a canonical positive integer' });
      }
    }
    if (req.query.limit !== undefined) {
      limit = parsePositiveIntParam(req.query.limit);
      if (limit === null || limit > MAX_LIMIT) {
        return res.status(400).json({ error: 'Limit must be a canonical positive integer of at most 100' });
      }
    }

    const sort = req.query.sort || 'date_added_desc'; // Default sort

    // Fetch paginated videos and total count
    const { videos, totalCount } = await getVideosPaginated(db, page, limit, searchQuery, sort); // Pass sort parameter

    // Return mapped cards and total count for pagination controls
    res.json({
      videos: videos.map(toVideoCard),
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
    const body = req.body || {};
    const { query, page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = body;

    if (typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required and must be a non-empty string' });
    }
    if (query.length > MAX_SEARCH_LENGTH) {
      return res.status(400).json({ error: 'Query must be at most 500 characters' });
    }
    if (!Number.isSafeInteger(page) || page <= 0) {
      return res.status(400).json({ error: 'Page must be a positive safe integer' });
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      return res.status(400).json({ error: 'Limit must be a positive safe integer of at most 100' });
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
        page: page,
        limit: limit,
        message: 'No videos with metadata available for advanced search'
      });
    }

    // Use LLM to search
    const matchedVideos = await llmClient.searchVideos(query, videosWithMetadata);

    // Treat model output as untrusted and preserve its stable result order.
    const matchedIds = [];
    const seenIds = new Set();
    for (const matchedVideo of matchedVideos) {
      const rawId = matchedVideo && matchedVideo.id;
      const id = Number.isSafeInteger(rawId) && rawId > 0
        ? rawId
        : parsePositiveIntParam(rawId);
      if (id !== null && !seenIds.has(id)) {
        seenIds.add(id);
        matchedIds.push(id);
      }
    }

    const totalCount = matchedIds.length;
    const startIndex = (page - 1) * limit;
    const pageIds = matchedIds.slice(startIndex, startIndex + limit);
    const pageRows = await getVideosByIds(db, pageIds);
    const rowsById = new Map(pageRows.map((video) => [String(video.id), video]));
    const paginatedVideos = pageIds
      .map((id) => rowsById.get(String(id)))
      .filter(Boolean)
      .map(toVideoCard);

    res.json({
      videos: paginatedVideos,
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
    const videoId = parsePositiveIntParam(req.params.id);
    if (videoId === null) {
      return res.status(400).json({ error: 'Invalid video id' });
    }

    const db = req.app.locals.db;
    const video = await getVideoById(db, videoId);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(toVideoDetail(video));
  } catch (error) {
    console.error(`Error fetching video ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

router.get('/share/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const videoId = parsePositiveIntParam(req.params.id);
    if (videoId === null) {
      return res.status(400).json({ error: 'Invalid video id' });
    }

    const db = req.app.locals.db;
    const video = await getVideoById(db, videoId);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Never build a share link from an unvalidated origin. A missing or
    // invalid SHARE_BASE_URL fails closed with a generic 500.
    const publicBase = parsePublicBaseUrl(process.env.SHARE_BASE_URL, process.env.BASE_PATH);
    if (publicBase === null) {
      return res.status(500).json({ error: 'Failed to generate share link' });
    }

    const authEnabled = process.env.ENABLE_AUTH === 'true';
    if (authEnabled) {
      const shareSecret = process.env.SHARE_TOKEN_SECRET;
      if (!shareSecret) {
        return res.status(503).json({ error: 'Sharing is not configured' });
      }

      // Scoped token bound to the numeric video id; the legacy master-secret
      // share links are gone.
      const token = issueShareToken(videoId, shareSecret);
      return res.json({ shareLink: `${publicBase}/s/${encodeURIComponent(token)}` });
    }

    return res.json({ shareLink: `${publicBase}/watch/${video.id}` });
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
