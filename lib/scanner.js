const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { getVideoDurationInSeconds } = require('get-video-duration');
const { generateThumbnail, thumbnailExists, getThumbnailPath } = require('./thumbnail');
// Import updateVideo as well
const { getAllVideoPaths, getVideoByPath, updateVideoThumbnail, addVideo, deleteVideo, updateVideo } = require('../db/database');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile); // For reading JSON files

// Video file extensions to scan for
const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', // Existing
  '.m4v', '.mpg', '.mpeg', '.ts', '.vob', '.ogv', '.3gp'  // Added
];

// Module-level variable to track scan status
let scanStatus = {
  status: 'idle', // idle, running, completed, failed
  message: '',
  startTime: null,
  endTime: null,
  newCount: 0,
  updatedCount: 0,
  removedCount: 0,
};

/**
 * Scan the video library directories and add videos to the database
 */
async function scanLibrary(db) {
  if (scanStatus.status === 'running') {
    console.log('Scan is already running.');
    return; // Prevent concurrent scans
  }

  scanStatus = {
    status: 'running',
    message: 'Starting library scan...',
    startTime: new Date(),
    endTime: null,
    newCount: 0,
    updatedCount: 0,
    removedCount: 0,
  };
  console.log(scanStatus.message);

  const libraryPaths = process.env.VIDEO_LIBRARY.split(',').map(path => path.trim());

  try {
    const existingVideos = await getAllVideoPaths(db);
    const existingPaths = new Set(existingVideos.map(v => v.path));
    const processedPaths = new Set();
    
    let allVideoFiles = [];
    
    for (const libraryPath of libraryPaths) {
      if (!fs.existsSync(libraryPath)) {
        console.error(`Library path does not exist: ${libraryPath}`);
        continue; // Skip this directory but continue with others
      }
      
      console.log(`Scanning directory: ${libraryPath}`);
      const videoFiles = await findVideoFiles(libraryPath);
      console.log(`Found ${videoFiles.length} video files in ${libraryPath}`);
      
      allVideoFiles = [...allVideoFiles, ...videoFiles];
    }
    
    console.log(`Found ${allVideoFiles.length} total video files across all directories`);
    
    // Reset counts for this run
    scanStatus.newCount = 0;
    scanStatus.updatedCount = 0;
    scanStatus.removedCount = 0;

    for (const filePath of allVideoFiles) {
      try {
        processedPaths.add(filePath);

        const existingVideo = await getVideoByPath(db, filePath);
        const deathTimestampsJson = await getDeathTimestampsFromJson(filePath); // Get timestamps regardless

        if (existingVideo) {
          let updated = false;
          // Check if thumbnail needs update
          if (!existingVideo.thumbnail_path || !thumbnailExists(filePath)) {
            const thumbnailPath = await generateThumbnail(filePath, existingVideo.id);
            await updateVideoThumbnail(db, existingVideo.id, thumbnailPath);
            updated = true; // Mark as updated if thumbnail was generated
          }
          // Check if death timestamps need update
          if (existingVideo.death_timestamps !== deathTimestampsJson) {
            // Need to fetch the full video data to update, or modify updateVideo function
            // For simplicity, let's assume updateVideo can handle partial updates or we fetch all data
            // Fetching all data might be safer if updateVideo expects all fields
            const videoDataToUpdate = {
              ...existingVideo, // Spread existing data
              death_timestamps: deathTimestampsJson // Overwrite timestamps
            };
            // Ensure we pass all fields expected by the updated updateVideo function
            await updateVideo(db, existingVideo.id, videoDataToUpdate);
            updated = true; // Mark as updated if timestamps changed
          }

          if (updated) {
            scanStatus.updatedCount++;
          }
        } else {
          // New video - processVideoFile will handle timestamps
          await processVideoFile(db, filePath); // Pass timestamps here
          scanStatus.newCount++;
        }
      } catch (error) {
        console.error(`Error processing or checking video file ${filePath}:`, error);
      }
    }
    
    for (const video of existingVideos) {
      if (!processedPaths.has(video.path)) {
        // Video no longer exists in filesystem
        await deleteVideo(db, video.id);
        scanStatus.removedCount++;
      }
    }

    scanStatus.status = 'completed';
    scanStatus.message = `Scan complete: ${scanStatus.newCount} new, ${scanStatus.updatedCount} updated, ${scanStatus.removedCount} removed.`;
    scanStatus.endTime = new Date();
    console.log(scanStatus.message);

  } catch (error) {
    console.error('Error scanning library:', error);
    scanStatus.status = 'failed';
    scanStatus.message = `Scan failed: ${error.message}`;
    scanStatus.endTime = new Date();
  }
}

