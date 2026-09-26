const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parsePositiveInt } = require('./parse');

// ffmpeg/ffprobe runner shared by thumbnails, previews and the scanner: no
// shell, hard timeouts, lowered CPU priority, and every child tracked so a
// shutdown can kill them.

const DEFAULT_NICENESS = 10;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 60;

const activeChildren = new Set();
let partialCounter = 0;

/** Timeout for ffprobe and thumbnail ffmpeg runs (THUMBNAIL_TIMEOUT_SECONDS). */
function probeTimeoutMs() {
  return parsePositiveInt(process.env.THUMBNAIL_TIMEOUT_SECONDS, DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000;
}

function niceness() {
  const value = Number.parseInt(process.env.FFMPEG_NICENESS ?? DEFAULT_NICENESS, 10);
  return value >= 0 && value <= 19 ? value : DEFAULT_NICENESS;
}

/**
 * Resolves with stdout. Rejects on a non-zero exit (message ends with the last
 * stderr lines), on timeout (`timedOut`, child SIGKILLed) and when killed by
 * killActiveProcesses() (`shutdown`).
 */
function run(command, args, { timeoutMs = 0, nice = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      activeChildren.delete(child);
      if (!error) {
        resolve(stdout);
        return;
      }
      const name = path.basename(command);
      error.shutdown = Boolean(child.killedByShutdown);
      error.timedOut = Boolean(error.killed && timeoutMs && !error.shutdown);
      if (error.shutdown) {
        error.message = `${name} killed during shutdown`;
      } else if (error.timedOut) {
        error.message = `${name} timed out after ${Math.round(timeoutMs / 1000)}s`;
      } else if (stderr) {
        error.message = `${error.message.split('\n')[0]}: ${String(stderr).trim().split('\n').slice(-3).join(' | ')}`;
      }
      reject(error);
    });
    activeChildren.add(child);
    if (nice > 0 && child.pid) {
      try {
        os.setPriority(child.pid, nice);
      } catch (_error) {
        // best effort
      }
    }
  });
}

function runFfmpeg(args, { timeoutMs } = {}) {
  return run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
    timeoutMs,
    nice: niceness()
  });
}

async function ffprobe(filePath) {
  const stdout = await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ], { timeoutMs: probeTimeoutMs() });
  return JSON.parse(stdout);
}

/** @returns {Promise<{duration: number|null, width: number|null, height: number|null}>} */
async function probeVideo(filePath) {
  const metadata = await ffprobe(filePath);
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const duration = [metadata.format && metadata.format.duration, ...streams.map((stream) => stream.duration)]
    .find((value) => value != null && Number.isFinite(Number(value)));
  const video = streams.find((stream) => stream.codec_type === 'video') || {};
  return {
    duration: duration != null ? Number(duration) : null,
    width: video.width || null,
    height: video.height || null
  };
}

/** Kill every running ffmpeg/ffprobe child (graceful shutdown). */
function killActiveProcesses() {
  for (const child of activeChildren) {
    child.killedByShutdown = true;
    child.kill('SIGKILL');
  }
}

/** Temp file next to `finalPath`, renamed into place on success. */
function partialPathFor(finalPath) {
  partialCounter += 1;
  return `${finalPath}.partial-${process.pid}-${partialCounter}`;
}

async function removeQuietly(filePath) {
  await fs.promises.unlink(filePath).catch(() => {});
}

/** Size of a non-empty regular file, else 0. */
async function nonEmptyFileSize(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch (_error) {
    return 0;
  }
}

module.exports = {
  runFfmpeg,
  ffprobe,
  probeVideo,
  probeTimeoutMs,
  killActiveProcesses,
  getActiveProcessCount: () => activeChildren.size,
  partialPathFor,
  removeQuietly,
  nonEmptyFileSize
};
