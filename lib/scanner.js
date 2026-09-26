const fs = require('fs');
const path = require('path');
const { generateThumbnail, thumbnailExists, getThumbnailPath, getThumbnailFilePath } = require('./thumbnail');
const { probeVideo, nonEmptyFileSize } = require('./ffmpeg');
const { readSidecar } = require('./sidecar');
const { parsePositiveInt } = require('./parse');
const preview = require('./preview');
const { addVideo, deleteVideo, getVideosForScan, getVideoScanStateByPath, updateVideoFields } = require('../db/database');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.m4v', '.mpg', '.mpeg', '.ts', '.vob', '.ogv', '.3gp'
]);
const DEFAULT_PREVIEW_MAX_ATTEMPTS = 2;

// The shape is the /api/scan/status response. status: idle, running, completed or failed.
const newScanStatus = (status, message, startTime = null) => ({
  status, message, startTime, endTime: null, newCount: 0, updatedCount: 0, removedCount: 0
});
let scanStatus = newScanStatus('idle', '');

let stopRequested = false;
let currentScan = null;
const inFlightFiles = new Map(); // path -> Promise<id>
const backgroundTasks = new Set(); // preview bookkeeping promises
const pipelineClosers = new Set(); // watcher close() functions

const previewsEnabled = () => process.env.ENABLE_PREVIEWS !== 'false';
const maxPreviewAttempts = () => parsePositiveInt(process.env.PREVIEW_MAX_ATTEMPTS, DEFAULT_PREVIEW_MAX_ATTEMPTS);

function trackBackground(promise) {
  backgroundTasks.add(promise);
  promise.finally(() => backgroundTasks.delete(promise));
  return promise;
}

function getLibraryPaths() {
  return (process.env.VIDEO_LIBRARY || '').split(',').map((libraryPath) => libraryPath.trim()).filter(Boolean);
}

function isVideoFile(filename) {
  return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function isUnder(filePath, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isProtected(filePath, prefixes) {
  return prefixes.some((prefix) => path.resolve(prefix) === path.resolve(filePath) || isUnder(filePath, prefix));
}

/**
 * Walk one library root, following directory symlinks. Never throws below the
 * root: every path that could not be fully walked (broken or unreadable
 * entries, and aliases of an already-walked directory) is returned in
 * `protectedPaths`, so the rows under it are not pruned.
 * @returns {Promise<{ok: boolean, error?: Error, files: string[], protectedPaths: string[]}>}
 */
async function scanRoot(root, { firstOnly = false } = {}) {
  let rootEntries;
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) {
      return { ok: false, error: new Error('not a directory'), files: [], protectedPaths: [] };
    }
    rootEntries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error, files: [], protectedPaths: [] };
  }

  const files = [];
  const protectedPaths = [];
  const visited = new Set([await fs.promises.realpath(root).catch(() => root)]);

  const walk = async (dir, entries) => {
    for (const entry of entries) {
      if (firstOnly && files.length > 0) {
        return;
      }
      if (entry.name.startsWith('.')) {
        continue; // dot entries (.Trash-1000 etc.), same rule as the watcher
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stats = entry.isSymbolicLink() ? await fs.promises.stat(fullPath) : entry; // stat throws for broken links
        if (stats.isDirectory()) {
          const real = await fs.promises.realpath(fullPath);
          if (visited.has(real)) {
            // Symlink loop or a second path to the same directory. Rows stored
            // under this alias (the old scanner followed every link) stay.
            protectedPaths.push(fullPath);
            continue;
          }
          visited.add(real);
          await walk(fullPath, await fs.promises.readdir(fullPath, { withFileTypes: true }));
        } else if (stats.isFile() && isVideoFile(entry.name)) {
          files.push(fullPath);
        }
      } catch (error) {
        protectedPaths.push(fullPath);
        console.warn(`Skipping unreadable library entry ${fullPath}: ${error.code || error.message}`);
      }
    }
  };

  await walk(root, rootEntries);
  return { ok: true, files, protectedPaths };
}

function firstClipFile(previewClipsJson) {
  try {
    const clip = JSON.parse(previewClipsJson || 'null')?.clips?.[0];
    const base = typeof clip?.path === 'string' ? path.basename(clip.path) : '';
    return base ? path.join(preview.getConfig().previewDir, base) : null;
  } catch (_error) {
    return null;
  }
}

