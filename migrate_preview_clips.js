const { initializeDatabase, getVideosPaginated, updateVideoPreview } = require('./db/database');
const { generatePreviewClips } = require('./lib/preview');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

async function migratePreviewsToAV1() {
  console.log('🚀 VODlibrary Preview Migration to AV1 High Quality');
  console.log('==================================================\n');

  try {
    // Initialize database
    console.log('📂 Initializing database...');
    const db = await initializeDatabase();
    
    // Get all videos from database
    console.log('🔍 Fetching all videos from database...');
    const { videos, totalCount } = await getVideosPaginated(db, 1, 99999); // Fetch all videos
    
    if (totalCount === 0) {
      console.log('❌ No videos found. Please run the scanner first.');
      return;
    }

    console.log(`✅ Found ${totalCount} videos in database.`);

    let migratedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const video of videos) {
      console.log(`\nProcessing video: "${video.title}" (ID: ${video.id})`);
      console.log(`   Duration: ${video.duration} seconds`);
      console.log(`   Path: ${video.path}`);

      // Check if preview clips exist and need migration
      if (video.preview_clips && video.preview_generation_status === 'completed') {
        const previewData = JSON.parse(video.preview_clips);
        let needsMigration = false;
        
        const clip = previewData.clips[0];
        if (clip) {
          const clipPath = path.join(__dirname, 'public', clip.path);
          if (fs.existsSync(clipPath)) {
            try {
              const codecInfo = await getVideoCodec(clipPath);
              if (codecInfo.codec !== 'av1') {
                needsMigration = true;
                console.log(`   📹 Found ${codecInfo.codec} clip - needs migration`);
              }
            } catch (error) {
              console.log(`   ⚠️  Could not detect codec for ${clip.path}, assuming migration needed`);
              needsMigration = true;
            }
          } else {
            console.log(`   ❌ Missing clip file: ${clip.path}`);
            needsMigration = true;
          }
        } else {
          needsMigration = true;
        }

        if (needsMigration) {
          console.log('🔄 Migrating to AV1 high quality...');
          
          // Delete old preview clip
          const oldClip = previewData.clips[0];
          if (oldClip) {
            const clipPath = path.join(__dirname, 'public', oldClip.path);
            if (fs.existsSync(clipPath)) {
              fs.unlinkSync(clipPath);
              console.log(`   🗑️  Deleted old clip: ${oldClip.path}`);
            }
          }
          
          // Generate new AV1 clips with force regeneration
          const previewInfo = await generatePreviewClips(video.path, video.id, video.duration, true);
          
          if (previewInfo) {
            console.log('✅ AV1 migration successful:');
            const clip = previewInfo.clips[0];
            console.log(`   Path: ${clip.path}, Size: ${(clip.size / 1024 / 1024).toFixed(2)}MB`);

            // Update database with new preview info
            await updateVideoPreview(db, video.id, JSON.stringify(previewInfo), 'completed', new Date().toISOString());
            migratedCount++;
          } else {
            console.log('❌ AV1 migration failed.');
            await updateVideoPreview(db, video.id, null, 'failed', new Date().toISOString());
            failedCount++;
          }
        } else {
          console.log('✅ Already using AV1 high quality - skipping');
          skippedCount++;
        }
      } else {
        console.log('🔄 Generating new AV1 preview clips...');
        
        // Generate new AV1 clips
        const previewInfo = await generatePreviewClips(video.path, video.id, video.duration);
        
        if (previewInfo) {
          console.log('✅ AV1 generation successful:');
          const clip = previewInfo.clips[0];
          console.log(`   Path: ${clip.path}, Size: ${(clip.size / 1024 / 1024).toFixed(2)}MB`);

          // Update database with preview info
          await updateVideoPreview(db, video.id, JSON.stringify(previewInfo), 'completed', new Date().toISOString());
          migratedCount++;
        } else {
          console.log('❌ AV1 generation failed.');
          await updateVideoPreview(db, video.id, null, 'failed', new Date().toISOString());
          failedCount++;
        }
      }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Migrated: ${migratedCount} videos`);
    console.log(`   ⏭️  Skipped: ${skippedCount} videos (already AV1)`);
    console.log(`   ❌ Failed: ${failedCount} videos`);

    console.log('\n🎯 AV1 Migration Benefits:');
    console.log('✅ Superior compression efficiency (20-30% smaller files)');
    console.log('✅ Better visual quality at same bitrate');
    console.log('✅ Modern codec with future-proof support');
    console.log('✅ Film grain preservation for natural video quality');

    console.log('\n🚀 Migration Complete!');
    console.log('Your previews are now using AV1 high quality encoding.');
    console.log('Start the server with: npm start');
    console.log('Navigate to: http://localhost:8005');
    console.log('Hover over video thumbnails to see improved AV1 previews!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
  }
}

// Helper function to detect video codec
function getVideoCodec(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (videoStream) {
        resolve({
          codec: videoStream.codec_name,
          profile: videoStream.profile || 'unknown'
        });
      } else {
        reject(new Error('No video stream found'));
      }
    });
  });
}

migratePreviewsToAV1();
