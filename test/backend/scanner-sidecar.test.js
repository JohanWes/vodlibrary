// Sidecar (Warcraft Recorder JSON) parsing: legacy `deaths[]` and
// schema_version 1 `timeline[kind=death]`, slim stored metadata, and no
// re-parsing when the sidecar is unchanged.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../lib/thumbnail', () => ({
  generateThumbnail: jest.fn().mockResolvedValue('/thumbnails/x.jpg'),
  thumbnailExists: jest.fn().mockReturnValue(true),
  getThumbnailPath: jest.fn().mockReturnValue('/thumbnails/x.jpg'),
  getThumbnailFilePath: jest.fn(() => '/nonexistent-thumbs/x.jpg')
}));
jest.mock('../../lib/ffmpeg', () => ({
  probeVideo: jest.fn().mockResolvedValue({ duration: 315, width: 2560, height: 1080 }),
  nonEmptyFileSize: jest.fn().mockResolvedValue(0)
}));
jest.mock('../../lib/preview', () => ({
  queuePreviewGeneration: jest.fn().mockResolvedValue({ status: 'skipped' }),
  isPreviewQueued: jest.fn().mockReturnValue(false),
  getPreviewFilePaths: jest.fn(() => []),
  getConfig: jest.fn(() => ({ previewDir: '/nonexistent-previews' })),
  stop: jest.fn()
}));

const database = require('../../db/database');
const { normalizeSidecarMetadata, extractDeathTimestamps, readSidecar } = require('../../lib/sidecar');
const { scanLibrary, getScanStatus, processVideoFile } = require('../../lib/scanner');
const { refreshSidecar } = require('../../lib/watcher');

// Trimmed copies of real sidecars (structure unchanged, big fields shortened).
const LEGACY_SIDECAR = {
  category: 'Raids',
  zoneID: 0,
  zoneName: 'Unknown Raid',
  flavour: 'Retail',
  encounterID: 3122,
  encounterName: 'The Soul Hunters',
  difficultyID: 16,
  difficulty: 'M',
  duration: 315,
  result: true,
  player: { _GUID: 'Player-1-0', _teamID: 1, _specID: 62, _name: 'Evandis', _realm: 'Ragnaros' },
  deaths: [
    { name: 'Niffe-Ragnaros-EU', specId: 102, date: '2026-01-08T18:47:54.000Z', timestamp: 47.99799990653992, friendly: true },
    { name: 'Scatan-Ragnaros-EU', specId: 269, date: '2026-01-08T18:47:58.000Z', timestamp: 51.99799990653992, friendly: true }
  ],
  combatants: [{ _GUID: 'Player-2-0', _name: 'Big' }],
  start: 1767898026000,
  uniqueHash: '446b7c6ccfa7e3c7d1c5f8d09dfbb87a'
};

const NEW_SIDECAR = {
  schema_version: 1,
  media_file: 'activity - Evandeux - Sszorak [HC] (Wipe).mp4',
  id: 'abe0e8b1-9942-4c80-842d-a2f0f9e35625',
  category: 'raids',
  flavor: 'retail',
  title: 'Evandeux - Sszorak [HC] (Wipe)',
  start_unix_ms: 1790160663350,
  duration_ms: 58059,
  outcome: 'loss',
  player: { name: 'Evandeux', realm: 'Ragnaros', guid: 'Player-3-0', class_id: null, spec_id: 262 },
  combatants: [{ name: 'Ludmage', realm: 'TwistingNether' }],
  details: { kind: 'raid', zone_id: 0, zone_name: 'Unknown Raid', encounter_id: 3420, encounter_name: 'Sszorak', difficulty_id: 15, difficulty: 'HC', boss_percent: 82 },
  timeline: [
    { shape: 'span', kind: 'bloodlust', start_ms: 5515, end_ms: 45515, label: 'Bloodlust' },
    { shape: 'point', kind: 'death', start_ms: 14068, end_ms: null, label: 'Evandeux', outcome: 'loss' },
    { shape: 'point', kind: 'death', start_ms: 18036, end_ms: null, label: 'Biomontedk', outcome: 'loss' }
  ],
  media: { fps: 60, width: null, height: null, codec: 'av1' },
  meter: { fights: [{ label: 'huge', actors: new Array(200).fill({ guid: 'x', damage: [1, 2, 3] }) }] }
};

