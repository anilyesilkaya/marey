// Recorder API — the stable surface the MCP server and CLI call.
//
// As of Phase 1 this is a thin ADAPTER over SessionController (src/session.mjs),
// which owns recording state, lifecycle transitions, limits, and finalisation.
// The function signatures here are unchanged so the existing MCP tools (record,
// start_recording, stop_recording, capture, get_frame) and the CLI keep working;
// the reliability guarantees now come from the controller:
//   - "ready" means a verified first frame, not just a spawned backend;
//   - duration is a monotonic deadline, not a frame count;
//   - a single-active guard is acquired synchronously (no racing starts);
//   - each session gets a unique directory;
//   - memory is bounded (originals stream to disk; only metadata is retained);
//   - finalisation runs once and is idempotent;
//   - startup/stream/disk failures are preserved and reported.
//
// capture() and get_frame() are single-shot and do not need a session, so they
// stay as direct, dependency-free helpers.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { captureFrame } from './capture.mjs';
import { encodePng, decodePng } from './png.mjs';
import { crop as cropImage } from './image.mjs';
import { SessionController } from './session.mjs';
import {
  createControlServer, openBrowser,
  writeControlRegistry, clearControlRegistry,
} from './control.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a filesystem-friendly timestamp (YYYYMMDD-HHMMSS) from a Date.
function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

// One shared controller per process so record() and the open-ended session API
// honour a single-active guard between them (one screen, one user → one capture
// at a time). Created lazily, keyed on the base output directory: the real
// callers (server, CLI) use the default, and an explicit, different outputDir is
// honoured only while idle so a one-off directory override still works.
let sharedController = null;

function controllerFor(outputDir) {
  const baseDir = outputDir || path.join(process.cwd(), 'captures');
  if (!sharedController) {
    sharedController = new SessionController({ outputDir: baseDir });
  } else if (outputDir && sharedController.baseDir !== baseDir && !sharedController.active) {
    sharedController = new SessionController({ outputDir: baseDir });
  }
  return sharedController;
}

// Pass through controller options the recorder public API accepts.
function captureOpts(opts) {
  return {
    fps: opts.fps,
    region: opts.region,
    title: opts.title,
    delay: opts.delay,
    detail: opts.detail,
    cols: opts.cols,
    thumbWidth: opts.thumbWidth,
    // Replay (Phase 4): arm a rolling ring buffer and set its look-back window.
    replay: opts.replay,
    windowMs: opts.windowMs,
  };
}

// A finalised controller result is a superset of the legacy record() shape
// (dir, frameCount, fps, seconds, region, title, elapsedMs, contactSheetPath,
// latestPath, cols, thumbWidth, detail, frames[], contactSheet{width,height,
// buffer}). Return it when we have renderable evidence; otherwise surface the
// recorded failure so the caller can report it.
function resultOrThrow(result) {
  if (result.contactSheet) return result;
  const detail = result.errors && result.errors.length
    ? `: ${result.errors.join('; ')}`
    : '. The capture backend may have failed to start.';
  throw new Error(`Recording captured no frames${detail}`);
}

// Record the screen for a fixed duration and return a contact sheet. See
// SessionController.record for the timing/limit semantics.
//
// opts: { seconds, fps, region, title, delay, cols, thumbWidth, detail, outputDir }
export async function record(opts = {}) {
  const controller = controllerFor(opts.outputDir);
  const result = await controller.record({ ...captureOpts(opts), seconds: opts.seconds });
  return resultOrThrow(result);
}

// --- open-ended recording sessions -----------------------------------------
//
// start_recording / stop_recording let the user control timing: the agent
// starts a capture stream on the user's cue, the user performs the interaction,
// then the agent stops it and gets a contact sheet. The controller's
// single-active guard enforces one session at a time.

// Begin an open-ended recording and resolve once a first valid frame is
// captured (ready), or reject with the real startup failure. Returns
// { dir, fps, region, title, detail }.
export async function startRecording(opts = {}) {
  const controller = controllerFor(opts.outputDir);
  const started = await controller.start(captureOpts(opts));
  return {
    dir: started.dir,
    fps: started.fps,
    region: started.region,
    title: started.title,
    detail: started.detail,
  };
}

// Stop the active recording and compose a contact sheet. Returns the same shape
// as record(). Errors if no recording is in progress.
export async function stopRecording() {
  if (!sharedController || !sharedController.active) {
    throw new Error('No recording is in progress. Call start_recording first.');
  }
  const result = await sharedController.stop();
  return resultOrThrow(result);
}

