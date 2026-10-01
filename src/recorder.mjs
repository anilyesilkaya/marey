// Orchestrates a recording: wait an optional delay, capture frames at a fixed
// rate for a fixed duration, write each frame + the composed contact sheet to
// disk, and return metadata. Pure Node builtins only.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { captureFrame, captureBurst, startCaptureStream } from './capture.mjs';
import { encodePng, decodePng } from './png.mjs';
import { composeContactSheet } from './contactsheet.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a filesystem-friendly timestamp (YYYYMMDD-HHMMSS) from a Date.
function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

// Record the screen.
//
// opts: {
//   seconds, fps, region, title, delay, cols, thumbWidth,
//   outputDir  // base directory for captures (default: <cwd>/captures)
// }
//
// Returns {
//   dir, frameCount, fps, seconds, region, elapsedMs,
//   contactSheetPath, latestPath, frames: [{ path, index, timeMs }],
//   contactSheet: { width, height, buffer }
// }
export async function record(opts = {}) {
  const seconds = clampNumber(opts.seconds, 5, 0.1, 120);
  const fps = clampNumber(opts.fps, 2, 0.1, 60);
  const region = opts.region || 'primary';
  const title = opts.title;
  const delay = clampNumber(opts.delay, 0, 0, 60);
  // `detail` is a convenience preset for the overview-vs-legibility trade-off.
  // A single returned image has a fixed resolution budget, so fewer columns +
  // wider thumbnails = more readable per frame. Explicit cols/thumbWidth always
  // win over the preset.
  const detail = normalizeDetail(opts.detail);
  const preset = DETAIL_PRESETS[detail];
  const cols = Math.round(clampNumber(opts.cols, preset.cols, 1, 16));
  const thumbWidth = Math.round(clampNumber(opts.thumbWidth, preset.thumbWidth, 64, 1920));
  const baseDir = opts.outputDir || path.join(process.cwd(), 'captures');

  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const intervalMs = 1000 / fps;

  if (delay > 0) await sleep(delay * 1000);

  const started = new Date();
  const dir = path.join(baseDir, stamp(started));
  await mkdir(dir, { recursive: true });

  const startTime = Date.now();

  // Capture the whole burst first (at the real frame rate on Windows this runs
  // in one process), then persist frames. Writing during capture would steal
  // time from the capture loop and skew the frame rate.
  const captured = await captureBurst({ region, title, frames: totalFrames, intervalMs });
  const elapsedMs = Date.now() - startTime;

  const frames = [];
  const frameMeta = [];
  const writes = [];

  captured.forEach((frame, i) => {
    const index = i + 1;
    const { image, timeMs } = frame;
    const buffer = encodePng(image.width, image.height, image.data);
    const name = `frame_${String(index).padStart(3, '0')}_${String(Math.round(timeMs)).padStart(5, '0')}ms.png`;
    const framePath = path.join(dir, name);
    writes.push(writeFile(framePath, buffer));
    frames.push({ image, index, timeMs });
    frameMeta.push({ path: framePath, index, timeMs });
  });

  await Promise.all(writes);

  const sheet = composeContactSheet(frames, { cols, thumbWidth });
  const sheetBuffer = encodePng(sheet.width, sheet.height, sheet.data);
  const contactSheetPath = path.join(dir, 'contactsheet.png');
  await writeFile(contactSheetPath, sheetBuffer);

  const latestPath = path.join(baseDir, 'latest-contactsheet.png');
  await writeFile(latestPath, sheetBuffer);

  return {
    dir,
    frameCount: frames.length,
    fps,
    seconds,
    region,
    title: title || null,
    elapsedMs,
    contactSheetPath,
    latestPath,
    cols,
    thumbWidth,
    detail,
    frames: frameMeta,
    contactSheet: { width: sheet.width, height: sheet.height, buffer: sheetBuffer },
  };
}

// --- open-ended recording sessions -----------------------------------------
//
// start_recording / stop_recording let the user control timing: the agent
// starts a capture stream on the user's cue, the user performs the interaction,
// then the agent stops it and gets a contact sheet. Only one session may be
// active at a time (the server serves a single user).

