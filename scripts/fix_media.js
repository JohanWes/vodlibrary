const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initializeDatabase, getAllVideoPaths, getVideoById, updateVideoThumbnail, updateVideoPreview, updateVideo } = require('../db/database');
const { generateThumbnail, thumbnailExists } = require('../lib/thumbnail');
const { generatePreviewClips, previewsExist, getConfig: getPreviewConfig } = require('../lib/preview');

// Helper to check if file actually exists at path
function fileExists(relativePath) {
    if (!relativePath) return false;
    // Handle relative paths from public
    const publicPath = path.join(__dirname, '..', 'public');
    // Remove leading slash if present
    const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    const fullPath = path.join(publicPath, cleanPath);
    return fs.existsSync(fullPath);
}

async function fixMedia() {
    console.error('Starting media fix script (stderr)...');
    console.log('Starting media fix script...');

    try {
        const db = await initializeDatabase();
        const videos = await getAllVideoPaths(db); // returns {id, path}

        console.log(`Found ${videos.length} videos in database.`);

        let thumbFixed = 0;
        let previewFixed = 0;
        let thumbErrors = 0;
        let previewErrors = 0;

        // Limit to 3 videos for testing
        // const videosToProcess = videos.slice(0, 3);
        const videosToProcess = videos;
        console.error(`Processing ${videosToProcess.length} videos...`);

        for (const v of videosToProcess) {
            const videoId = v.id;
            const videoPath = v.path;
            console.log(`Processing video [${videoId}]: ${path.basename(videoPath)}`);

            // 1. Fix Thumbnail
            try {
                const videoData = await getVideoById(db, videoId);

                // Check if DB says we have a thumbnail and if it exists on disk
                let needsThumb = false;
                if (!videoData.thumbnail_path) {
                    console.log('  - Missing thumbnail path in DB.');
                    needsThumb = true;
                } else if (!fileExists(videoData.thumbnail_path)) {
                    console.log(`  - Thumbnail file missing at ${videoData.thumbnail_path}`);
                    needsThumb = true;
                }

                if (needsThumb) {
                    console.log('  - Generating thumbnail...');
                    const newThumbPath = await generateThumbnail(videoPath, videoId);
                    if (newThumbPath) {
                        await updateVideoThumbnail(db, videoId, newThumbPath);
                        console.log('  - Thumbnail fixed.');
                        thumbFixed++;
                    } else {
                        console.log('  - Failed to generate thumbnail (returned null).');
                        thumbErrors++;
                    }
                } else {
                    console.log('  - Thumbnail OK.');
                }

            } catch (err) {
                console.error(`  - Error fixing thumbnail: ${err.message}`);
                thumbErrors++;
            }

            // 2. Fix Previews
            try {
                const videoData = await getVideoById(db, videoId);

                // Check if previews need generation
                // Logic: If status is 'failed' OR 'pending' (stuck) OR 'completed' but files missing
                let needsPreview = false;

                if (!videoData.preview_generation_status || videoData.preview_generation_status === 'failed') {
                    console.log(`  - Preview status is ${videoData.preview_generation_status}.`);
                    needsPreview = true;
                } else if (videoData.preview_generation_status === 'completed') {
                    // Check if files exist
                    const clips = videoData.preview_clips ? JSON.parse(videoData.preview_clips) : null;
                    if (!clips || !clips.clips || clips.clips.length === 0) {
                        console.log('  - Preview marked completed but no clips data.');
                        needsPreview = true;
                    } else {
                        // Check first clip
                        const firstClip = clips.clips[0];
                        if (!fileExists(firstClip.path)) {
                            console.log(`  - Preview file missing at ${firstClip.path}`);
                            needsPreview = true;
                        }
                    }
                }

                if (needsPreview) {
                    console.log('  - Generating previews...');
                    // Force regenerate
                    await updateVideoPreview(db, videoId, null, 'generating', new Date().toISOString());
                    const previewInfo = await generatePreviewClips(videoPath, videoId, videoData.duration || 0, true);

                    if (previewInfo) {
                        await updateVideoPreview(
                            db,
                            videoId,
                            JSON.stringify(previewInfo),
                            'completed',
                            new Date().toISOString()
                        );
                        console.log('  - Previews fixed.');
                        previewFixed++;
                    } else {
                        await updateVideoPreview(db, videoId, null, 'failed', new Date().toISOString());
                        console.log('  - Failed to generate previews.');
                        previewErrors++;
                    }
                } else {
                    console.log('  - Previews OK.');
                }

            } catch (err) {
                console.error(`  - Error fixing previews: ${err.message}`);
                previewErrors++;
            }
        }

        console.log('--------------------------------------------------');
        console.log(`Media Fix Complete.`);
        console.log(`Thumbnails Fixed: ${thumbFixed}, Errors: ${thumbErrors}`);
        console.log(`Previews Fixed: ${previewFixed}, Errors: ${previewErrors}`);

    } catch (error) {
        console.error('Fatal error in fix script:', error);
    }
}

fixMedia();