// --- observe: human-in-the-loop observation --------------------------------
//
// observe() is the headline Phase-2 workflow: the agent starts a recording, the
// user reproduces a bug, and signals "done" via a local control page (or the
// `marey finish` CLI). This call BLOCKS until that signal — a synchronous
// pending request, not an MCP Task — then returns evidence exactly like
// record()/stopRecording(). A bounded max-duration safety deadline guarantees
// it always returns.
//
// opts: capture opts + { maxSeconds (default 120), open (default true),
//   outputDir, onUrl(url) — notified with the control-page URL for a stderr
//   fallback when no browser can be opened }.
//
// Returns a record()-shaped result with an extra `observation` field recording
// how it ended ('finished' | 'cancelled' | 'timed-out').
export async function observe(opts = {}) {
  const controller = controllerFor(opts.outputDir);
  const maxSeconds = clampNumber(opts.maxSeconds, 120, 1, 600);

  // Start the recording first: if the backend cannot produce a frame, fail now
  // (before opening a browser the user would stare at for nothing).
  const started = await controller.start(captureOpts(opts));

  // Stand up the local control surface, reporting live status from the session.
  const control = createControlServer({
    title: 'Marey',
    getStatus: () => {
      const s = controller.status(started.sessionId);
      return {
        frameCount: s.frameCount ?? 0,
        elapsedMs: s.elapsedMs ?? 0,
        region: s.region,
        title: s.title,
        fps: s.fps,
      };
    },
  });

  let result;
  try {
    await control.listen();
    writeControlRegistry(control, { sessionId: started.sessionId, startedAt: started.startedAt });

    // Offer the control page. If no browser can be opened (headless/remote),
    // the caller surfaces the URL via onUrl so the user can open it manually.
    const opened = opts.open === false ? false : openBrowser(control.url);
    if (typeof opts.onUrl === 'function') opts.onUrl(control.url, opened);

    // Bounded safety deadline: settle as 'timed-out' if the user never acts.
    const timer = setTimeout(() => control.settle('timed-out'), maxSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    // Block until the human finishes/cancels or the deadline fires.
    const outcome = await control.outcome;
    clearTimeout(timer);

    // Map the human's intent onto the controller: Finish/timeout → stop (keep
    // evidence); Cancel → cancel (still keeps partial evidence, flagged).
    const raw = outcome === 'cancelled'
      ? await controller.cancel(started.sessionId)
      : await controller.stop(started.sessionId, { reason: outcome });

    result = { ...resultOrThrow(raw), observation: outcome };
  } finally {
    clearControlRegistry();
    await control.close().catch(() => {});
  }
  return result;
}

// --- replay: rolling buffer + markers (instant-replay / dashcam) ------------
//
// replay() is the Phase-4 workflow for "it just did the thing — grab that".
// Instead of recording from a start cue, it keeps only the last `windowSeconds`
// of frames in a rolling ring buffer (older unpinned frames are evicted from
// disk), so an arbitrarily long session stays bounded. Whenever the user clicks
// MARK (or runs `marey mark`), the frames currently in the window are pinned and
// saved as a clip; each mark yields its own clip. Finish/Cancel ends it and
// composes one contact sheet per clip.
//
// Like observe() this BLOCKS until the user finishes/cancels or the max-duration
// safety deadline fires. opts: capture opts + { windowSeconds (ring-buffer
// look-back, default from limits), maxSeconds, open, outputDir, onUrl }.
//
// Returns a record()-shaped result with `clips` (each with its own contactSheet)
// and an `observation` field ('finished' | 'cancelled' | 'timed-out').
export async function replay(opts = {}) {
  const controller = controllerFor(opts.outputDir);
  const maxSeconds = clampNumber(opts.maxSeconds, 600, 1, 1800);
  const windowMs = opts.windowSeconds != null
    ? clampNumber(opts.windowSeconds, 20, 1, 120) * 1000
    : undefined;

  // Arm the rolling buffer first: if the backend cannot produce a frame, fail
  // now (before opening a browser the user would stare at for nothing).
  const started = await controller.start({ ...captureOpts(opts), replay: true, windowMs });

  const control = createControlServer({
    title: 'Marey replay',
    instructions:
      'Reproduce the issue, then click Mark to save the last few seconds. ' +
      'Mark as many times as you need, then click Finish.',
    getStatus: () => {
      const s = controller.status(started.sessionId);
      return {
        frameCount: s.frameCount ?? 0,
        elapsedMs: s.elapsedMs ?? 0,
        region: s.region,
        title: s.title,
        fps: s.fps,
        markCount: s.markCount ?? 0,
      };
    },
    // Mark pins the current look-back window into a clip; recording continues.
    onMark: () => controller.mark(started.sessionId),
  });

  let result;
  try {
    await control.listen();
    writeControlRegistry(control, {
      sessionId: started.sessionId, startedAt: started.startedAt, mode: 'replay',
    });

    const opened = opts.open === false ? false : openBrowser(control.url);
    if (typeof opts.onUrl === 'function') opts.onUrl(control.url, opened);

    const timer = setTimeout(() => control.settle('timed-out'), maxSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    const outcome = await control.outcome;
    clearTimeout(timer);

    // Finish/timeout → stop (keep clips); Cancel → cancel (still composes clips
    // from whatever was pinned, flagged as cancelled).
    const raw = outcome === 'cancelled'
      ? await controller.cancel(started.sessionId)
      : await controller.stop(started.sessionId, { reason: outcome });

    result = { ...replayResultOrThrow(raw), observation: outcome };
  } finally {
    clearControlRegistry();
    await control.close().catch(() => {});
  }
  return result;
}

// A replay result is valid if it produced at least one clip with a contact
// sheet; otherwise surface the recorded failure (no frames / all evicted).
function replayResultOrThrow(result) {
  if (result.clips && result.clips.some((c) => c.contactSheet)) return result;
  const detail = result.errors && result.errors.length
    ? `: ${result.errors.join('; ')}`
    : '. No frames were captured, or the backend failed to start.';
  throw new Error(`Replay produced no clips${detail}`);
}

// Report whether a recording is active (for status / diagnostics).
export function recordingStatus() {
  if (!sharedController) return { active: false };
  const s = sharedController.status();
  if (!s.active) return { active: false };
  return {
    active: true,
    dir: s.dir,
    frameCount: s.frameCount,
    fps: s.fps,
    region: s.region,
    title: s.title,
  };
}

// Capture a single frame and write it to disk. Single-shot: no session needed.
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
// PNG bytes. The contact sheet is a downscaled overview; when it is not enough,
// this returns the real pixels — over MCP, so it works even for clients with no
// filesystem access.
//
// Progressive inspection (Phase 3): pass a crop rectangle to zoom into part of
// a frame at FULL resolution without transferring the whole image. The agent
// reasons about the region from the downscaled sheet, so the rectangle may be
// given in normalized fractions (0..1) of the frame — unambiguous regardless of
// the frame's true pixel size — or in absolute pixels.
//
// opts: a frame locator —
//   { dir, index }  — recording directory + 1-based frame number, or
//   { path }        — a direct path to a frame PNG (e.g. from a record result)
// plus an optional crop —
//   { crop: { x, y, w, h, normalized } }  — sub-rectangle; when normalized is
//     true, x/y/w/h are fractions of the frame (e.g. {x:0.5,y:0,w:0.5,h:0.5}
//     = top-right quadrant); otherwise they are pixels. Out-of-bounds rects are
//     clipped to the frame.
//
// Returns { path, width, height, buffer, source?: {width,height}, crop? }.
// With no crop, the ORIGINAL bytes are returned untouched (byte-identical).
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

  // No crop requested: validate it is a decodable PNG, report true dimensions,
  // and return the original bytes untouched (no re-encode, byte-identical).
  if (!opts.crop) {
    const { width, height } = decodePng(buffer);
    return { path: framePath, width, height, buffer };
  }

  // Crop requested: decode, resolve the rectangle (normalized or pixels) against
  // the true frame size, crop at full resolution, re-encode.
  const img = decodePng(buffer);
  const rect = resolveCrop(opts.crop, img.width, img.height);
  const cropped = cropImage(img, rect.x, rect.y, rect.w, rect.h);
  const out = encodePng(cropped.width, cropped.height, cropped.data);
  return {
    path: framePath,
    width: cropped.width,
    height: cropped.height,
    buffer: out,
    source: { width: img.width, height: img.height },
    crop: { x: rect.x, y: rect.y, w: cropped.width, h: cropped.height },
  };
}

// Resolve a crop request against the true frame dimensions. Accepts normalized
// fractions (0..1) or absolute pixels; clamps the origin into the frame and the
// size to what remains, guaranteeing a non-empty in-bounds rectangle.
function resolveCrop(cropOpt, frameW, frameH) {
  if (!cropOpt || typeof cropOpt !== 'object') {
    throw new Error('getFrame `crop` must be an object { x, y, w, h, normalized? }');
  }
  const normalized = !!cropOpt.normalized;
  const sx = normalized ? frameW : 1;
  const sy = normalized ? frameH : 1;
  let x = Math.round(toNumber(cropOpt.x, 0) * sx);
  let y = Math.round(toNumber(cropOpt.y, 0) * sy);
  // Default size: the remainder of the frame from (x,y) when w/h are omitted.
  let w = cropOpt.w == null ? frameW - x : Math.round(toNumber(cropOpt.w, 0) * sx);
  let h = cropOpt.h == null ? frameH - y : Math.round(toNumber(cropOpt.h, 0) * sy);
  x = Math.max(0, Math.min(x, frameW - 1));
  y = Math.max(0, Math.min(y, frameH - 1));
  w = Math.max(1, Math.min(w, frameW - x));
  h = Math.max(1, Math.min(h, frameH - y));
  return { x, y, w, h };
}

function toNumber(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
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
