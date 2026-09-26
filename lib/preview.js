const path = require('path');
const fs = require('fs');
const { generateVideoHash } = require('./thumbnail');
const { runFfmpeg, partialPathFor, removeQuietly, nonEmptyFileSize, killActiveProcesses } = require('./ffmpeg');
const { parsePositiveInt } = require('./parse');

// Hover-preview clips: one per video at <PREVIEWS_CACHE_DIR>/<md5(path)>_0s.mp4,
// encoded to a temp file and renamed into place only when non-empty, through a
// de-duplicated queue of at most PREVIEW_MAX_CONCURRENT jobs with a hard
// per-encode timeout.

const DEFAULT_TIMEOUT_SECONDS = 300;
const GENERATED_CLIP_NAME = /^[0-9a-f]{32}_\d+s\.mp4$/;

// Quality presets. `card` (default) is sized for the ~365 px library cards.
const qualityPresets = {
  card: { encoders: ['libx264'], width: 640, crf: 26, x264Preset: 'veryfast', maxrate: '700k', fpsMax: 30 },
  low: { encoders: ['libx264'], width: 480, crf: 32, x264Preset: 'ultrafast', maxrate: '200k', fpsMax: 30 },
  medium: { encoders: ['libsvtav1', 'libx264'], width: 720, crf: 28, svtPreset: 6 },
  high: { encoders: ['libsvtav1', 'libx264'], width: 1080, crf: 30, svtPreset: 8 },
  amd_av1: { encoders: ['av1_amf', 'libsvtav1', 'libx264'], width: 1080, crf: 30, svtPreset: 8, bitrate: '1600k' }
};
const DEFAULT_PRESET = 'card';

// Read from the environment on every call.
function getConfig() {
  const previewDuration = parsePositiveInt(process.env.PREVIEW_DURATION, 10);
  const quality = qualityPresets[process.env.PREVIEW_QUALITY] ? process.env.PREVIEW_QUALITY : DEFAULT_PRESET;
  return {
    previewDir: process.env.PREVIEWS_CACHE_DIR || path.join(__dirname, '..', 'public', 'previews'),
    previewDuration,
    previewQuality: quality,
    previewTimestamp: 0,
    maxConcurrentGenerations: parsePositiveInt(process.env.PREVIEW_MAX_CONCURRENT, 2),
    minVideoDuration: previewDuration + 1,
    timeoutMs: parsePositiveInt(process.env.PREVIEW_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS) * 1000
  };
}

function getPreviewFilename(videoPath, timestamp = 0) {
  return `${generateVideoHash(videoPath)}_${timestamp}s.mp4`;
}

function getPreviewPathForVideo(videoPath, config = getConfig()) {
  return path.join(config.previewDir, getPreviewFilename(videoPath, config.previewTimestamp));
}

/**
 * Clip files referenced by a `preview_clips` value, plus the default clip for
 * the video path. Only generated-clip basenames are accepted, so the result
 * never points outside the preview dir or at anything we did not create.
 */
function getPreviewFilePaths(videoPath, previewClipsJson, config = getConfig()) {
  const files = new Set([getPreviewPathForVideo(videoPath, config)]);
  let clips = [];
  try {
    clips = JSON.parse(previewClipsJson || 'null')?.clips || [];
  } catch (_error) {
    // malformed JSON: only the default clip
  }
  for (const clip of Array.isArray(clips) ? clips : []) {
    const base = typeof clip?.path === 'string' ? path.basename(clip.path) : '';
    if (GENERATED_CLIP_NAME.test(base)) {
      files.add(path.join(config.previewDir, base));
    }
  }
  return [...files];
}

function encoderArgs(encoder, preset) {
  switch (encoder) {
    case 'av1_amf':
      return ['-c:v', 'av1_amf', '-quality', 'quality', '-b:v', preset.bitrate || '1600k'];
    case 'libsvtav1':
      return ['-c:v', 'libsvtav1', '-crf', String(preset.crf || 30), '-preset', String(preset.svtPreset || 8), '-pix_fmt', 'yuv420p'];
    case 'libx264':
    default: {
      // Fallback for AV1 presets uses the card settings.
      const x264 = preset.encoders[0] === 'libx264' ? preset : qualityPresets.card;
      const maxrate = x264.maxrate;
      const bufsize = `${Number.parseInt(maxrate, 10) * 2}k`;
      return [
        '-c:v', 'libx264', '-preset', x264.x264Preset, '-crf', String(x264.crf),
        '-maxrate', maxrate, '-bufsize', bufsize, '-pix_fmt', 'yuv420p'
      ];
    }
  }
}

function widthFor(encoder, preset) {
  if (encoder === 'libx264' && preset.encoders[0] !== 'libx264') {
    return qualityPresets.card.width;
  }
  return preset.width;
}

function buildFfmpegArgs({ videoPath, outputPath, timestamp, duration, encoder, preset }) {
  const fpsMax = preset.fpsMax || 30;
  return [
    '-ss', String(timestamp),
    '-i', videoPath,
    '-t', String(duration),
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-vf', `scale=w='min(${widthFor(encoder, preset)},iw)':h=-2`,
    '-fpsmax', String(fpsMax),
    ...encoderArgs(encoder, preset),
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath
  ];
}