/**
 * Find all video files in a directory recursively
 */
async function findVideoFiles(dir) {
  const files = await readdir(dir);
  const videoFiles = [];
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = await stat(filePath);
    
    if (stats.isDirectory()) {
      const nestedFiles = await findVideoFiles(filePath);
      videoFiles.push(...nestedFiles);
    } else if (isVideoFile(file)) {
      videoFiles.push(filePath);
    }
  }
  
  return videoFiles;
}

/**
 * Check if a file is a video based on its extension
 */
function isVideoFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Process a video file and add it to the database
 */
async function processVideoFile(db, filePath) {
  try {
    const title = path.basename(filePath, path.extname(filePath));
    const duration = await getVideoDurationInSeconds(filePath);
    const stats = await stat(filePath);
    const fileDate = stats.birthtime || stats.mtime; // Use file date

    // Get death timestamps
    const deathTimestampsJson = await getDeathTimestampsFromJson(filePath);

    let thumbnailPath = null;
    if (thumbnailExists(filePath)) {
      thumbnailPath = getThumbnailPath(filePath);
    }

    const video = {
      title,
      path: filePath,
      duration: Math.round(duration),
      thumbnail_path: thumbnailPath,
      added_date: fileDate.toISOString(),
      death_timestamps: deathTimestampsJson // Include timestamps
    };

    const videoId = await addVideo(db, video); // Add video with timestamps

    // Generate thumbnail if it didn't exist
    if (!thumbnailPath) {
      thumbnailPath = await generateThumbnail(filePath, videoId);
      await updateVideoThumbnail(db, videoId, thumbnailPath);
    }

    console.log(`Processed new video: ${title}`);
  } catch (error) {
    console.error(`Error processing video ${filePath}:`, error);
    throw error;
  }
}

/**
 * Get the current status of the library scan
 */
function getScanStatus() {
  return scanStatus;
}

module.exports = {
  scanLibrary,
  getScanStatus, // Export the status getter
  processVideoFile, // Export for watcher use
  isVideoFile // Export for watcher use
};

/**
 * Reads the companion JSON file for a video and extracts death timestamps.
 * @param {string} videoFilePath Path to the video file.
 * @returns {Promise<string|null>} JSON string of the timestamp array, or null if no file/data.
 */
async function getDeathTimestampsFromJson(videoFilePath) {
  const jsonFilePath = videoFilePath.replace(/\.[^.]+$/, '.json');
  try {
    if (fs.existsSync(jsonFilePath)) {
      const jsonDataRaw = await readFile(jsonFilePath, 'utf-8');
      const jsonData = JSON.parse(jsonDataRaw);

      if (jsonData && Array.isArray(jsonData.deaths)) {
        const timestamps = jsonData.deaths.map(death => death.timestamp).filter(ts => typeof ts === 'number');
        if (timestamps.length > 0) {
          return JSON.stringify(timestamps);
        }
      }
    }
  } catch (error) {
    console.error(`Error reading or parsing JSON for ${videoFilePath}: ${error.message}`);
  }
  return null; // Return null if file doesn't exist, parse error, or no valid data
}
