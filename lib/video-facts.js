/**
 * Display facts for a video card, from the slim sidecar metadata (lib/sidecar.js)
 * with the recorder's file name as fallback. Recorder names look like
 *   activity-<unix ms>-<hash> - Player - Ra-den [10HC] (Kill)
 *   2025-09-11 20-07-36 - Player - Ara-Kara, City of Echoes +10 (+2) - Clipped at …
 *   Replay_2026-09-10_16-31-16
 */

const DIFFICULTY_NAMES = { M: 'Mythic', HC: 'Heroic', N: 'Normal', LFR: 'LFR' };

function parseMetadata(raw) {
  try {
    const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/** "10HC" -> "10 Heroic", "M" -> "Mythic" */
function difficultyName(raw) {
  const match = typeof raw === 'string' ? raw.match(/^(\d+)?\s*([A-Za-z]+)$/) : null;
  if (!match) return raw || null;
  const name = DIFFICULTY_NAMES[match[2].toUpperCase()] || match[2];
  return match[1] ? `${match[1]} ${name}` : name;
}

/** Local "YYYY-MM-DD HH-MM-SS" (any separators) as an ISO string */
function localTimestamp(text) {
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

function parseTitle(title) {
  const recorder = title.match(/^(?:activity-(\d{13})-\w+|\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}) - ([^-]+?) - (.+?)(?: - Clipped at .*)?$/);
  if (!recorder) {
    const replay = title.match(/^(Replay|Video)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    return {
      name: replay ? (replay[1] === 'Replay' ? 'Replay' : 'Recording') : title,
      startedAt: replay ? localTimestamp(title) : null
    };
  }
  const [, activityMs, player, rest] = recorder;
  const facts = {
    player,
    startedAt: activityMs ? new Date(Number(activityMs)).toISOString() : localTimestamp(title)
  };
  // Name [Diff] (Kill) · Dungeon +10 (+2) · 2v2 Arena (Win)
  const parts = rest.match(/^(.+?)(?: \[([^\]]+)\])?(?: \+(\d+))?(?: \(([^)]+)\))?$/);
  facts.name = parts[1];
  facts.difficulty = parts[2] || null;
  facts.keystone = parts[3] ? Number(parts[3]) : null;
  facts.result = parts[4] || null;
  return facts;
}

function outcomeFor(result, meta) {
  const upgrade = typeof result === 'string' ? result.match(/^\+(\d)$/) : null;
  if (upgrade) return Number(upgrade[1]) > 0 ? { label: `+${upgrade[1]}`, good: true } : { label: 'Depleted', good: false };
  if (result) return { label: result, good: /^(kill|win)$/i.test(result) };
  if (meta.outcome === 'win' || meta.outcome === 'loss') {
    const raid = /raid/i.test(meta.category || '');
    const good = meta.outcome === 'win';
    return { label: raid ? (good ? 'Kill' : 'Wipe') : (good ? 'Win' : 'Loss'), good };
  }
  return null;
}

/** When the recording started: sidecar start, else the file name, else the date added. */
function recordedAt(title, metadata, addedDate) {
  const meta = parseMetadata(metadata);
  const start = typeof meta.start === 'number' || typeof meta.start === 'string' ? new Date(meta.start) : null;
  if (start && !Number.isNaN(start.getTime())) return start.toISOString();
  return parseTitle(String(title || '')).startedAt || addedDate || null;
}

/**
 * @returns {{display_title: string, difficulty: string|null, player: string|null, outcome: {label: string, good: boolean}|null}}
 */
function videoFacts(title, metadata) {
  const meta = parseMetadata(metadata);
  const parsed = parseTitle(String(title || ''));
  const keystone = meta.keystoneLevel || parsed.keystone;
  return {
    display_title: meta.encounter || meta.zone || parsed.name,
    difficulty: keystone ? `+${keystone}` : difficultyName(meta.difficulty || parsed.difficulty),
    player: (typeof meta.player === 'string' && meta.player) || parsed.player || null,
    outcome: outcomeFor(parsed.result, meta)
  };
}

module.exports = { videoFacts, recordedAt };