const jobs = new Map(); // key -> job
const pending = []; // keys waiting for a slot, FIFO
let activeCount = 0;
let stopped = false;

function jobKey(videoPath) {
  return path.resolve(videoPath);
}

async function encodeClip(job, config) {
  const preset = qualityPresets[config.previewQuality];
  const timestamp = config.previewTimestamp;
  const outputFilename = getPreviewFilename(job.videoPath, timestamp);
  const outputPath = path.join(config.previewDir, outputFilename);
  const relativePath = `/previews/${outputFilename}`;

  const buildInfo = (size) => ({
    clips: [{ timestamp, duration: config.previewDuration, path: relativePath, size }],
    generated_at: new Date().toISOString(),
    total_size: size
  });

  const existingSize = await nonEmptyFileSize(outputPath);
  if (existingSize) {
    console.log(`Preview clip already exists: ${outputFilename}`);
    return { status: 'completed', previewInfo: buildInfo(existingSize) };
  }

  await fs.promises.mkdir(config.previewDir, { recursive: true });

  let lastError = null;
  for (const encoder of preset.encoders) {
    if (stopped) {
      return { status: 'cancelled' };
    }
    const tempPath = partialPathFor(outputPath);
    try {
      console.log(`Generating preview for video ${job.videoId} with ${encoder} (${config.previewQuality})`);
      await runFfmpeg(buildFfmpegArgs({
        videoPath: job.videoPath,
        outputPath: tempPath,
        timestamp,
        duration: config.previewDuration,
        encoder,
        preset
      }), { timeoutMs: config.timeoutMs });

      const size = await nonEmptyFileSize(tempPath);
      if (!size) {
        throw new Error('ffmpeg produced an empty file');
      }
      await fs.promises.rename(tempPath, outputPath);
      console.log(`Generated preview clip for video ${job.videoId}: ${(size / 1024).toFixed(0)} KB`);
      return { status: 'completed', previewInfo: buildInfo(size) };
    } catch (error) {
      await removeQuietly(tempPath);
      lastError = error;
      if (error.shutdown || stopped) {
        return { status: 'cancelled' };
      }
      console.warn(`Preview encode with ${encoder} failed for video ${job.videoId}: ${error.message}`);
    }
  }

  return { status: 'failed', error: lastError ? lastError.message : 'no encoder available' };
}

async function runJob(job) {
  const config = getConfig();
  const duration = Number(job.videoDuration);
  if (!Number.isFinite(duration) || duration < config.minVideoDuration) {
    console.log(`Video ${job.videoPath} too short (${job.videoDuration}s), skipping preview generation`);
    return { status: 'skipped', error: 'video too short' };
  }
  return encodeClip(job, config);
}

function pump() {
  const { maxConcurrentGenerations } = getConfig();
  while (!stopped && activeCount < maxConcurrentGenerations && pending.length > 0) {
    const key = pending.shift();
    const job = jobs.get(key);
    if (!job) {
      continue;
    }
    activeCount += 1;
    runJob(job)
      .catch((error) => ({ status: 'failed', error: error.message }))
      .then((result) => {
        activeCount -= 1;
        jobs.delete(key);
        job.resolve(result);
        pump();
      });
  }
}

/**
 * Queue preview generation for a video. At most one job per video path is
 * queued or running; a second request returns the same promise.
 *
 * Never rejects. Resolves with one of:
 *   { status: 'completed', previewInfo }  previewInfo is what is stored in preview_clips
 *   { status: 'failed', error }
 *   { status: 'skipped', error }          video shorter than PREVIEW_DURATION + 1
 *   { status: 'cancelled' }               stop() was called
 */
function queuePreviewGeneration(videoPath, videoId, videoDuration) {
  if (stopped) {
    return Promise.resolve({ status: 'cancelled' });
  }

  const key = jobKey(videoPath);
  if (jobs.has(key)) {
    return jobs.get(key).promise;
  }

  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  jobs.set(key, { videoPath, videoId, videoDuration, resolve, promise });
  pending.push(key);
  if (pending.length > 1 || activeCount > 0) {
    console.log(`Queued preview generation for video ${videoId} (${pending.length} waiting, ${activeCount} active)`);
  }
  pump();
  return promise;
}

function isPreviewQueued(videoPath) {
  return jobs.has(jobKey(videoPath));
}

function getQueueStats() {
  return { active: activeCount, waiting: pending.length };
}

// Drop waiting jobs (resolved as cancelled) and kill running ffmpeg children;
// running jobs remove their own temp files.
function stop() {
  stopped = true;
  while (pending.length > 0) {
    const key = pending.shift();
    const job = jobs.get(key);
    if (job) {
      jobs.delete(key);
      job.resolve({ status: 'cancelled' });
    }
  }
  killActiveProcesses();
}

module.exports = {
  queuePreviewGeneration,
  isPreviewQueued,
  getQueueStats,
  getPreviewPathForVideo,
  getPreviewFilePaths,
  getConfig,
  qualityPresets,
  stop
};
