const express = require('express');
const path = require('path');
const fs = require('fs');
const { getVideoById } = require('../db/database');
const cdnManager = require('../lib/cdn');

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

function normalizePublicAssetPath(assetPath) {
  return String(assetPath || '').replace(/^\/+/, '');
}

function parseCanonicalSafeInteger(value, positive) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const pattern = positive ? /^[1-9]\d*$/ : /^(0|[1-9]\d*)$/;
  if (!pattern.test(value)) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    return null;
  }

  return numeric;
}

function isSafeClipPath(clipPath) {
  const segments = clipPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    return false;
  }

  const basename = segments[segments.length - 1];
  return basename !== '' && basename !== '.' && basename !== '..';
}

router.get('/videos/:id/preview-info', async (req, res) => {
  const videoId = parseCanonicalSafeInteger(req.params.id, true);
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
  const videoId = parseCanonicalSafeInteger(req.params.id, true);
  if (videoId === null) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  const timestamp = parseCanonicalSafeInteger(req.params.timestamp || '10', false);
  if (timestamp === null) {
    return res.status(400).json({ error: 'Invalid timestamp' });
  }

  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, videoId);

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

    const normalizedClipPath = normalizePublicAssetPath(clip.path);
    if (!isSafeClipPath(normalizedClipPath)) {
      return res.status(404).json({ error: 'Preview file not found' });
    }

    const previewsDir = process.env.PREVIEWS_CACHE_DIR || path.join(__dirname, '..', 'public', 'previews');
    const previewPath = path.join(previewsDir, path.basename(normalizedClipPath));

    try {
      await fs.promises.access(previewPath, fs.constants.R_OK);
    } catch (_error) {
      return res.status(404).json({ error: 'Preview file not found' });
    }

    const stat = await fs.promises.stat(previewPath);

    if (process.env.ENABLE_AUTH !== 'true' && cdnManager.shouldUseCdn(req.originalUrl, 'preview')) {
      const clipPathForCdn = clip.path.startsWith('/') ? clip.path : `/${clip.path}`;
      const cdnUrl = cdnManager.getCdnUrl(clipPathForCdn, 'preview');
      return res.redirect(cdnUrl);
    }

    res.setHeader('Cache-Control', `${process.env.ENABLE_AUTH === 'true' ? 'private' : 'public'}, max-age=86400`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    fs.createReadStream(previewPath).pipe(res);
  } catch (error) {
    console.error(`Error serving preview for video ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to serve preview' });
  }
});

module.exports = router;
