const fs = require('fs');
const path = require('path');

// Warcraft Recorder sidecar JSON (<video name>.json next to the video), in the
// legacy format (`deaths[].timestamp` in seconds) or schema_version 1
// (`timeline[kind=death].start_ms` in milliseconds, name in `label`).

function finiteNumber(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function roundTenth(value) {
  return Math.round(value * 10) / 10;
}

/** Deaths from either format as [{name, timestamp (seconds)}]. */
function extractDeaths(data) {
  if (Array.isArray(data.deaths) && data.deaths.length > 0) {
    return data.deaths
      .filter((death) => death && finiteNumber(death.timestamp) !== undefined)
      .map((death) => ({ name: nonEmptyString(death.name) || null, timestamp: finiteNumber(death.timestamp) }));
  }
  if (Array.isArray(data.timeline)) {
    return data.timeline
      .filter((event) => event && event.kind === 'death' && finiteNumber(event.start_ms) !== undefined)
      .map((event) => ({ name: nonEmptyString(event.label) || null, timestamp: finiteNumber(event.start_ms) / 1000 }));
  }
  return [];
}

/** The `death_timestamps` column: a JSON array of seconds (read by the player), or null. */
function extractDeathTimestamps(data) {
  const timestamps = data && typeof data === 'object' ? extractDeaths(data).map((death) => death.timestamp) : [];
  return timestamps.length > 0 ? JSON.stringify(timestamps) : null;
}

/**
 * Reduce a sidecar to the small object stored in `metadata`. Only lib/llm.js
 * reads it (start, duration, deaths, plus descriptive fields for the prompt);
 * the multi-MB fields (meter, combatants, timeline) are dropped. Idempotent.
 * @returns {Object|null} null for JSON that is not a WoW recording sidecar
 */
function normalizeSidecarMetadata(data) {
  if (!data || typeof data !== 'object'
    || !(data.slim === 1 || data.schema_version !== undefined || data.zoneID || data.encounterID || data.combatants)) {
    return null;
  }
  const details = data.details && typeof data.details === 'object' ? data.details : {};
  const player = data.player && typeof data.player === 'object' ? data.player : {};

  let duration = finiteNumber(data.duration);
  if (duration === undefined && finiteNumber(data.duration_ms) !== undefined) {
    duration = roundTenth(finiteNumber(data.duration_ms) / 1000);
  }

  let outcome = nonEmptyString(data.outcome);
  if (outcome === undefined && typeof data.result === 'boolean') {
    outcome = data.result ? 'win' : 'loss';
  }

  const slim = {
    slim: 1,
    start: finiteNumber(data.start) ?? nonEmptyString(data.start) ?? finiteNumber(data.start_unix_ms),
    duration,
    category: nonEmptyString(data.category),
    zone: nonEmptyString(data.zone) || nonEmptyString(data.zoneName) || nonEmptyString(details.zone_name) || nonEmptyString(details.dungeon_name),
    encounter: nonEmptyString(data.encounter) || nonEmptyString(data.encounterName) || nonEmptyString(details.encounter_name),
    difficulty: nonEmptyString(data.difficulty) || nonEmptyString(details.difficulty),
    keystoneLevel: finiteNumber(data.keystoneLevel) ?? finiteNumber(details.keystone_level),
    outcome,
    player: nonEmptyString(data.player) || nonEmptyString(player._name) || nonEmptyString(player.name),
    deaths: extractDeaths(data).map((death) => ({ name: death.name, timestamp: roundTenth(death.timestamp) }))
  };
  return Object.fromEntries(Object.entries(slim).filter(([, value]) => value !== undefined));
}

/**
 * Stat the sidecar and, only if its "<mtimeMs>:<size>" signature differs from
 * `knownSignature`, parse it once and derive both stored values.
 * @returns {Promise<null | {error: Error} | {signature, found, deathTimestamps, metadata}>}
 *   null when unchanged; `signature` is 'none' when there is no sidecar.
 */
async function readSidecar(videoFilePath, knownSignature) {
  const parsed = path.parse(videoFilePath);
  const jsonFilePath = path.join(parsed.dir, `${parsed.name}.json`);
  let stats;
  try {
    stats = await fs.promises.stat(jsonFilePath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      console.error(`Error reading sidecar for ${videoFilePath}: ${error.message}`);
      return { error };
    }
    return knownSignature === 'none' ? null : { signature: 'none', found: false, deathTimestamps: null, metadata: null };
  }

  const signature = `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
  if (signature === knownSignature) {
    return null;
  }
  try {
    const data = JSON.parse(await fs.promises.readFile(jsonFilePath, 'utf-8'));
    const metadata = normalizeSidecarMetadata(data);
    return { signature, found: true, deathTimestamps: extractDeathTimestamps(data), metadata: metadata ? JSON.stringify(metadata) : null };
  } catch (error) {
    // Possibly still being written: keep the old values and retry next time.
    console.error(`Error reading or parsing JSON for ${videoFilePath}: ${error.message}`);
    return { error };
  }
}

module.exports = { normalizeSidecarMetadata, extractDeathTimestamps, readSidecar };
