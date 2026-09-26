const fs = require('fs');
const path = require('path');
const { deleteVideo, getVideoScanStateByPath, updateVideoFields } = require('../db/database');
const { readSidecar } = require('./sidecar');
const { parsePositiveInt } = require('./parse');
const {
  VIDEO_EXTENSIONS,
  getLibraryPaths,
  isUnder,
  isVideoFile,
  onPipelineStop,
  processVideoFile,
  removeVideoMedia,
  scanRoot,
  waitForFile
} = require('./scanner');

/** Per-key debounced task queue with bounded concurrency. */
function createWatcherQueue({ concurrency = 2, debounceMs = 500 } = {}) {
  const queue = [];
  const pendingTimers = new Map();
  const running = new Set();
  let closed = false;

  const runNext = () => {
    while (!closed && running.size < concurrency && queue.length > 0) {
      const promise = Promise.resolve()
        .then(queue.shift())
        .catch((error) => console.error('Watcher task failed:', error))
        .finally(() => {
          running.delete(promise);
          runNext();
        });
      running.add(promise);
    }
  };

  return {
    schedule(key, task) {
      if (closed) {
        return;
      }
      clearTimeout(pendingTimers.get(key));
      pendingTimers.set(key, setTimeout(() => {
        pendingTimers.delete(key);
        queue.push(task);
        runNext();
      }, debounceMs));
    },
    shutdown() {
      closed = true;
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
      queue.length = 0;
    },
    /** Resolves when the tasks running now (and those they start) have finished. */
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
    }
  };
}

/** chokidar `ignored`: dot entries below a root, and files that are neither videos nor JSON sidecars. */
function isIgnoredByWatcher(filePath, stats) {
  if (path.basename(filePath).startsWith('.')) {
    return true;
  }
  return Boolean(stats && stats.isFile() && !isVideoFile(filePath) && path.extname(filePath).toLowerCase() !== '.json');
}

function findVideoForSidecar(jsonPath) {
  const parsed = path.parse(jsonPath);
  for (const extension of VIDEO_EXTENSIONS) {
    for (const candidateExtension of [extension, extension.toUpperCase()]) {
      const candidate = path.join(parsed.dir, `${parsed.name}${candidateExtension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * The scan's unmount rule, applied to a watcher removal: a root without any
 * video file left is treated as unmounted (stray entries such as lost+found
 * on the bare mount point don't count), so an unmount's unlink storm deletes
 * nothing. Deleting the last video of a root is picked up by the next scan
 * that finds files there. Limitation: a separately mounted subdirectory of a
 * root cannot be told apart from a deleted one; its rows are removed.
 */
async function rootHasVideos(filePath, roots) {
  const root = roots.find((candidate) => isUnder(filePath, candidate));
  if (!root) {
    return false;
  }
  const result = await scanRoot(root, { firstOnly: true });
  return result.ok && result.files.length > 0;
}

/**
 * Handle a removed video file: delete its row and generated media, unless it
 * reappeared or its library root looks unmounted.
 * @returns {Promise<number|null>} removed video id
 */
async function removeVideoFile(db, filePath, roots = getLibraryPaths()) {
  if (fs.existsSync(filePath)) {
    return null;
  }
  if (!(await rootHasVideos(filePath, roots))) {
    console.warn(`Ignoring removal of ${filePath}: its library path looks unmounted.`);
    return null;
  }
  const row = await getVideoScanStateByPath(db, filePath);
  if (!row) {
    return null;
  }
  await deleteVideo(db, row.id);
  await removeVideoMedia(filePath, row.preview_clips);
  return row.id;
}

/** Re-read a video's sidecar after a `.json` add/change. */
async function refreshSidecar(db, videoPath) {
  // The sidecar often lands while the new video is still being added; wait
  // for that row instead of finding none and dropping the update.
  await waitForFile(videoPath);
  const row = await getVideoScanStateByPath(db, videoPath);
  const sidecar = row ? await readSidecar(videoPath, row.metadata_mtime) : null;
  if (!sidecar || sidecar.error) {
    return false;
  }
  await updateVideoFields(db, row.id, {
    metadata_mtime: sidecar.signature,
    death_timestamps: sidecar.deathTimestamps,
    metadata: sidecar.metadata
  });
  return true;
}

/**
 * Watch the library for added/removed videos and changed sidecars. The
 * watcher is closed by stopMediaPipeline().
 * @param {{onAdd?: (filePath, videoId) => any, onDelete?: (videoId, filePath) => any}} options
 * @returns {{watcher, queue, close: () => Promise<void>} | null}
 */
function startLibraryWatcher(db, {
  onAdd,
  onDelete,
  roots = getLibraryPaths(),
  concurrency = parsePositiveInt(process.env.WATCHER_CONCURRENCY, 2),
  debounceMs = Math.max(0, Number.parseInt(process.env.WATCHER_DEBOUNCE_MS ?? '500', 10) || 0),
  stabilityThresholdMs = 2000
} = {}) {
  if (!roots || roots.length === 0) {
    console.warn('VIDEO_LIBRARY environment variable not set or empty. File watcher not started.');
    return null;
  }

  const chokidar = require('chokidar');
  const queue = createWatcherQueue({ concurrency: Math.max(1, concurrency), debounceMs });
  const watcher = chokidar.watch(roots, {
    ignored: isIgnoredByWatcher,
    persistent: true,
    ignoreInitial: true, // the startup scan handles existing files
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 100 }
  });

  const onSidecar = (filePath) => {
    const videoPath = path.extname(filePath).toLowerCase() === '.json' ? findVideoForSidecar(filePath) : null;
    if (videoPath) {
      queue.schedule(`sidecar:${videoPath}`, () => refreshSidecar(db, videoPath));
    }
  };

  watcher
    .on('add', (filePath) => {
      if (!isVideoFile(filePath)) {
        onSidecar(filePath);
        return;
      }
      queue.schedule(filePath, async () => {
        const videoId = await processVideoFile(db, filePath);
        await onAdd?.(filePath, videoId);
      });
    })
    .on('change', onSidecar)
    .on('unlink', (filePath) => {
      if (isVideoFile(filePath)) {
        queue.schedule(filePath, async () => {
          const removedId = await removeVideoFile(db, filePath, roots);
          if (removedId !== null) {
            await onDelete?.(removedId, filePath);
          }
        });
      }
    })
    .on('error', (error) => console.error(`Watcher error: ${error}`));

  console.log(`File watcher is running for: ${roots.join(', ')}`);

  const close = async () => {
    unregister();
    queue.shutdown();
    await watcher.close();
    await queue.idle();
  };
  const unregister = onPipelineStop(close);
  return { watcher, queue, close };
}

module.exports = {
  createWatcherQueue,
  isIgnoredByWatcher,
  removeVideoFile,
  refreshSidecar,
  startLibraryWatcher
};