let activeSession = null;

const MAX_SESSION_FRAMES = 600; // safety cap so a forgotten session cannot grow without bound

// Begin an open-ended recording. Frames are captured at `fps` and written to
// disk as they arrive. Returns { dir, fps, region, title }.
export async function startRecording(opts = {}) {
  if (activeSession) {
    throw new Error(
      `A recording is already in progress (started in ${activeSession.dir}, ` +
      `${activeSession.frames.length} frames so far). Call stop_recording first.`
    );
  }

  const fps = clampNumber(opts.fps, 2, 0.1, 60);
  const region = opts.region || 'primary';
  const title = opts.title;
  const detail = normalizeDetail(opts.detail);
  const preset = DETAIL_PRESETS[detail];
  const cols = Math.round(clampNumber(opts.cols, preset.cols, 1, 16));
  const thumbWidth = Math.round(clampNumber(opts.thumbWidth, preset.thumbWidth, 64, 1920));
  const baseDir = opts.outputDir || path.join(process.cwd(), 'captures');
  const delay = clampNumber(opts.delay, 0, 0, 60);
  const intervalMs = 1000 / fps;

  if (delay > 0) await sleep(delay * 1000);

  const started = new Date();
  const dir = path.join(baseDir, stamp(started));
  await mkdir(dir, { recursive: true });

  const session = {
    dir, baseDir, fps, region, title: title || null,
    detail, cols, thumbWidth,
    frames: [],   // { image, index, timeMs }
    writes: [],
    capped: false,
    stream: null,
  };

  session.stream = startCaptureStream({ region, title, intervalMs }, (frame, count) => {
    if (count > MAX_SESSION_FRAMES) {
      if (!session.capped) {
        session.capped = true;
        session.stream.stop();
      }
      return;
    }
    const index = count;
    const { image, timeMs } = frame;
    const buffer = encodePng(image.width, image.height, image.data);
    const name = `frame_${String(index).padStart(3, '0')}_${String(Math.round(timeMs)).padStart(5, '0')}ms.png`;
    const framePath = path.join(dir, name);
    session.writes.push(writeFile(framePath, buffer).catch(() => {}));
    session.frames.push({ image, index, timeMs, path: framePath });
  });

  activeSession = session;
  return { dir, fps, region, title: title || null, detail };
}

// Stop the active recording and compose a contact sheet. Returns the same shape
// as record().
export async function stopRecording() {
  const session = activeSession;
  if (!session) {
    throw new Error('No recording is in progress. Call start_recording first.');
  }
  activeSession = null;

  await session.stream.stop();
  await Promise.all(session.writes);

  const streamError = session.stream.error;
  if (session.frames.length === 0) {
    throw new Error(
      `Recording captured no frames${streamError ? `: ${streamError}` : ''}. ` +
      `The capture backend may have failed to start.`
    );
  }

  const frames = session.frames.map((f) => ({ image: f.image, index: f.index, timeMs: f.timeMs }));
  const frameMeta = session.frames.map((f) => ({ path: f.path, index: f.index, timeMs: f.timeMs }));
  const elapsedMs = frames.length ? frames[frames.length - 1].timeMs : 0;

  const sheet = composeContactSheet(frames, { cols: session.cols, thumbWidth: session.thumbWidth });
  const sheetBuffer = encodePng(sheet.width, sheet.height, sheet.data);
  const contactSheetPath = path.join(session.dir, 'contactsheet.png');
  await writeFile(contactSheetPath, sheetBuffer);

  const latestPath = path.join(session.baseDir, 'latest-contactsheet.png');
  await writeFile(latestPath, sheetBuffer);

  return {
    dir: session.dir,
    frameCount: frames.length,
    fps: session.fps,
    seconds: elapsedMs / 1000,
    region: session.region,
    title: session.title,
    elapsedMs,
    capped: session.capped,
    contactSheetPath,
    latestPath,
    cols: session.cols,
    thumbWidth: session.thumbWidth,
    detail: session.detail,
    frames: frameMeta,
    contactSheet: { width: sheet.width, height: sheet.height, buffer: sheetBuffer },
  };
}

