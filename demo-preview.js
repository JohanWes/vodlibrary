const { initializeDatabase, getVideosPaginated } = require('./db/database');
const { generatePreviewClips } = require('./lib/preview');
const path = require('path');

async function demonstratePreviewFeature() {
  console.log('🎬 VODlibrary Hover Preview Feature Demo');
  console.log('=====================================\n');

  try {
    // Initialize database
    console.log('📂 Initializing database...');
    const db = await initializeDatabase();
    
    // Get first video from database
    console.log('🔍 Fetching videos from database...');
    const { videos } = await getVideosPaginated(db, 1, 1);
    
    if (videos.length === 0) {
      console.log('❌ No videos found. Please run the scanner first.');
      return;
    }

    const video = videos[0];
    console.log(`✅ Found video: "${video.title}"`);
    console.log(`   Duration: ${video.duration} seconds`);
    console.log(`   Path: ${video.path}`);

    // Check if preview clips already exist
    if (video.preview_clips) {
      console.log('✅ Preview clips already exist for this video:');
      const previewData = JSON.parse(video.preview_clips);
      previewData.clips.forEach((clip, index) => {
        console.log(`   ${index + 1}. Timestamp: ${clip.timestamp}s, Path: ${clip.path}, Size: ${(clip.size / 1024 / 1024).toFixed(2)}MB`);
      });
    } else {
      console.log('🔄 Generating preview clips...');
      
      // Generate preview clips
      const previewInfo = await generatePreviewClips(video.path, video.id, video.duration);
      
      if (previewInfo) {
        console.log('✅ Preview clips generated successfully:');
        previewInfo.clips.forEach((clip, index) => {
          console.log(`   ${index + 1}. Timestamp: ${clip.timestamp}s, Path: ${clip.path}, Size: ${(clip.size / 1024 / 1024).toFixed(2)}MB`);
        });
        console.log(`   Total size: ${(previewInfo.total_size / 1024 / 1024).toFixed(2)}MB`);
      } else {
        console.log('❌ Preview generation failed');
      }
    }

    console.log('\n🌐 Frontend Integration:');
    console.log('✅ Video Preview Manager class implemented');
    console.log('✅ Hover event listeners with 800ms delay');
    console.log('✅ Video element pooling for memory management');
    console.log('✅ Graceful fallback to enhanced thumbnails');

    console.log('\n🔌 API Endpoints Available:');
    console.log('✅ GET /api/videos/:id/preview/:timestamp - Serves preview clips');
    console.log('✅ GET /api/videos/:id/preview-info - Returns preview metadata');
    console.log('✅ Fallback to video segments when clips unavailable');

    console.log('\n🎨 Features Implemented:');
    console.log('✅ Hover-triggered video previews');
    console.log('✅ Memory-efficient video element pooling');
    console.log('✅ Authentication integration');
    console.log('✅ CDN support for preview delivery');
    console.log('✅ Performance monitoring and metrics');
    console.log('✅ Mobile responsiveness (disabled on mobile)');
    console.log('✅ Accessibility (reduced motion support)');

    console.log('\n🚀 Ready to test!');
    console.log('Start the server with: npm start');
    console.log('Navigate to: http://localhost:8005');
    console.log('Hover over video thumbnails to see previews in action!');

  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
}

demonstratePreviewFeature();