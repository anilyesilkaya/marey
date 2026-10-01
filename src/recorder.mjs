// Orchestrates a recording: wait an optional delay, capture frames at a fixed
// rate for a fixed duration, write each frame + the composed contact sheet to
// disk, and return metadata. Pure Node builtins only.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureFrame, captureBurst } from './capture.mjs';
import { encodePng } from './png.mjs';
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
  const cols = Math.round(clampNumber(opts.cols, 4, 1, 16));
  const thumbWidth = Math.round(clampNumber(opts.thumbWidth, 480, 64, 1920));
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
    frames: frameMeta,
    contactSheet: { width: sheet.width, height: sheet.height, buffer: sheetBuffer },
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

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