const NEW_MYTHIC_PLUS = {
  schema_version: 1,
  category: 'mythic_plus',
  start_unix_ms: 1788616628001,
  duration_ms: 1821351,
  outcome: 'complete',
  details: { dungeon_name: 'Pit of Saron', keystone_level: 23, kind: 'dungeon', map_id: 556, zone_id: 658 },
  timeline: [{ end_ms: null, kind: 'death', label: 'Qweekm', outcome: 'loss', shape: 'point', start_ms: 803409 }],
  meter: { fights: [] }
};

describe('sidecar normalisation', () => {
  test('legacy format: death markers from deaths[].timestamp (seconds)', () => {
    expect(JSON.parse(extractDeathTimestamps(LEGACY_SIDECAR))).toEqual([47.99799990653992, 51.99799990653992]);
  });

  test('schema_version 1: death markers from timeline[kind=death].start_ms', () => {
    expect(JSON.parse(extractDeathTimestamps(NEW_SIDECAR))).toEqual([14.068, 18.036]);
    expect(JSON.parse(extractDeathTimestamps(NEW_MYTHIC_PLUS))).toEqual([803.409]);
  });

  test('no deaths -> null (unchanged column semantics)', () => {
    expect(extractDeathTimestamps({ ...LEGACY_SIDECAR, deaths: [] })).toBeNull();
    expect(extractDeathTimestamps({ ...NEW_SIDECAR, timeline: [{ kind: 'trash', start_ms: 0 }] })).toBeNull();
    expect(extractDeathTimestamps(null)).toBeNull();
  });

  test('legacy metadata keeps the fields llm.js reads and drops the rest', () => {
    const slim = normalizeSidecarMetadata(LEGACY_SIDECAR);
    expect(slim).toEqual({
      slim: 1,
      start: 1767898026000,
      duration: 315,
      category: 'Raids',
      zone: 'Unknown Raid',
      encounter: 'The Soul Hunters',
      difficulty: 'M',
      outcome: 'win',
      player: 'Evandis',
      deaths: [
        { name: 'Niffe-Ragnaros-EU', timestamp: 48 },
        { name: 'Scatan-Ragnaros-EU', timestamp: 52 }
      ]
    });
    expect(slim).not.toHaveProperty('combatants');
  });

  test('new-format metadata is normalised to the same keys, meter dropped', () => {
    const slim = normalizeSidecarMetadata(NEW_SIDECAR);
    expect(slim).toMatchObject({
      start: 1790160663350,
      duration: 58.1,
      category: 'raids',
      zone: 'Unknown Raid',
      encounter: 'Sszorak',
      difficulty: 'HC',
      outcome: 'loss',
      player: 'Evandeux',
      deaths: [{ name: 'Evandeux', timestamp: 14.1 }, { name: 'Biomontedk', timestamp: 18 }]
    });
    expect(JSON.stringify(slim)).not.toContain('meter');
    expect(JSON.stringify(slim).length).toBeLessThan(400);
    expect(normalizeSidecarMetadata(NEW_MYTHIC_PLUS)).toMatchObject({ zone: 'Pit of Saron', keystoneLevel: 23, duration: 1821.4 });
  });

  test('normalisation is idempotent and ignores non-WoW JSON', () => {
    const slim = normalizeSidecarMetadata(NEW_SIDECAR);
    expect(normalizeSidecarMetadata(JSON.parse(JSON.stringify(slim)))).toEqual(slim);
    expect(normalizeSidecarMetadata({ hello: 'world' })).toBeNull();
  });
});

