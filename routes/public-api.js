const express = require('express');
const fs = require('fs');
const path = require('path');
const { getVideoById, getVideoStreamInfo } = require('../db/database');
const cdnManager = require('../lib/cdn');
const { parseCanonicalInt } = require('../lib/parse');

// Media routes: preview clips and the full video stream. Mounted after
// checkAuth in server.js, so everything here requires a session (or a share
// cookie scoped to /api/videos/<id>/stream).
const router = express.Router();

function parsePreviewClips(rawPreviewClips) {
  if (!rawPreviewClips) {
    return null;
  }

  try {
    return JSON.parse(rawPreviewClips);
  } catch (_error) {
    return null;
  }
}

function mediaCacheControl(maxAgeSeconds) {
  return `${process.env.ENABLE_AUTH === 'true' ? 'private' : 'public'}, max-age=${maxAgeSeconds}`;
}

// Headers `send` sets before it can fail; none of them belong on an error.
const SUCCESS_ONLY_HEADERS = ['Cache-Control', 'ETag', 'Last-Modified', 'Content-Type', 'Content-Length', 'Content-Range'];
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);
const ABORTED_CODES = new Set(['ECONNABORTED', 'ECONNRESET']);

/**
 * Serve `basename` from `dir` with Range/HEAD/conditional-request support via
 * res.sendFile (`send`). `send` confines the file to `root` (rejecting `..`,
 * empty names and dotfiles), which is the only containment check needed for
 * a basename taken from the database; `dir` itself is trusted.
 */
async function sendMediaFile(req, res, dir, basename, { cacheControl, notFoundMessage, errorMessage }) {
  // `send` never opens the file for HEAD, so an unreadable file would answer
  // 200 there while GET fails with 500. Names `send` rejects anyway (empty,
  // dotfiles, `..`) and other errors (missing file, ...) are left to it.
  if (basename && !basename.startsWith('.')) {
    try {
      await fs.promises.access(path.join(dir, basename), fs.constants.R_OK);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        console.error(`Error serving ${req.originalUrl}:`, err);
        res.status(500).json({ error: errorMessage });
        return;
      }
    }
  }

  res.sendFile(basename, {
    root: dir,
    dotfiles: 'deny',
    acceptRanges: true,
    cacheControl: false,
    headers: { 'Cache-Control': cacheControl }
  }, (err) => {
    if (!err) {
      return;
    }
    if (res.headersSent || ABORTED_CODES.has(err.code)) {
      // The client went away (routine when seeking or closing the player), or
      // the read failed mid-body: nothing useful can be sent.
      if (!ABORTED_CODES.has(err.code)) {
        console.error(`Error streaming ${req.originalUrl}:`, err);
      }
      res.destroy();
      return;
    }

    const status = err.status || err.statusCode;
    for (const header of SUCCESS_ONLY_HEADERS) {
      res.removeHeader(header);
    }

    if (status === 416) {
      res.setHeader('Content-Range', (err.headers && err.headers['Content-Range']) || '');
      res.status(416).end();
      return;
    }
    if (status === 412) {
      res.status(412).end();
      return;
    }
    if (status === 404 || status === 403 || NOT_FOUND_CODES.has(err.code)) {
      res.status(404).json({ error: notFoundMessage });
      return;
    }

    console.error(`Error serving ${req.originalUrl}:`, err);
    res.status(500).json({ error: errorMessage });
  });
}

router.get('/videos/:id/preview-info', async (req, res) => {
  const videoId = parseCanonicalInt(req.params.id);
  if (videoId === null) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, videoId);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const previewClips = parsePreviewClips(video.preview_clips);
    return res.json({
      hasPreview: !!(previewClips && Array.isArray(previewClips.clips) && previewClips.clips.length > 0),
      status: video.preview_generation_status || 'pending',
      clips: previewClips && Array.isArray(previewClips.clips) ? previewClips.clips : []
    });
  } catch (error) {
    console.error(`Error getting preview info for video ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to get preview info' });
  }
});

router.get('/videos/:id/preview/:timestamp?', async (req, res) => {
  const videoId = parseCanonicalInt(req.params.id);
  if (videoId === null) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  const timestamp = parseCanonicalInt(req.params.timestamp || '10', { allowZero: true });
  if (timestamp === null) {
    return res.status(400).json({ error: 'Invalid timestamp' });
  }

  let video;
  try {
    video = await getVideoById(req.app.locals.db, videoId);
  } catch (error) {
    console.error(`Error serving preview for video ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to serve preview' });
  }

  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const previewClips = parsePreviewClips(video.preview_clips);
  if (!previewClips || !Array.isArray(previewClips.clips)) {
    return res.status(404).json({ error: 'Preview clip not found' });
  }

  const clip = previewClips.clips.find((candidate) => Number(candidate.timestamp) === timestamp);
  if (!clip) {
    return res.status(404).json({ error: 'Preview clip not found' });
  }

  const previewsDir = process.env.PREVIEWS_CACHE_DIR || path.join(__dirname, '..', 'public', 'previews');
  return sendMediaFile(req, res, path.resolve(previewsDir), path.basename(String(clip.path || '')), {
    cacheControl: mediaCacheControl(86400),
    notFoundMessage: 'Preview file not found',
    errorMessage: 'Failed to serve preview'
  });
});

router.get('/videos/:id/stream', async (req, res) => {
  const videoId = parseCanonicalInt(req.params.id);
  if (videoId === null) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  let video;
  try {
    video = await getVideoStreamInfo(req.app.locals.db, videoId);
  } catch (error) {
    console.error(`Error streaming video ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to stream video' });
  }

  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  if (process.env.ENABLE_AUTH !== 'true' && cdnManager.shouldUseCdn(req.originalUrl, 'video')) {
    const cdnUrl = cdnManager.getCdnUrl(req.originalUrl, 'video');
    if (cdnUrl) {
      // Shorter than the signed-URL lifetime so a cached redirect never outlives its signature.
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.redirect(cdnUrl);
    }
  }

  const absolutePath = path.resolve(video.path);
  return sendMediaFile(req, res, path.dirname(absolutePath), path.basename(absolutePath), {
    cacheControl: mediaCacheControl(3600),
    notFoundMessage: 'Video file not found',
    errorMessage: 'Failed to stream video'
  });
});

module.exports = router;
