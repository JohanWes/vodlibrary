/**
 * Client-facing video projections
 *
 * Explicit allowlist mappers that turn database rows into safe DTOs for the
 * client. Never expose absolute paths, raw metadata, or preview internals.
 * Both mappers are pure: they read from the input row and return a new object.
 */

const { videoFacts } = require('./video-facts');

function toPreviewDescriptor(video) {
  let clips = [];
  try {
    const previewInfo = video.preview_clips ? JSON.parse(video.preview_clips) : null;
    clips = previewInfo && Array.isArray(previewInfo.clips) ? previewInfo.clips : [];
  } catch (_error) {
    clips = [];
  }

  const firstClip = clips.find((clip) => (
    clip && Number.isSafeInteger(clip.timestamp) && clip.timestamp >= 0
  ));

  return {
    hasPreview: Boolean(firstClip),
    status: video.preview_generation_status || 'pending',
    firstTimestamp: firstClip ? firstClip.timestamp : null
  };
}


/**
 * Project a video row into a list/card DTO
 * @param {Object} video - Database row for the video
 * @returns {Object} Card DTO with only client-safe fields
 */
function toVideoCard(video) {
  return {
    id: video.id,
    title: video.title,
    duration: video.duration,
    width: video.width,
    height: video.height,
    added_date: video.added_date,
    thumbnail_path: video.thumbnail_path,
    recorded_at: video.recorded_at,
    death_timestamps: video.death_timestamps,
    ...videoFacts(video.title, video.metadata),
    preview: toPreviewDescriptor(video)
  };
}

/**
 * Project a video row into a detail DTO
 * @param {Object} video - Database row for the video
 * @returns {Object} Detail DTO with only client-safe fields
 */
function toVideoDetail(video) {
  return {
    id: video.id,
    title: video.title,
    duration: video.duration,
    width: video.width,
    height: video.height,
    added_date: video.added_date,
    recorded_at: video.recorded_at,
    death_timestamps: video.death_timestamps,
    ...videoFacts(video.title, video.metadata)
  };
}

module.exports = { toVideoCard, toVideoDetail };