/** Queue a preview job and record the outcome. Never rejects. */
async function runPreviewJob(db, video, { sourceMtime = null, previousAttempts = 0 } = {}) {
  try {
    await updateVideoFields(db, video.id, {
      preview_generation_status: 'generating',
      preview_generation_date: new Date().toISOString()
    });
    const result = await preview.queuePreviewGeneration(video.path, video.id, video.duration);
    if (result.status === 'cancelled') {
      return result; // shutdown: leave 'generating'; the next start retries it
    }
    const completed = result.status === 'completed';
    const attempts = completed ? 0 : previousAttempts + (result.status === 'failed' ? 1 : 0);
    await updateVideoFields(db, video.id, {
      preview_clips: completed ? JSON.stringify(result.previewInfo) : null,
      preview_generation_status: result.status, // completed, failed or skipped (too short)
      preview_generation_date: new Date().toISOString(),
      preview_attempts: attempts,
      preview_source_mtime: sourceMtime
    });
    if (result.status === 'failed') {
      console.warn(`Preview generation failed for video ${video.title || video.id} (attempt ${attempts}/${maxPreviewAttempts()}): ${result.error}`);
    }
    return result;
  } catch (error) {
    console.error(`Error recording preview result for video ${video.title || video.id}:`, error);
    return { status: 'failed', error: error.message };
  }
}

/**
 * Decide whether an existing row needs a preview job:
 * - completed: only if the clip file is missing or empty
 * - failed: at most PREVIEW_MAX_ATTEMPTS automatic attempts per file version
 * - skipped (too short): only after the file changed
 * - pending/generating/null: yes, unless already queued in this process
 */
async function maybeSchedulePreview(db, row, filePath, mtimeMs) {
  if (!previewsEnabled() || preview.isPreviewQueued(filePath)) {
    return;
  }

  const status = row.preview_generation_status;
  const knownMtime = row.preview_source_mtime == null ? null : Number(row.preview_source_mtime);
  const fileChanged = knownMtime !== null && mtimeMs !== null && knownMtime !== mtimeMs;
  let attempts = Number(row.preview_attempts) || 0;
  let schedule = true;

  if (status === 'completed') {
    const clipFile = firstClipFile(row.preview_clips);
    schedule = !clipFile || !(await nonEmptyFileSize(clipFile));
    if (schedule) {
      console.log(`Preview clip for ${row.title || row.id} is missing or empty; regenerating`);
    }
  } else if (status === 'failed') {
    attempts = fileChanged ? 0 : attempts;
    schedule = attempts < maxPreviewAttempts();
  } else if (status === 'skipped') {
    schedule = fileChanged;
    attempts = 0;
  }

  if (schedule) {
    const video = { id: row.id, path: filePath, duration: Math.round(Number(row.duration) || 0), title: row.title };
    trackBackground(runPreviewJob(db, video, { sourceMtime: mtimeMs, previousAttempts: attempts }));
  }
}

/** Bring an existing row up to date. Returns true when user-visible fields changed. */
async function refreshExistingVideo(db, row, filePath) {
  const fields = {};
  let visible = false;

  if (!row.thumbnail_path || !thumbnailExists(filePath)) {
    const thumbnailPath = await generateThumbnail(filePath, { duration: row.duration });
    if (thumbnailPath && thumbnailPath !== row.thumbnail_path) {
      fields.thumbnail_path = thumbnailPath;
      visible = true;
    }
  }

  const sidecar = await readSidecar(filePath, row.metadata_mtime);
  if (sidecar && !sidecar.error) {
    fields.metadata_mtime = sidecar.signature;
    fields.death_timestamps = sidecar.deathTimestamps;
    fields.metadata = sidecar.metadata;
    if (sidecar.found || row.metadata_mtime != null || row.death_timestamps != null) {
      visible = true;
    }
  }

  const needsDuration = row.duration == null || !Number.isFinite(Number(row.duration));
  if (!row.width || !row.height || needsDuration) {
    try {
      const { width, height, duration } = await probeVideo(filePath);
      if (width && height && (width !== row.width || height !== row.height)) {
        fields.width = width;
        fields.height = height;
        visible = true;
      }
      if (needsDuration && Number.isFinite(duration)) {
        fields.duration = Math.round(duration);
        row = { ...row, duration: fields.duration };
        visible = true;
      }
    } catch (error) {
      console.error(`Error probing video ${filePath}: ${error.message}`);
    }
  }

  if (Object.keys(fields).length > 0) {
    await updateVideoFields(db, row.id, fields);
  }

  const mtimeMs = await fs.promises.stat(filePath).then((stats) => Math.trunc(stats.mtimeMs), () => null);
  await maybeSchedulePreview(db, row, filePath, mtimeMs);
  return visible;
}

