const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg'); // Import fluent-ffmpeg
const { generateThumbnail, thumbnailExists, getThumbnailPath } = require('./thumbnail');
const { generatePreviewClips } = require('./preview');
// Import updateVideo as well
const { getAllVideoPaths, getVideoByPath, updateVideoThumbnail, updateVideoPreview, addVideo, deleteVideo, updateVideo } = require('../db/database');

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

function getLibraryPaths() {
  const raw = process.env.VIDEO_LIBRARY;
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((libraryPath) => libraryPath.trim())
    .filter(Boolean);
}

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

  const libraryPaths = getLibraryPaths();
  if (libraryPaths.length === 0) {
    scanStatus.status = 'completed';
    scanStatus.message = 'Scan skipped: VIDEO_LIBRARY is not configured.';
    scanStatus.endTime = new Date();
    return;
  }

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
        const metadataJson = await getFullMetadataFromJson(filePath); // Get full metadata regardless

        if (existingVideo) {
          let updated = false;
          let videoDataToUpdate = { ...existingVideo }; // Start with existing data

          // Check if thumbnail needs update
          if (!existingVideo.thumbnail_path || !thumbnailExists(filePath)) {
            const thumbnailPath = await generateThumbnail(filePath, existingVideo.id);
            videoDataToUpdate.thumbnail_path = thumbnailPath;
            updated = true;
          }
          // Check if death timestamps need update
          if (existingVideo.death_timestamps !== deathTimestampsJson) {
            videoDataToUpdate.death_timestamps = deathTimestampsJson;
            updated = true;
          }
          
          // Check if metadata needs update
          if (existingVideo.metadata !== metadataJson) {
            videoDataToUpdate.metadata = metadataJson;
            updated = true;
          }

          // Check if width/height need update (or are missing)
          if (!existingVideo.width || !existingVideo.height) {
            try {
              const { width, height } = await probeVideo(filePath);
              if (width && height) {
                videoDataToUpdate.width = width;
                videoDataToUpdate.height = height;
                updated = true;
              }
            } catch (error) {
              console.error(`Error probing video ${filePath}:`, error);
            }
          }

          if (updated) {
            await updateVideo(db, existingVideo.id, videoDataToUpdate);
            scanStatus.updatedCount++;
          }

          // Retry preview generation for videos stuck in 'generating' or 'failed' status
          const previewStatus = existingVideo.preview_generation_status;
          if (process.env.ENABLE_PREVIEWS !== 'false' &&
              (previewStatus === 'generating' || previewStatus === 'failed' || !previewStatus)) {
            setImmediate(async () => {
              try {
                await updateVideoPreview(db, existingVideo.id, null, 'generating', new Date().toISOString());
                console.log(`Retrying preview generation for existing video: ${existingVideo.title}`);
                const previewInfo = await generatePreviewClips(filePath, existingVideo.id, Math.round(existingVideo.duration));
                if (previewInfo) {
                  await updateVideoPreview(db, existingVideo.id, JSON.stringify(previewInfo), 'completed', new Date().toISOString());
                  console.log(`Preview generation completed for video: ${existingVideo.title}`);
                } else {
                  await updateVideoPreview(db, existingVideo.id, null, 'failed', new Date().toISOString());
                }
              } catch (error) {
                console.error(`Error retrying previews for video ${existingVideo.title}:`, error);
                await updateVideoPreview(db, existingVideo.id, null, 'failed', new Date().toISOString());
              }
            });
          }
        } else {
          // New video - processVideoFile will handle all metadata extraction
          await processVideoFile(db, filePath);
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
  const files = await fs.promises.readdir(dir);
  const videoFiles = [];
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = await fs.promises.stat(filePath);
    
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
    const { duration, width, height } = await probeVideo(filePath);
    if (!Number.isFinite(duration)) {
      throw new Error(`No finite duration found for ${filePath}`);
    }
    const stats = await fs.promises.stat(filePath);
    const fileDate = stats.birthtime || stats.mtime; // Use file date

    // Get death timestamps
    const deathTimestampsJson = await getDeathTimestampsFromJson(filePath);
    
    // Get full metadata
    const metadataJson = await getFullMetadataFromJson(filePath);

    let thumbnailPath = null;
    if (thumbnailExists(filePath)) {
      thumbnailPath = getThumbnailPath(filePath);
    }

    const video = {
      title,
      path: filePath,
      duration: Math.round(duration),
      width,  // Include width
      height, // Include height
      thumbnail_path: thumbnailPath,
      added_date: fileDate.toISOString(),
      death_timestamps: deathTimestampsJson, // Include timestamps
      metadata: metadataJson // Include full metadata
    };

    const videoId = await addVideo(db, video); // Add video with timestamps and dimensions

    // Generate thumbnail if it didn't exist
    if (!thumbnailPath) {
      thumbnailPath = await generateThumbnail(filePath, videoId);
      await updateVideoThumbnail(db, videoId, thumbnailPath);
    }

    // Generate preview clips asynchronously (don't block processing)
    setImmediate(async () => {
      try {
        if (process.env.ENABLE_PREVIEWS !== 'false') {
          await updateVideoPreview(db, videoId, null, 'generating', new Date().toISOString());
          console.log(`Starting preview generation for video: ${title}`);
          
          const previewInfo = await generatePreviewClips(filePath, videoId, Math.round(duration));
          
          if (previewInfo) {
            await updateVideoPreview(
              db, 
              videoId, 
              JSON.stringify(previewInfo), 
              'completed', 
              new Date().toISOString()
            );
            console.log(`Preview generation completed for video: ${title}`);
          } else {
            await updateVideoPreview(db, videoId, null, 'failed', new Date().toISOString());
            console.log(`Preview generation failed for video: ${title}`);
          }
        }
      } catch (error) {
        console.error(`Error generating previews for video ${title}:`, error);
        await updateVideoPreview(db, videoId, null, 'failed', new Date().toISOString());
      }
    });

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
 * Probes a video file for duration and dimensions using ffprobe.
 * @param {string} filePath - The path to the video file.
 * @returns {Promise<{duration: number|null, width: number|null, height: number|null}>} - An object containing duration, width, and height.
 */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      const durationValues = [
        metadata.format && metadata.format.duration,
        ...(metadata.streams || []).map(stream => stream.duration)
      ];
      const foundDuration = durationValues.find(value => value != null && Number.isFinite(Number(value)));
      const videoStream = (metadata.streams || []).find(s => s.codec_type === 'video');
      resolve({
        duration: foundDuration != null ? Number(foundDuration) : null,
        width: videoStream ? videoStream.width : null,
        height: videoStream ? videoStream.height : null
      });
    });
  });
}

