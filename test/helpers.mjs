// Test doubles for deterministic session tests: an in-memory filesystem and a
// fake capture backend driven by the fake clock. Together with createFakeClock
// these make the SessionController fully deterministic — no real timers, no real
// disk, no real screen capture.

import path from 'node:path';
import { encodePng } from '../src/png.mjs';

// --- in-memory filesystem (the subset SessionController uses) ---------------
//
// Supports mkdir/writeFile/readFile/rename and an injectable write-failure hook
// so disk-failure paths can be exercised. Paths are normalised with POSIX-style
// separators internally so the tests are platform-independent.
export function createMemoryFs(opts = {}) {
  const files = new Map();          // normalised path -> Buffer
  const dirs = new Set();
  let failWrite = opts.failWrite || null;  // (normalisedPath) => Error | null

  const norm = (p) => p.replace(/\\/g, '/');

  const fs = {
    async mkdir(dir) { dirs.add(norm(dir)); },
    async writeFile(file, data) {
      const p = norm(file);
      if (failWrite) {
        const err = failWrite(p);
        if (err) throw err;
      }
      files.set(p, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
    },
    async readFile(file, enc) {
      const p = norm(file);
      if (!files.has(p)) {
        const e = new Error(`ENOENT: no such file ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      const buf = files.get(p);
      return enc ? buf.toString(enc) : buf;
    },
    async rename(from, to) {
      const a = norm(from), b = norm(to);
      if (!files.has(a)) {
        const e = new Error(`ENOENT: no such file ${a}`);
        e.code = 'ENOENT';
        throw e;
      }
      files.set(b, files.get(a));
      files.delete(a);
    },
    async unlink(file) {
      const p = norm(file);
      if (!files.has(p)) {
        const e = new Error(`ENOENT: no such file ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      files.delete(p);
    },
    async readdir(dir) {
      const d = norm(dir).replace(/\/$/, '') + '/';
      const names = new Set();
      for (const p of files.keys()) {
        if (p.startsWith(d)) names.add(p.slice(d.length).split('/')[0]);
      }
      return [...names];
    },
    // test introspection
    _files: files,
    _dirs: dirs,
    _setFailWrite(fn) { failWrite = fn; },
    has: (p) => files.has(norm(p)),
    count: () => files.size,
    read: (p) => files.get(norm(p)),
  };
  return fs;
}

// A tiny but REAL PNG, so pngDimensions/decodePng accept frames. Varying the
// fill per frame makes consecutive frames genuinely differ (for selection tests).
export function tinyPng(w = 8, h = 6, fill = [10, 20, 30, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
  }
  return encodePng(w, h, data);
}

// --- fake capture backend ---------------------------------------------------
//
// Behaviours (via opts):
//   mode: 'normal'       — emit a frame every intervalMs (default)
//         'fail-first'   — exit immediately with an error, no frames (startup fail)
//         'zero-frames'  — never emit a frame, never exit (hangs → startup timeout)
//         'slow'         — emit a frame every (intervalMs * slowFactor)
//         'exit-after'   — emit `exitAfter` frames then exit (mid-recording crash)
//   width,height         — frame dimensions (for oversized-frame tests)
//   error                — error string surfaced via handle.error
//   fills                — explicit per-frame [r,g,b,a] fills (cycled if shorter
//                          than the frame count); lets a test script exactly
//                          which frames change, for selection tests
//
// All timing is scheduled on the injected fake clock, so clock.advance(ms)
// deterministically produces frames.
export function createFakeBackend(clock, opts = {}) {
  const mode = opts.mode || 'normal';
  const slowFactor = opts.slowFactor || 3;
  const w = opts.width || 8;
  const h = opts.height || 6;
  const fills = opts.fills || null;
  const errorText = opts.error || (mode === 'fail-first' ? 'fake backend: no capture device' : null);

  return {
    name: opts.name || 'fake',
    startStream({ intervalMs }, onFrame) {
      let count = 0;
      let exited = false;
      let stopped = false;
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      const effectiveInterval = mode === 'slow' ? intervalMs * slowFactor : intervalMs;
      const startMono = clock.now();

      if (mode === 'fail-first') {
        // Exit on the next tick with no frames.
        clock.setTimeout(() => { exited = true; resolveClosed(); }, 1);
      } else if (mode !== 'zero-frames') {
        const tick = () => {
          if (stopped || exited) return;
          count++;
          const fill = fills
            ? fills[(count - 1) % fills.length]
            : [count % 256, (count * 7) % 256, 30, 255];
          onFrame({ png: tinyPng(w, h, fill), timeMs: Math.round(clock.now() - startMono) }, count);
          if (mode === 'exit-after' && count >= (opts.exitAfter || 2)) {
            exited = true; resolveClosed();
            return;
          }
          clock.setTimeout(tick, effectiveInterval);
        };
        clock.setTimeout(tick, 0);
      }

      return {
        stop() { stopped = true; if (!exited) { exited = true; resolveClosed(); } return closed; },
        whenClosed() { return closed; },
        get exited() { return exited; },
        get framesSeen() { return count; },
        get error() { return errorText; },
      };
    },
  };
}