async function processVideoFileUncached(db, filePath) {
  // A watcher 'add' for a known path must refresh, not re-insert, the row.
  const existing = await getVideoScanStateByPath(db, filePath);
  if (existing) {
    await refreshExistingVideo(db, existing, filePath);
    return existing.id;
  }

  const title = path.basename(filePath, path.extname(filePath));
  const { duration, width, height } = await probeVideo(filePath);
  if (!Number.isFinite(duration)) {
    throw new Error(`No finite duration found for ${filePath}`);
  }
  const stats = await fs.promises.stat(filePath);
  const sidecar = await readSidecar(filePath, null);
  const sidecarOk = sidecar && !sidecar.error;
  const thumbnailPath = thumbnailExists(filePath) ? getThumbnailPath(filePath) : null;

  const videoId = await addVideo(db, {
    title,
    path: filePath,
    duration: Math.round(duration),
    width,
    height,
    thumbnail_path: thumbnailPath,
    added_date: (stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime).toISOString(),
    death_timestamps: sidecarOk ? sidecar.deathTimestamps : null,
    metadata: sidecarOk ? sidecar.metadata : null,
    metadata_mtime: sidecarOk ? sidecar.signature : null
  });

  if (!thumbnailPath) {
    const generated = await generateThumbnail(filePath, { duration });
    if (generated) {
      await updateVideoFields(db, videoId, { thumbnail_path: generated });
    }
  }

  if (previewsEnabled() && !stopRequested) {
    trackBackground(runPreviewJob(db, { id: videoId, path: filePath, duration: Math.round(duration), title }, {
      sourceMtime: Math.trunc(stats.mtimeMs)
    }));
  }

  console.log(`Processed new video: ${title}`);
  return videoId;
}

/**
 * Add a video file to the database, or refresh it if the path is known.
 * Concurrent calls for the same path share one run.
 * @returns {Promise<number>} the video id
 */
function processVideoFile(db, filePath) {
  if (!inFlightFiles.has(filePath)) {
    inFlightFiles.set(filePath, processVideoFileUncached(db, filePath)
      .catch((error) => {
        console.error(`Error processing video ${filePath}:`, error);
        throw error;
      })
      .finally(() => inFlightFiles.delete(filePath)));
  }
  return inFlightFiles.get(filePath);
}

/** Resolves once no processVideoFile run for this path is in flight. */
function waitForFile(filePath) {
  return Promise.resolve(inFlightFiles.get(filePath)).then(() => {}, () => {});
}