/**
 * Reads the companion JSON file for a video and extracts death timestamps.
 * @param {string} videoFilePath Path to the video file.
 * @returns {Promise<string|null>} JSON string of the timestamp array, or null if no file/data.
 */
async function getDeathTimestampsFromJson(videoFilePath) {
  const jsonFilePath = videoFilePath.replace(/\.[^.]+$/, '.json');
  try {
    if (fs.existsSync(jsonFilePath)) {
      const jsonDataRaw = await fs.promises.readFile(jsonFilePath, 'utf-8');
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

/**
 * Reads the companion JSON file for a video and returns the full metadata.
 * @param {string} videoFilePath Path to the video file.
 * @returns {Promise<string|null>} JSON string of the full metadata, or null if no file/data.
 */
async function getFullMetadataFromJson(videoFilePath) {
  const jsonFilePath = videoFilePath.replace(/\.[^.]+$/, '.json');
  try {
    if (fs.existsSync(jsonFilePath)) {
      const jsonDataRaw = await fs.promises.readFile(jsonFilePath, 'utf-8');
      const jsonData = JSON.parse(jsonDataRaw);

      // Check if this looks like WoW metadata (has required fields for either dungeon or raid)
      if (jsonData && (
        (jsonData.category === 'Mythic+' && jsonData.zoneID && jsonData.keystoneLevel) ||
        (jsonData.category === 'Raids' && jsonData.encounterID && jsonData.difficulty) ||
        (jsonData.zoneID || jsonData.encounterID || jsonData.combatants) // General WoW metadata
      )) {
        return JSON.stringify(jsonData);
      }
    }
  } catch (error) {
    console.error(`Error reading or parsing full metadata JSON for ${videoFilePath}: ${error.message}`);
  }
  return null; // Return null if file doesn't exist, parse error, or not valid WoW metadata
}
