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

async function serveVideoSegmentFallback(res, video, startTime) {
  const videoPath = video.path;
  const stat = await fs.promises.stat(videoPath);
  const fileSize = stat.size;

  const duration = Math.max(video.duration || 1, 1);
  const bytesPerSecond = fileSize / duration;
  const startByte = Math.max(0, Math.floor(startTime * bytesPerSecond));
  const endByte = Math.min(Math.floor((startTime + 3) * bytesPerSecond), fileSize - 1);

  const chunkSize = (endByte - startByte) + 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': 'video/mp4',
    'Cache-Control': 'public, max-age=3600'
  });

  fs.createReadStream(videoPath, { start: startByte, end: endByte }).pipe(res);
}

router.get('/videos/:id/preview-info', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const video = await getVideoById(db, req.params.id);

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
  try {
    const db = req.app.locals.db;
    const videoId = req.params.id;
    const timestamp = parseInt(req.params.timestamp || '10', 10);

    const video = await getVideoById(db, videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const previewClips = parsePreviewClips(video.preview_clips);

    if (!previewClips || !Array.isArray(previewClips.clips)) {
      await serveVideoSegmentFallback(res, video, timestamp);
      return;
    }

    const clip = previewClips.clips.find((candidate) => candidate.timestamp === timestamp);
    if (!clip) {
      return res.status(404).json({ error: 'Preview clip not found' });
    }

    const normalizedClipPath = normalizePublicAssetPath(clip.path);
    const publicPreviewPath = path.join(__dirname, '..', 'public', normalizedClipPath);
    const configuredPreviewDir = process.env.PREVIEWS_CACHE_DIR;
    const dataPreviewPath = configuredPreviewDir
      ? path.join(configuredPreviewDir, path.basename(normalizedClipPath))
      : null;

    let previewPath = publicPreviewPath;
    try {
      await fs.promises.access(publicPreviewPath, fs.constants.R_OK);
    } catch (_error) {
      if (dataPreviewPath) {
        try {
          await fs.promises.access(dataPreviewPath, fs.constants.R_OK);
          previewPath = dataPreviewPath;
        } catch (_error2) {
          return res.status(404).json({ error: 'Preview file not found' });
        }
      } else {
        return res.status(404).json({ error: 'Preview file not found' });
      }
    }

    const stat = await fs.promises.stat(previewPath);

    if (cdnManager.shouldUseCdn(req.originalUrl, 'preview')) {
      const clipPathForCdn = clip.path.startsWith('/') ? clip.path : `/${clip.path}`;
      const cdnUrl = cdnManager.getCdnUrl(clipPathForCdn, 'preview');
      return res.redirect(cdnUrl);
    }

    res.setHeader('Cache-Control', 'public, max-age=86400');
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
