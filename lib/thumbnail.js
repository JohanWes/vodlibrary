const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

// Check if ffmpeg is available - use system ffmpeg on Linux
let ffmpegAvailable = true;
try {
  // Only use ffmpeg-static on Windows, otherwise use system ffmpeg
  if (process.platform === 'win32') {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && require('fs').existsSync(ffmpegStatic)) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
    }
  } else {
    // On Linux, confirm ffmpeg is in PATH
    // We can optionaly check with `command -v ffmpeg` but fluent-ffmpeg usually handles it.
    console.log('Using system ffmpeg');
  }
} catch (error) {
  console.log('Error setting ffmpeg path:', error);
}

/**
 * Generate a hash from a video path to use as a persistent identifier
 * @param {string} videoPath - Path to the video file
 * @returns {string} - Hash string
 */
function generateVideoHash(videoPath) {
  return crypto.createHash('md5').update(videoPath).digest('hex');
}

/**
 * Generate a thumbnail for a video file
 * @param {string} videoPath - Path to the video file
 * @param {number} videoId - ID of the video in the database (used for backward compatibility)
 * @returns {Promise<string>} - Path to the generated thumbnail
 */
async function generateThumbnail(videoPath, videoId) {
  return new Promise((resolve, reject) => {
    const thumbnailTime = process.env.THUMBNAIL_TIME || 5;

    const thumbnailDir = process.env.THUMBNAIL_CACHE_DIR || path.join(__dirname, '..', 'public', 'thumbnails');
    if (!fs.existsSync(thumbnailDir)) {
      fs.mkdirSync(thumbnailDir, { recursive: true });
    }

    // Create a symlink from the data thumbnails to public thumbnails if needed
    const publicThumbnailDir = path.join(__dirname, '..', 'public', 'thumbnails');
    if (thumbnailDir !== publicThumbnailDir && !fs.existsSync(publicThumbnailDir)) {
      try {
        fs.mkdirSync(path.dirname(publicThumbnailDir), { recursive: true });
        fs.symlinkSync(thumbnailDir, publicThumbnailDir, 'dir');
        console.log(`Created symlink from ${thumbnailDir} to ${publicThumbnailDir}`);
      } catch (error) {
        console.warn(`Could not create symlink from ${thumbnailDir} to ${publicThumbnailDir}:`, error);
      }
    }

    const videoHash = generateVideoHash(videoPath);

    const thumbnailFilename = `${videoHash}.jpg`;
    const thumbnailPath = path.join(thumbnailDir, thumbnailFilename);
    const relativeThumbnailPath = `/thumbnails/${thumbnailFilename}`;

    if (fs.existsSync(thumbnailPath)) {
      console.log(`Thumbnail already exists for video ${videoPath}`);
      resolve(relativeThumbnailPath);
      return;
    }

    // If ffmpeg is not available, return null (will use placeholder)
    if (!ffmpegAvailable) {
      console.log(`FFmpeg not available, skipping thumbnail generation for video ${videoPath}`);
      resolve(null);
      return;
    }

    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error(`Error probing video for thumbnail ${videoPath}:`, err);
        // Fallback to default behavior if probe fails, but it might fail again
        ffmpeg(videoPath)
          .on('error', (err) => {
            console.error(`Error generating thumbnail for ${videoPath}:`, err);
            resolve(null);
          })
          .on('end', () => {
            console.log(`Thumbnail generated for video ${videoPath}`);
            resolve(relativeThumbnailPath);
          })
          .screenshots({
            count: 1,
            folder: thumbnailDir,
            filename: thumbnailFilename,
            timemarks: [thumbnailTime]
          });
        return;
      }

      const duration = metadata.format.duration;
      let finalTime = thumbnailTime;

      // If video is shorter than the requested time, capture at 50%
      if (duration && duration < thumbnailTime) {
        finalTime = duration / 2;
        console.log(`Video ${videoPath} is short (${duration}s), adjusting thumbnail capture to ${finalTime.toFixed(2)}s`);
      }

      ffmpeg(videoPath)
        .on('error', (err) => {
          console.error(`Error generating thumbnail for ${videoPath}:`, err);
          resolve(null);
        })
        .on('end', () => {
          console.log(`Thumbnail generated for video ${videoPath}`);
          resolve(relativeThumbnailPath);
        })
        .screenshots({
          count: 1,
          folder: thumbnailDir,
          filename: thumbnailFilename,
          timemarks: [finalTime]
        });
    });
  });
}

/**
 * Check if a thumbnail exists for a video
 * @param {string} videoPath - Path to the video file
 * @returns {boolean} - True if thumbnail exists, false otherwise
 */
function thumbnailExists(videoPath) {
  const thumbnailDir = process.env.THUMBNAIL_CACHE_DIR || path.join(__dirname, '..', 'public', 'thumbnails');
  const videoHash = generateVideoHash(videoPath);
  const thumbnailPath = path.join(thumbnailDir, `${videoHash}.jpg`);
  return fs.existsSync(thumbnailPath);
}

/**
 * Get the thumbnail path for a video
 * @param {string} videoPath - Path to the video file
 * @returns {string} - Relative path to the thumbnail
 */
function getThumbnailPath(videoPath) {
  const videoHash = generateVideoHash(videoPath);
  return `/thumbnails/${videoHash}.jpg`;
}

module.exports = {
  generateThumbnail,
  thumbnailExists,
  getThumbnailPath,
  generateVideoHash
};