/** Delete a video's generated thumbnail and preview files. @returns {Promise<number>} files removed */
async function removeVideoMedia(videoPath, previewClipsJson = null) {
  let removed = 0;
  for (const file of [getThumbnailFilePath(videoPath), ...preview.getPreviewFilePaths(videoPath, previewClipsJson)]) {
    try {
      await fs.promises.unlink(file);
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Could not delete ${file}: ${error.message}`);
      }
    }
  }
  return removed;
}

async function scanLibrary(db) {
  if (scanStatus.status === 'running') {
    console.log('Scan is already running.');
    return;
  }
  if (stopRequested) {
    return;
  }

  const run = runScan(db); // sets status to 'running' synchronously
  currentScan = run;
  try {
    await run;
  } finally {
    if (currentScan === run) {
      currentScan = null;
    }
  }
}

/**
 * Sync the database with the library. Rows are only pruned when their file is
 * gone from a root that was scanned successfully. Missing roots, and roots
 * that exist but hold no videos while the DB has rows under them (an
 * unmounted mount point looks exactly like that), protect all their rows, as
 * do broken symlinks, unreadable directories and directory aliases.
 */
async function runScan(db) {
  scanStatus = newScanStatus('running', 'Starting library scan...', new Date());
  console.log(scanStatus.message);
  const finish = (status, message) => {
    Object.assign(scanStatus, { status, message, endTime: new Date() });
    console.log(message);
  };

  const libraryPaths = getLibraryPaths();
  if (libraryPaths.length === 0) {
    finish('completed', 'Scan skipped: VIDEO_LIBRARY is not configured.');
    return;
  }

  try {
    const existingVideos = (await getVideosForScan(db)) || [];
    const rowsByPath = new Map(existingVideos.map((row) => [row.path, row]));
    const scannedRoots = [];
    const protectedPrefixes = [];
    const skippedRoots = [];
    const discovered = new Set();

    for (const libraryPath of libraryPaths) {
      const result = await scanRoot(libraryPath);
      if (!result.ok) {
        console.error(`Library path not available, skipping it and keeping its videos: ${libraryPath} (${result.error.code || result.error.message})`);
      } else if (result.files.length === 0 && existingVideos.some((row) => isUnder(row.path, libraryPath))) {
        console.warn(`Library path ${libraryPath} has no videos but the database has videos under it; assuming it is not mounted and keeping them.`);
      } else {
        console.log(`Found ${result.files.length} video files in ${libraryPath}`);
        scannedRoots.push(libraryPath);
        protectedPrefixes.push(...result.protectedPaths);
        result.files.forEach((file) => discovered.add(file));
        continue;
      }
      protectedPrefixes.push(libraryPath);
      skippedRoots.push(libraryPath);
    }

    if (scannedRoots.length === 0) {
      console.warn('No library path could be scanned; no videos will be removed.');
    }
    console.log(`Found ${discovered.size} total video files across all directories`);

    for (const filePath of discovered) {
      if (stopRequested) {
        finish('failed', 'Scan aborted: server is shutting down.');
        return; // never prune after an aborted scan
      }
      try {
        const row = rowsByPath.get(filePath);
        if (!row) {
          await processVideoFile(db, filePath);
          scanStatus.newCount++;
        } else if (await refreshExistingVideo(db, row, filePath)) {
          scanStatus.updatedCount++;
        }
      } catch (error) {
        console.error(`Error processing or checking video file ${filePath}:`, error);
      }
    }

    for (const video of existingVideos) {
      if (discovered.has(video.path)
        || !scannedRoots.some((root) => isUnder(video.path, root))
        || isProtected(video.path, protectedPrefixes)) {
        continue;
      }
      try {
        await deleteVideo(db, video.id);
        scanStatus.removedCount++;
        const removedFiles = await removeVideoMedia(video.path, video.preview_clips);
        console.log(`Removed missing video ${video.path} (${removedFiles} generated files deleted)`);
      } catch (error) {
        console.error(`Error removing missing video ${video.path}:`, error);
      }
    }

    finish('completed', `Scan complete: ${scanStatus.newCount} new, ${scanStatus.updatedCount} updated, ${scanStatus.removedCount} removed.`
      + (skippedRoots.length > 0 ? ` Skipped unavailable: ${skippedRoots.join(', ')}.` : ''));
  } catch (error) {
    console.error('Error scanning library:', error);
    finish('failed', `Scan failed: ${error.message}`);
  }
}

function getScanStatus() {
  return scanStatus;
}

/** Register a close function (a library watcher) to run on stopMediaPipeline(). */
function onPipelineStop(close) {
  pipelineClosers.add(close);
  return () => pipelineClosers.delete(close);
}

/**
 * Graceful shutdown: stop the running scan after the current file, drop
 * queued previews and kill ffmpeg/ffprobe children, close the watchers, then
 * wait until no scanner code will touch the database, so the caller can close
 * it. Not reversible (later scans are no-ops).
 */
async function stopMediaPipeline() {
  stopRequested = true;
  preview.stop();
  await Promise.all([...pipelineClosers].map((close) => Promise.resolve().then(close).catch((error) => {
    console.error('Error closing file watcher:', error);
  })));
  await Promise.allSettled([currentScan, ...inFlightFiles.values(), ...backgroundTasks].filter(Boolean));
}

module.exports = {
  scanLibrary,
  getScanStatus,
  stopMediaPipeline,
  processVideoFile,
  removeVideoMedia,
  isVideoFile,
  getLibraryPaths,
  // for lib/watcher.js
  VIDEO_EXTENSIONS,
  scanRoot,
  isUnder,
  waitForFile,
  onPipelineStop
};
