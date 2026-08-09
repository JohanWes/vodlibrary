const { toVideoCard, toVideoDetail } = require('../../lib/client-video');

// Full row shaped like the videos table plus extraneous fields that must never
// reach the client: absolute path, full metadata, preview internals, secrets.
const fullRow = {
  id: 42,
  title: 'Test Stream',
  path: '/mnt/media/vods/Test Stream.mp4',
  duration: 3725,
  width: 1920,
  height: 1080,
  added_date: '2026-08-01 12:00:00',
  thumbnail_path: '/data/thumbnails/42.jpg',
  death_timestamps: '[{"time": 120}, {"time": 900}]',
  preview_clips: '{"clips":[{"timestamp":0,"path":"/previews/internal.mp4","size":1234}]}',
  preview_generation_status: 'completed',
  preview_generation_date: '2026-08-01 12:05:00',
  metadata: { description: 'internal enrichment' },
  full_metadata: { everything: true },
  internal_secret: 'do-not-leak'
};

describe('toVideoCard', () => {
  test('projects exactly the card fields with formatted duration', () => {
    expect(toVideoCard(fullRow)).toEqual({
      id: 42,
      title: 'Test Stream',
      duration: 3725,
      width: 1920,
      height: 1080,
      added_date: '2026-08-01 12:00:00',
      thumbnail_path: '/data/thumbnails/42.jpg',
      death_timestamps: '[{"time": 120}, {"time": 900}]',
      duration_formatted: '62:05',
      preview: {
        hasPreview: true,
        status: 'completed',
        firstTimestamp: 0
      }
    });
  });

  test('omits path, metadata, preview internals, and unknown fields', () => {
    const card = toVideoCard(fullRow);
    const sensitiveKeys = [
      'path',
      'metadata',
      'full_metadata',
      'preview_clips',
      'preview_generation_status',
      'preview_generation_date',
      'internal_secret'
    ];
    for (const key of sensitiveKeys) {
      expect(card).not.toHaveProperty(key);
    }
    expect(Object.keys(card).sort()).toEqual([
      'added_date',
      'death_timestamps',
      'duration',
      'duration_formatted',
      'height',
      'id',
      'preview',
      'thumbnail_path',
      'title',
      'width'
    ]);
  });

  test('preserves null values instead of inventing data', () => {
    const card = toVideoCard({
      id: 7,
      title: 'No metadata yet',
      path: '/mnt/media/vods/No Metadata Yet.mp4',
      duration: null,
      width: null,
      height: null,
      added_date: '2026-08-02 09:00:00',
      thumbnail_path: null,
      death_timestamps: null,
      preview_generation_status: 'pending'
    });

    expect(card).toEqual({
      id: 7,
      title: 'No metadata yet',
      duration: null,
      width: null,
      height: null,
      added_date: '2026-08-02 09:00:00',
      thumbnail_path: null,
      death_timestamps: null,
      duration_formatted: null,
      preview: {
        hasPreview: false,
        status: 'pending',
        firstTimestamp: null
      }
    });
  });

  test('treats malformed preview metadata as unavailable', () => {
    const card = toVideoCard({
      ...fullRow,
      preview_clips: '{bad json'
    });

    expect(card.preview).toEqual({
      hasPreview: false,
      status: 'completed',
      firstTimestamp: null
    });
  });

  test('does not mutate the input row', () => {
    const row = { ...fullRow };
    toVideoCard(row);

    expect(row).not.toHaveProperty('duration_formatted');
    expect(row).toEqual(fullRow);
  });
});

describe('toVideoDetail', () => {
  test('projects exactly the detail fields with formatted duration', () => {
    expect(toVideoDetail(fullRow)).toEqual({
      id: 42,
      title: 'Test Stream',
      duration: 3725,
      width: 1920,
      height: 1080,
      added_date: '2026-08-01 12:00:00',
      death_timestamps: '[{"time": 120}, {"time": 900}]',
      duration_formatted: '62:05'
    });
  });

  test('omits path, metadata, preview internals, and unknown fields', () => {
    const detail = toVideoDetail(fullRow);
    const sensitiveKeys = [
      'path',
      'metadata',
      'full_metadata',
      'preview_clips',
      'preview_generation_status',
      'preview_generation_date',
      'internal_secret'
    ];
    for (const key of sensitiveKeys) {
      expect(detail).not.toHaveProperty(key);
    }
    expect(Object.keys(detail).sort()).toEqual([
      'added_date',
      'death_timestamps',
      'duration',
      'duration_formatted',
      'height',
      'id',
      'title',
      'width'
    ]);
  });

  test('preserves null values instead of inventing data', () => {
    const detail = toVideoDetail({
      id: 7,
      title: 'No metadata yet',
      path: '/mnt/media/vods/No Metadata Yet.mp4',
      duration: null,
      width: null,
      height: null,
      added_date: '2026-08-02 09:00:00',
      death_timestamps: null,
      preview_generation_status: 'pending'
    });

    expect(detail).toEqual({
      id: 7,
      title: 'No metadata yet',
      duration: null,
      width: null,
      height: null,
      added_date: '2026-08-02 09:00:00',
      death_timestamps: null,
      duration_formatted: null
    });
  });

  test('does not mutate the input row', () => {
    const row = { ...fullRow };
    toVideoDetail(row);

    expect(row).not.toHaveProperty('duration_formatted');
    expect(row).toEqual(fullRow);
  });
});
