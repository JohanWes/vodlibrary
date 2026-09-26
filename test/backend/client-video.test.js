const { toVideoCard, toVideoDetail } = require('../../lib/client-video');

// A row shaped like the videos table, plus fields that must never reach the client.
const fullRow = {
  id: 42,
  title: 'activity-1770069907804-c02b44ec8e9ca - Runkakuten - Ra-den [10HC] (Kill)',
  path: '/mnt/media/vods/Ra-den.mp4',
  duration: 3725,
  width: 1920,
  height: 1080,
  added_date: '2026-08-01 12:00:00',
  recorded_at: '2026-02-02T22:05:07.804Z',
  thumbnail_path: '/data/thumbnails/42.jpg',
  death_timestamps: '[120, 900]',
  preview_clips: '{"clips":[{"timestamp":0,"path":"/previews/internal.mp4","size":1234}]}',
  preview_generation_status: 'completed',
  preview_generation_date: '2026-08-01 12:05:00',
  metadata: '{"slim":1,"category":"Raids","encounter":"Ra-den","difficulty":"10HC","player":"Runkakuten"}',
  internal_secret: 'do-not-leak'
};

const facts = {
  display_title: 'Ra-den',
  difficulty: '10 Heroic',
  player: 'Runkakuten',
  outcome: { label: 'Kill', good: true }
};

test('toVideoCard projects only client-safe card fields', () => {
  expect(toVideoCard(fullRow)).toEqual({
    id: 42,
    title: fullRow.title,
    duration: 3725,
    width: 1920,
    height: 1080,
    added_date: '2026-08-01 12:00:00',
    recorded_at: '2026-02-02T22:05:07.804Z',
    thumbnail_path: '/data/thumbnails/42.jpg',
    death_timestamps: '[120, 900]',
    ...facts,
    preview: { hasPreview: true, status: 'completed', firstTimestamp: 0 }
  });
});

test('toVideoDetail projects only client-safe detail fields', () => {
  expect(toVideoDetail(fullRow)).toEqual({
    id: 42,
    title: fullRow.title,
    duration: 3725,
    width: 1920,
    height: 1080,
    added_date: '2026-08-01 12:00:00',
    recorded_at: '2026-02-02T22:05:07.804Z',
    death_timestamps: '[120, 900]',
    ...facts
  });
});
