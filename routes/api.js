const express = require('express');
const { scanLibrary, getScanStatus } = require('../lib/scanner');
const { getVideosPaginated, getVideoById, getVideosWithMetadata, getVideosByIds } = require('../db/database');
const OpenRouterClient = require('../lib/llm');
const { toVideoCard, toVideoDetail } = require('../lib/client-video');
const { issueShareToken } = require('../lib/security-tokens');
const { parsePublicBaseUrl } = require('../lib/url-config');
const { parseCanonicalInt } = require('../lib/parse');

const router = express.Router();
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 500;

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
      page = parseCanonicalInt(req.query.page);
      if (page === null) {
        return res.status(400).json({ error: 'Page must be a canonical positive integer' });
      }
    }
    if (req.query.limit !== undefined) {
      limit = parseCanonicalInt(req.query.limit);
      if (limit === null || limit > MAX_LIMIT) {
        return res.status(400).json({ error: 'Limit must be a canonical positive integer of at most 100' });
      }
    }

    const sort = req.query.sort || 'recorded_desc';
    const { videos, totalCount } = await getVideosPaginated(db, page, limit, searchQuery, sort);
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

// Matched ids per normalized query, so paging through one search (infinite
// scroll) costs one LLM call. Bounded and short-lived: a rescan can change the
// library, and entries are evicted oldest-first. The in-flight promise is
// cached too, so concurrent page requests share one call. Failures and "no
// metadata yet" (null) are not kept.
const SEARCH_CACHE_MAX_ENTRIES = 50;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map();

function normalizeSearchQuery(query) {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Treat model output as untrusted: keep canonical positive ids, first
// occurrence only, in the model's result order.
function toMatchedIds(matchedVideos) {
  const matchedIds = [];
  const seenIds = new Set();
  for (const matchedVideo of matchedVideos) {
    const rawId = matchedVideo && matchedVideo.id;
    const id = Number.isSafeInteger(rawId) && rawId > 0
      ? rawId
      : parseCanonicalInt(rawId);
    if (id !== null && !seenIds.has(id)) {
      seenIds.add(id);
      matchedIds.push(id);
    }
  }
  return matchedIds;
}

function cachedSearch(query, search) {
  const key = normalizeSearchQuery(query);
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  searchCache.delete(key);
  for (const [staleKey, entry] of searchCache) {
    if (searchCache.size < SEARCH_CACHE_MAX_ENTRIES && entry.expiresAt > now) {
      break;
    }
    searchCache.delete(staleKey);
  }

  const entry = { result: null, expiresAt: now + SEARCH_CACHE_TTL_MS };
  const forget = () => {
    if (searchCache.get(key) === entry) {
      searchCache.delete(key);
    }
  };
  entry.result = search().then((result) => {
    if (result === null) {
      forget();
    }
    return result;
  }, (error) => {
    forget();
    throw error;
  });
  searchCache.set(key, entry);
  return entry.result;
}

// LLM search over sidecar metadata.
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

    if (process.env.ADVANCED_SEARCH_ENABLED !== 'true') {
      return res.status(400).json({ error: 'Advanced search is not enabled' });
    }

    const db = req.app.locals.db;
    const llmClient = new OpenRouterClient();
    if (!llmClient.isAvailable()) {
      return res.status(503).json({
        error: 'Advanced search temporarily unavailable - OpenRouter API key not configured'
      });
    }

    const matchedIds = await cachedSearch(query, async () => {
      const videosWithMetadata = await getVideosWithMetadata(db);
      if (videosWithMetadata.length === 0) {
        return null;
      }
      return toMatchedIds(await llmClient.searchVideos(query, videosWithMetadata));
    });

    if (matchedIds === null) {
      return res.json({
        videos: [],
        totalCount: 0,
        page: page,
        limit: limit,
        message: 'No videos with metadata available for advanced search'
      });
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
    const videoId = parseCanonicalInt(req.params.id);
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
    const videoId = parseCanonicalInt(req.params.id);
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

// Starts a scan in the background and answers immediately.
router.post('/refresh', (req, res) => {
  scanLibrary(req.app.locals.db).catch((error) => {
    console.error('Background scan failed:', error);
  });
  res.status(202).json({ message: 'Library scan initiated' });
});

router.get('/scan/status', (_req, res) => {
  res.json(getScanStatus());
});

router.clearSearchCache = () => searchCache.clear();

module.exports = router;