// Report whether a recording is active (for status / diagnostics).
export function recordingStatus() {
  if (!activeSession) return { active: false };
  return {
    active: true,
    dir: activeSession.dir,
    frameCount: activeSession.frames.length,
    fps: activeSession.fps,
    region: activeSession.region,
    title: activeSession.title,
  };
}

// Capture a single frame and write it to disk.
export async function capture(opts = {}) {
  const region = opts.region || 'primary';
  const title = opts.title;
  const baseDir = opts.outputDir || path.join(process.cwd(), 'captures');
  const delay = clampNumber(opts.delay, 0, 0, 60);

  if (delay > 0) await sleep(delay * 1000);

  const now = new Date();
  const dir = path.join(baseDir, stamp(now));
  await mkdir(dir, { recursive: true });

  const image = await captureFrame({ region, title });
  const buffer = encodePng(image.width, image.height, image.data);
  const framePath = path.join(dir, 'capture.png');
  await writeFile(framePath, buffer);

  const latestPath = path.join(baseDir, 'latest-capture.png');
  await writeFile(latestPath, buffer);

  return {
    dir,
    path: framePath,
    latestPath,
    width: image.width,
    height: image.height,
    region,
    title: title || null,
    image: { width: image.width, height: image.height, buffer },
  };
}

// Fetch a single full-resolution frame from a prior recording and return its
// original PNG bytes. The contact sheet is a downscaled overview; when it is
// not enough, this returns the real pixels — over MCP, so it works even for
// clients with no filesystem access.
//
// opts: either
//   { dir, index }  — recording directory + 1-based frame number, or
//   { path }        — a direct path to a frame PNG (e.g. from a record result)
//
// Returns { path, width, height, buffer }.
export async function getFrame(opts = {}) {
  let framePath = opts.path;

  if (!framePath) {
    if (!opts.dir) {
      throw new Error('getFrame requires either `path`, or `dir` plus `index`');
    }
    const index = Math.round(clampNumber(opts.index, NaN, 1, 100000));
    if (!Number.isFinite(index)) {
      throw new Error('getFrame requires a positive `index` when `dir` is given');
    }
    framePath = await resolveFrameInDir(opts.dir, index);
  }

  let buffer;
  try {
    buffer = await readFile(framePath);
  } catch {
    throw new Error(`Frame not found: ${framePath}`);
  }

  // Validate it is a decodable PNG, and report true dimensions, without
  // re-encoding — we return the original bytes untouched.
  const { width, height } = decodePng(buffer);
  return { path: framePath, width, height, buffer };
}

// Find the frame file for a 1-based index inside a recording directory. Frames
// are named frame_NNN_*.png; match on the zero-padded index.
async function resolveFrameInDir(dir, index) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`Recording directory not found: ${dir}`);
  }
  const prefix = `frame_${String(index).padStart(3, '0')}_`;
  const match = entries.find((name) => name.startsWith(prefix) && name.endsWith('.png'));
  if (!match) {
    const frameCount = entries.filter((n) => /^frame_\d+_.*\.png$/.test(n)).length;
    throw new Error(`No frame #${index} in ${dir} (recording has ${frameCount} frames)`);
  }
  return path.join(dir, match);
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Map the `detail` preset to a (cols, thumbWidth) pair. A returned image has a
// fixed resolution budget that is split across columns, so legibility comes
// from fewer, wider cells — not from thumbWidth alone.
//
//   overview (default) — many frames at a glance; small cells
//   high               — fewer, larger cells; UI text usually readable
//   max                — one column, full-width cells; closest to raw frames
const DETAIL_PRESETS = {
  overview: { cols: 4, thumbWidth: 480 },
  high: { cols: 2, thumbWidth: 760 },
  max: { cols: 1, thumbWidth: 1280 },
};

function normalizeDetail(detail) {
  if (!detail) return 'overview';
  const key = String(detail).toLowerCase();
  return DETAIL_PRESETS[key] ? key : 'overview';
}
