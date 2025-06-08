const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

// Check if ffmpeg is available
let ffmpegAvailable = true;
try {
  ffmpeg.setFfmpegPath(require('ffmpeg-static'));
} catch (error) {
  console.warn('FFmpeg not available. Preview generation will be disabled.');
  ffmpegAvailable = false;
}

const config = {
  previewDir: path.join(__dirname, '..', 'public', 'previews'),
  previewDuration: 10, // 10 second preview clips
  previewQuality: 'high', // Upgraded to high quality with AV1
  previewTimestamps: [0], // Default timestamps to generate previews at
  maxConcurrentGenerations: 2,
  minVideoDuration: 11, // Must be longer than preview duration (10s)
  cleanupDays: 30
};

// Quality presets for different performance needs
const qualityPresets = {
  low: { 
    codec: 'libx264',
    crf: 32, 
    preset: 'ultrafast', 
    scale: '480:-2', 
    bitrate: '200k' 
  },
  medium: { 
    codec: 'libsvtav1',
    crf: 28, 
    preset: 6, 
    scale: '720:-2', 
    bitrate: '400k'
  },
  high: { 
    codec: 'av1_amf', 
    quality: 'quality',
    scale: '1080:-2', 
    bitrate: '1600k'
  },
  amd_av1: { 
    codec: 'av1_amf',
    quality: 'quality',
    scale: '1080:-2', 
    bitrate: '1600k'
  }
};

class PreviewGenerator {
  constructor() {
    this.activeGenerations = new Set();
    this.generationQueue = [];
    this.setupPreviewDirectory();
  }

  setupPreviewDirectory() {
    if (!fs.existsSync(config.previewDir)) {
      fs.mkdirSync(config.previewDir, { recursive: true });
    }
    
    // Create symlink from data previews to public previews if needed
    const publicPreviewDir = path.join(__dirname, '..', 'public', 'previews');
    if (config.previewDir !== publicPreviewDir && !fs.existsSync(publicPreviewDir)) {
      try {
        fs.mkdirSync(path.dirname(publicPreviewDir), { recursive: true });
        fs.symlinkSync(config.previewDir, publicPreviewDir, 'dir');
        console.log(`Created symlink from ${config.previewDir} to ${publicPreviewDir}`);
      } catch (error) {
        console.warn(`Could not create symlink from ${config.previewDir} to ${publicPreviewDir}:`, error);
      }
    }
  }

  /**
   * Generate a hash from a video path to use as a persistent identifier
   * @param {string} videoPath - Path to the video file
   * @returns {string} - Hash string
   */
  generateVideoHash(videoPath) {
    return crypto.createHash('md5').update(videoPath).digest('hex');
  }

  /**
   * Generate preview clips for a video
   * @param {string} videoPath - Path to the video file
   * @param {number} videoId - ID of the video in the database
   * @param {number} videoDuration - Duration of the video in seconds
   * @param {boolean} forceRegenerate - Force regeneration even if clips exist
   * @returns {Promise<Object|null>} - Preview clips info or null if failed
   */
  async generatePreviewClips(videoPath, videoId, videoDuration, forceRegenerate = false) {
    if (!ffmpegAvailable) {
      console.log(`FFmpeg not available, skipping preview generation for video ${videoPath}`);
      return null;
    }

    if (videoDuration < config.minVideoDuration) {
      console.log(`Video ${videoPath} too short (${videoDuration}s), skipping preview generation`);
      return null;
    }

    // Check if already generating
    const generationKey = `${videoId}_${videoPath}`;
    if (this.activeGenerations.has(generationKey)) {
      console.log(`Preview generation already in progress for video ${videoId}`);
      return null;
    }

    // Check concurrent generation limit
    if (this.activeGenerations.size >= config.maxConcurrentGenerations) {
      console.log(`Maximum concurrent generations reached, queueing video ${videoId}`);
      return new Promise((resolve) => {
        this.generationQueue.push({ videoPath, videoId, videoDuration, resolve });
      });
    }

    return this.executeGeneration(videoPath, videoId, videoDuration, forceRegenerate);
  }