describe('readSidecar and scans', () => {
  let tmp;
  let previousLibrary;
  let previousPreviews;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vodlib-sidecar-'));
    previousLibrary = process.env.VIDEO_LIBRARY;
    previousPreviews = process.env.ENABLE_PREVIEWS;
    process.env.ENABLE_PREVIEWS = 'false';
    process.env.VIDEO_LIBRARY = tmp;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.VIDEO_LIBRARY = previousLibrary;
    if (previousPreviews === undefined) delete process.env.ENABLE_PREVIEWS;
    else process.env.ENABLE_PREVIEWS = previousPreviews;
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns null when the sidecar signature is unchanged, without reading it', async () => {
    const video = path.join(tmp, 'run.mp4');
    fs.writeFileSync(video, 'x');
    fs.writeFileSync(path.join(tmp, 'run.json'), JSON.stringify(NEW_SIDECAR));

    const first = await readSidecar(video, null);
    expect(first.found).toBe(true);
    expect(first.signature).toMatch(/^\d+:\d+$/);
    expect(JSON.parse(first.deathTimestamps)).toEqual([14.068, 18.036]);

    const readSpy = jest.spyOn(fs.promises, 'readFile');
    expect(await readSidecar(video, first.signature)).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
  });

  test('missing sidecar is recorded as "none" and not reported again', async () => {
    const video = path.join(tmp, 'plain.mp4');
    fs.writeFileSync(video, 'x');
    expect(await readSidecar(video, null)).toEqual({ signature: 'none', found: false, deathTimestamps: null, metadata: null });
    expect(await readSidecar(video, 'none')).toBeNull();
  });

  test('malformed JSON keeps existing values (returns error, no signature)', async () => {
    const video = path.join(tmp, 'bad.mp4');
    fs.writeFileSync(video, 'x');
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{"deaths": [');
    const result = await readSidecar(video, null);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('a sidecar that lands while its video is still being added is applied once the row exists', async () => {
    const video = path.join(tmp, 'new.mp4');
    fs.writeFileSync(video, 'x');
    let row;
    let finishInsert;
    database.getVideoScanStateByPath.mockImplementation(async () => row);
    database.updateVideoFields.mockResolvedValue(1);
    database.addVideo.mockImplementation((_db, fields) => new Promise((resolve) => {
      finishInsert = () => {
        row = { id: 5, path: video, metadata_mtime: fields.metadata_mtime };
        resolve(5);
      };
    }));

    const adding = processVideoFile({}, video);
    while (!finishInsert) {
      await new Promise((resolve) => setImmediate(resolve)); // until the insert is in flight
    }
    fs.writeFileSync(path.join(tmp, 'new.json'), JSON.stringify(NEW_SIDECAR));
    const refreshing = refreshSidecar({}, video);
    finishInsert();

    await expect(adding).resolves.toBe(5);
    await expect(refreshing).resolves.toBe(true);
    expect(database.updateVideoFields).toHaveBeenCalledWith({}, 5, expect.objectContaining({ death_timestamps: '[14.068,18.036]' }));
    database.getVideoScanStateByPath.mockReset();
    database.addVideo.mockReset();
  });

  test('scan parses a changed sidecar once and skips it on the next scan', async () => {
    const video = path.join(tmp, 'legacy.mp4');
    fs.writeFileSync(video, 'x');
    fs.writeFileSync(path.join(tmp, 'legacy.json'), JSON.stringify(LEGACY_SIDECAR));

    const row = {
      id: 7,
      title: 'legacy',
      path: video,
      duration: 315,
      width: 2560,
      height: 1080,
      thumbnail_path: '/thumbnails/x.jpg',
      death_timestamps: null,
      preview_clips: null,
      preview_generation_status: 'completed',
      metadata_mtime: null,
      preview_attempts: 0,
      preview_source_mtime: null
    };
    database.getVideosForScan.mockResolvedValue([row]);
    database.updateVideoFields.mockResolvedValue(1);
    const readSpy = jest.spyOn(fs.promises, 'readFile');

    await scanLibrary({});
    expect(getScanStatus().updatedCount).toBe(1);
    const sidecarReads = readSpy.mock.calls.filter((call) => String(call[0]).endsWith('legacy.json'));
    expect(sidecarReads).toHaveLength(1);

    const fields = database.updateVideoFields.mock.calls[0][2];
    expect(database.updateVideoFields.mock.calls[0][1]).toBe(7);
    expect(JSON.parse(fields.death_timestamps)).toEqual([47.99799990653992, 51.99799990653992]);
    expect(JSON.parse(fields.metadata)).toMatchObject({ start: 1767898026000, duration: 315, deaths: expect.any(Array) });
    expect(fields.metadata_mtime).toMatch(/^\d+:\d+$/);

    // Second scan: stored signature matches -> no read, no write.
    database.getVideosForScan.mockResolvedValue([{ ...row, ...fields }]);
    readSpy.mockClear();
    database.updateVideoFields.mockClear();
    await scanLibrary({});
    expect(readSpy.mock.calls.filter((call) => String(call[0]).endsWith('legacy.json'))).toHaveLength(0);
    expect(database.updateVideoFields).not.toHaveBeenCalled();
    expect(getScanStatus().updatedCount).toBe(0);
  });
});
