const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parsePositiveInt } = require('./parse');
const { runFfmpeg, probeVideo, probeTimeoutMs, partialPathFor, removeQuietly, nonEmptyFileSize } = require('./ffmpeg');

const THUMBNAIL_MAX_WIDTH = 640;
const THUMBNAIL_JPEG_QUALITY = 4; // mjpeg -q:v (2 = best, 31 = worst)

function getThumbnailDir() {
  return process.env.THUMBNAIL_CACHE_DIR || path.join(__dirname, '..', 'public', 'thumbnails');
}

/** Persistent id for generated media: md5 of the video path. */
function generateVideoHash(videoPath) {
  return crypto.createHash('md5').update(videoPath).digest('hex');
}

function getThumbnailFilePath(videoPath) {
  return path.join(getThumbnailDir(), `${generateVideoHash(videoPath)}.jpg`);
}

/** Public URL path of a video's thumbnail. */
function getThumbnailPath(videoPath) {
  return `/thumbnails/${generateVideoHash(videoPath)}.jpg`;
}

function thumbnailExists(videoPath) {
  try {
    return fs.statSync(getThumbnailFilePath(videoPath)).size > 0;
  } catch (_error) {
    return false;
  }
}

/**
 * Generate a card-sized thumbnail (<= 640 px wide, never upscaled) via a temp
 * file and rename. Pass the duration already known from the scanner's probe to
 * avoid a second ffprobe.
 * @returns {Promise<string|null>} public path, or null on failure (the old thumbnail is kept)
 */
async function generateThumbnail(videoPath, { duration, force = false } = {}) {
  const outputPath = getThumbnailFilePath(videoPath);
  if (!force && await nonEmptyFileSize(outputPath)) {
    return getThumbnailPath(videoPath);
  }

  let knownDuration = Number(duration);
  if (!Number.isFinite(knownDuration) || knownDuration <= 0) {
    knownDuration = await probeVideo(videoPath).then((info) => info.duration, (error) => {
      console.error(`Error probing video for thumbnail ${videoPath}: ${error.message}`);
      return null;
    });
  }

  const requested = parsePositiveInt(process.env.THUMBNAIL_TIME, 5);
  const seek = knownDuration > 0 && knownDuration < requested ? knownDuration / 2 : requested;
  await fs.promises.mkdir(getThumbnailDir(), { recursive: true });
  const tempPath = partialPathFor(outputPath);

  const attempt = async (seconds) => {
    await runFfmpeg([
      '-ss', String(seconds),
      '-i', videoPath,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', `scale=w='min(${THUMBNAIL_MAX_WIDTH},iw)':h=-2`,
      '-q:v', String(THUMBNAIL_JPEG_QUALITY),
      '-c:v', 'mjpeg',
      '-f', 'image2',
      '-update', '1',
      tempPath
    ], { timeoutMs: probeTimeoutMs() });
    return nonEmptyFileSize(tempPath);
  };

  try {
    // Seeking past the end (bad duration) produces no frame; fall back to the first one.
    if (!(await attempt(seek)) && !(seek > 0 && await attempt(0))) {
      throw new Error('ffmpeg produced an empty thumbnail');
    }
    await fs.promises.rename(tempPath, outputPath);
    console.log(`Thumbnail generated for video ${videoPath}`);
    return getThumbnailPath(videoPath);
  } catch (error) {
    await removeQuietly(tempPath);
    console.error(`Error generating thumbnail for ${videoPath}: ${error.message}`);
    return null;
  }
}

module.exports = {
  generateThumbnail,
  thumbnailExists,
  getThumbnailPath,
  getThumbnailFilePath,
  generateVideoHash
};