  async executeGeneration(videoPath, videoId, videoDuration, forceRegenerate = false) {
    const generationKey = `${videoId}_${videoPath}`;
    this.activeGenerations.add(generationKey);

    try {
      const videoHash = this.generateVideoHash(videoPath);
      const clips = [];
      
      // Calculate appropriate timestamps based on video duration
      const timestamps = this.calculateTimestamps(videoDuration);
      
      console.log(`Generating ${timestamps.length} preview clips for video ${videoId} (${videoDuration}s)`);

      for (const timestamp of timestamps) {
        try {
          const clipPath = await this.generateSingleClip(videoPath, timestamp, videoHash, forceRegenerate);
          if (clipPath) {
            const stats = fs.statSync(path.join(config.previewDir, path.basename(clipPath)));
            clips.push({
              timestamp,
              duration: config.previewDuration,
              path: clipPath,
              size: stats.size
            });
          }
        } catch (error) {
          console.error(`Failed to generate preview clip at ${timestamp}s for video ${videoId}:`, error);
        }
      }

      if (clips.length === 0) {
        console.log(`No preview clips generated for video ${videoId}`);
        return null;
      }

      const totalSize = clips.reduce((sum, clip) => sum + clip.size, 0);
      
      const previewInfo = {
        clips,
        generated_at: new Date().toISOString(),
        total_size: totalSize
      };

      console.log(`Generated ${clips.length} preview clips for video ${videoId}, total size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
      return previewInfo;

    } catch (error) {
      console.error(`Preview generation failed for video ${videoId}:`, error);
      return null;
    } finally {
      this.activeGenerations.delete(generationKey);
      this.processQueue();
    }
  }

  calculateTimestamps(videoDuration) {
    const maxValidTimestamp = videoDuration - config.previewDuration;
    if (maxValidTimestamp > 0) {
      return [config.previewTimestamps[0]];
    }
    return [];
  }

  async generateSingleClip(videoPath, timestamp, videoHash, forceRegenerate = false) {
    const preset = qualityPresets[config.previewQuality] || qualityPresets.medium;
    const outputFilename = `${videoHash}_${timestamp}s.mp4`;
    const outputPath = path.join(config.previewDir, outputFilename);
    const relativePath = `/previews/${outputFilename}`;

    if (fs.existsSync(outputPath) && !forceRegenerate) {
      console.log(`Preview clip already exists: ${outputFilename}`);
      return relativePath;
    }

    if (forceRegenerate && fs.existsSync(outputPath)) {
      console.log(`Regenerating preview clip: ${outputFilename}`);
      fs.unlinkSync(outputPath);
    }

    const attemptEncoding = (codec, options) => {
      return new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg(videoPath)
          .seekInput(timestamp)
          .duration(config.previewDuration)
          .videoCodec(codec)
          .outputOptions(options)
          .output(outputPath)
          .on('start', (command) => console.log(`Starting preview generation with ${codec}: ${command}`))
          .on('end', () => resolve(relativePath))
          .on('error', (err) => reject(err));
        
        ffmpegCommand.run();
      });
    };

    try {
      if (preset.codec === 'av1_amf') {
        const options = [
          `-quality ${preset.quality}`,
          `-vf scale=${preset.scale}`,
          `-b:v ${preset.bitrate}`,
          '-movflags +faststart',
          '-an'
        ];
        return await attemptEncoding('av1_amf', options);
      }
    } catch (error) {
      console.warn(`AV1 encoding failed for ${outputFilename}, falling back to H.264. Error: ${error.message}`);
      // Fallback to H.264
    }

    // H.264 encoding (fallback or default)
    const h264Preset = qualityPresets.low;
    const options = [
      `-crf ${h264Preset.crf}`,
      `-preset ${h264Preset.preset}`,
      `-vf scale=${h264Preset.scale}`,
      `-maxrate ${h264Preset.bitrate}`,
      `-bufsize ${h264Preset.bitrate}`,
      '-movflags +faststart',
      '-an'
    ];
    return attemptEncoding('libx264', options);
  }

  processQueue() {
    if (this.generationQueue.length > 0 && this.activeGenerations.size < config.maxConcurrentGenerations) {
      const next = this.generationQueue.shift();
      this.executeGeneration(next.videoPath, next.videoId, next.videoDuration)
        .then(next.resolve)
        .catch((error) => {
          console.error(`Queued generation failed:`, error);
          next.resolve(null);
        });
    }
  }

  /**
   * Clean up old preview files
   */
  async cleanupOldPreviews() {
    try {
      const files = await fs.promises.readdir(config.previewDir);
      const cutoffDate = new Date(Date.now() - (config.cleanupDays * 24 * 60 * 60 * 1000));
      
      for (const file of files) {
        if (file.endsWith('.mp4')) {
          const filePath = path.join(config.previewDir, file);
          const stats = await fs.promises.stat(filePath);
          
          if (stats.mtime < cutoffDate) {
            await fs.promises.unlink(filePath);
            console.log(`Cleaned up old preview file: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning up old previews:', error);
    }
  }

  /**
   * Check if preview clips exist for a video
   * @param {string} videoPath - Path to the video file
   * @returns {boolean} - True if preview clips exist
   */
  previewsExist(videoPath) {
    const videoHash = this.generateVideoHash(videoPath);
    const timestamps = config.previewTimestamps;
    
    return timestamps.some(timestamp => {
      const filename = `${videoHash}_${timestamp}s.mp4`;
      const filePath = path.join(config.previewDir, filename);
      return fs.existsSync(filePath);
    });
  }

  /**
   * Get preview clip paths for a video
   * @param {string} videoPath - Path to the video file
   * @returns {Array} - Array of preview clip info
   */
  getPreviewClips(videoPath) {
    const videoHash = this.generateVideoHash(videoPath);
    const clips = [];
    
    for (const timestamp of config.previewTimestamps) {
      const filename = `${videoHash}_${timestamp}s.mp4`;
      const filePath = path.join(config.previewDir, filename);
      const relativePath = `/previews/${filename}`;
      
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        clips.push({
          timestamp,
          duration: config.previewDuration,
          path: relativePath,
          size: stats.size
        });
      }
    }
    
    return clips;
  }
}

// Create singleton instance
const previewGenerator = new PreviewGenerator();

module.exports = {
  generatePreviewClips: (videoPath, videoId, videoDuration, forceRegenerate = false) => 
    previewGenerator.generatePreviewClips(videoPath, videoId, videoDuration, forceRegenerate),
  previewsExist: (videoPath) => previewGenerator.previewsExist(videoPath),
  getPreviewClips: (videoPath) => previewGenerator.getPreviewClips(videoPath),
  cleanupOldPreviews: () => previewGenerator.cleanupOldPreviews(),
  PreviewGenerator // Export class for testing
};
