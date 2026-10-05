// Shared session controller: one owner for recording state, lifecycle
// transitions, limits, the capture worker, and finalisation.
//
// Why this exists (baseline failure modes it fixes):
//   - Start reported success before any frame was captured. Here "ready" means
//     the backend started AND a first valid frame arrived (or a bounded startup
//     timeout / backend failure is reported instead).
//   - Duration was a frame-count target, so a slow backend extended a recording
//     indefinitely. Here duration is a MONOTONIC deadline; a slow backend just
//     yields fewer frames, and actual timing is reported separately.
//   - Concurrent starts both won. Here the single-active guard is acquired
//     SYNCHRONOUSLY, before the first await, so two starts cannot both own it.
//   - Session directories collided per-second. Here each session has a unique
//     id (timestamp + random suffix) and its own directory.
//   - Memory grew with decoded frames. Here only metadata is retained during
//     capture; original encoded PNG bytes go straight to disk and frames are
//     decoded again (from disk) only for the selected contact-sheet cells.
//   - Stop was neither idempotent nor concurrency-safe. Here finalisation runs
//     once; concurrent/repeat stops share it; a completed session returns its
//     stored result.
//   - Failures were swallowed. Here startup/stream/disk failures are preserved,
//     reported, and (when persistent) terminate the session.
//
// The controller is clock- and backend-injected so timing and capture are fully
// deterministic under test (see src/clock.mjs createFakeClock).

import * as realFs from 'node:fs/promises';
import path from 'node:path';
import { createRealClock } from './clock.mjs';
import { createDefaultBackend, pngDimensions } from './capture.mjs';
import { decodePng, encodePng } from './png.mjs';
import { composeContactSheet } from './contactsheet.mjs';

export const MANIFEST_VERSION = 1;

// Conservative, documented default limits. All are overridable per controller.
export const DEFAULT_LIMITS = {
  startupTimeoutMs: 10_000,   // max wait for the first valid frame before failing
  maxTimedMs: 120_000,        // hard cap on a timed `record` duration
  maxSessionMs: 300_000,      // hard cap on an open-ended session (safety deadline)
  maxFrames: 1800,            // cap on frames retained for a session
  maxDiskBytes: 2 * 1024 ** 3,// cap on total bytes written for a session (2 GiB)
  maxInputPixels: 8192 * 8192,// reject an absurdly large source frame
  maxComposeFrames: 36,       // cap on cells composed into one contact sheet
  maxOutputPixels: 24_000_000,// cap on the composed contact-sheet pixel count
  shutdownTimeoutMs: 5_000,   // max wait for the capture worker to stop
};

// Explicit lifecycle states. `armed` is reserved for the Phase 4 replay buffer.
export const STATES = {
  STARTING: 'starting',
  RECORDING: 'recording',
  FINALISING: 'finalising',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

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

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Collision-resistant session id: wall-clock stamp + random suffix. Date/random
// are fine here (this is runtime code, not a replayable workflow script).
function makeSessionId(wall) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${wall.getFullYear()}${p(wall.getMonth() + 1)}${p(wall.getDate())}` +
    `-${p(wall.getHours())}${p(wall.getMinutes())}${p(wall.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

export class SessionController {
  constructor(opts = {}) {
    this.clock = opts.clock || createRealClock();
    this.backend = opts.backend || createDefaultBackend(this.clock);
    this.baseDir = opts.outputDir || path.join(process.cwd(), 'captures');
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    // Filesystem seam: real node:fs/promises by default; tests inject an
    // in-memory fs so a fake clock drives the whole session deterministically.
    this.fs = opts.fs || realFs;
    this.active = null;              // the one in-flight/owning session, or null
    this.results = new Map();        // sessionId -> finalised result (bounded)
    this.maxResults = opts.maxResults || 20;
  }

  // Report status for a session (or the active one). Exposed over MCP.
  status(sessionId) {
    const s = sessionId
      ? (this.active && this.active.id === sessionId ? this.active : null)
      : this.active;
    if (!s) {
      if (sessionId && this.results.has(sessionId)) {
        const r = this.results.get(sessionId);
        return { active: false, sessionId, state: r.state, frameCount: r.frameCount };
      }
      return { active: false };
    }
    return {
      active: s.state === STATES.STARTING || s.state === STATES.RECORDING,
      sessionId: s.id,
      state: s.state,
      dir: s.dir,
      frameCount: s.committedCount(),
      fps: s.fps,
      region: s.region,
      title: s.title,
      startedAt: s.startedWall ? s.startedWall.toISOString() : null,
      elapsedMs: s.state === STATES.RECORDING ? Math.round(this.clock.now() - s.startMono) : null,
      requestedMs: s.durationMs,
    };
  }

  // Begin a recording and resolve once it is READY (first valid frame acquired),
  // or reject with the real startup failure. For a timed recording pass
  // durationMs; the controller auto-finalises at the monotonic deadline and the
  // caller can await session.done for the full result. For an open-ended
  // recording omit durationMs (a maxSessionMs safety deadline still applies).
  //
  // The single-active guard is acquired SYNCHRONOUSLY here, before any await.
  async start(opts = {}) {
    if (this.active) {
      const a = this.active;
      throw new Error(
        `A recording is already in progress (session ${a.id}, state ${a.state}, ` +
        `${a.committedCount()} frames). Call stop/cancel first.`
      );
    }

    const fps = clampNumber(opts.fps, 2, 0.1, 60);
    const region = opts.region || 'primary';
    const title = opts.title || null;
    const detail = normalizeDetail(opts.detail);
    const preset = DETAIL_PRESETS[detail];
    const cols = Math.round(clampNumber(opts.cols, preset.cols, 1, 16));
    const thumbWidth = Math.round(clampNumber(opts.thumbWidth, preset.thumbWidth, 64, 1920));
    const delayMs = clampNumber(opts.delay, 0, 0, 60) * 1000;
    const intervalMs = 1000 / fps;

    const timed = Number.isFinite(opts.durationMs);
    const durationMs = timed
      ? clampNumber(opts.durationMs, 5000, 100, this.limits.maxTimedMs)
      : null;
    // Every session has a hard deadline so a stalled/zero-frame backend cannot
    // run forever: timed → its duration; open-ended → the session safety cap.
    const deadlineMs = timed ? durationMs : this.limits.maxSessionMs;

    const startedWall = this.clock.wall();
    const id = makeSessionId(startedWall);
    const dir = path.join(this.baseDir, id);

    // Build the session object and CLAIM ownership synchronously.
    const session = {
      id, dir, baseDir: this.baseDir,
      state: STATES.STARTING,
      region, title, fps, intervalMs, detail, cols, thumbWidth,
      timed, durationMs, deadlineMs,
      startedWall, startMono: this.clock.now(),
      frames: [],          // { index, timeMs, path, bytes, width, height, written }
      writes: [],          // in-flight write promises
      warnings: [], errors: [],
      diskBytes: 0,
      stream: null,
      deadlineTimer: null,
      watchdogTimer: null,
      cancelled: false,
      finalisePromise: null,
      result: null,
      lastFrameMono: null,
      committedCount() { return this.frames.filter((f) => f.written).length; },
    };
    let resolveDone;
    session.done = new Promise((r) => { resolveDone = r; });
    session._resolveDone = resolveDone;
    this.active = session;

    try {
      await this.fs.mkdir(dir, { recursive: true });
      await this._writeManifest(session);

      if (delayMs > 0) await this._wait(delayMs);
      if (session.cancelled) {
        return this._finalise(session, STATES.CANCELLED, 'cancelled-before-start');
      }

      await this._awaitReady(session);
      return {
        sessionId: id,
        dir,
        state: session.state,
        ready: session.state === STATES.RECORDING,
        region, title, fps, detail,
        startedAt: startedWall.toISOString(),
        backend: this.backend.name,
        timed,
        requestedSeconds: timed ? durationMs / 1000 : null,
      };
    } catch (err) {
      // Startup failed: record it, finalise as failed, release the guard. Tag
      // the error with the session id/dir so the caller can still retrieve the
      // finalised result (warnings, manifest) for this failed session.
      session.errors.push(String(err && err.message ? err.message : err));
      await this._finalise(session, STATES.FAILED, 'startup-failed');
      if (err && typeof err === 'object') {
        err.sessionId = id;
        err.dir = dir;
      }
      throw err;
    }
  }

  // Start the capture worker and resolve when the first VALID frame is acquired,
  // the backend fails/exits, or the startup timeout elapses — whichever first.
  // "Ready" = backend initialised + a valid frame acquired (per the product
  // contract); it does not wait on that frame's disk write.
  _awaitReady(session) {
    return new Promise((resolve, reject) => {
      const settle = (fn, arg) => {
        if (session._readySettled) return;
        session._readySettled = true;
        this.clock.clearTimeout(session._startupTimer);
        fn(arg);
      };

      // Called by _onFrame when the first valid frame is acquired.
      session._markReady = () => settle(() => {
        session.state = STATES.RECORDING;
        this._armDeadline(session);
        this._armWatchdog(session);
        this._writeManifest(session).catch(() => {});
        resolve();
      });

      // Called by _onFrame / exit-check on a fatal startup error.
      session._failReady = (err) => settle(reject, err);

      session._startupTimer = this.clock.setTimeout(() => {
        const detail = session.stream && session.stream.error ? `: ${session.stream.error}` : '';
        settle(reject, new Error(
          `Capture did not produce a frame within ${this.limits.startupTimeoutMs}ms` +
          `${detail}. The capture backend may have failed to start or the target ` +
          `may be unavailable.`
        ));
      }, this.limits.startupTimeoutMs);

      session.stream = this.backend.startStream(
        { region: session.region, title: session.title, intervalMs: session.intervalMs },
        (frame, count) => this._onFrame(session, frame, count),
      );

      // If the backend closes before any valid frame, that is a fatal startup
      // error. Event-driven (no polling) so it is deterministic under a fake clock.
      Promise.resolve(session.stream.whenClosed && session.stream.whenClosed()).then(() => {
        if (session._readySettled) return;
        if (!session._firstFrameSeen) {
          settle(reject, new Error(
            `Capture backend exited before producing a frame` +
            `${session.stream.error ? `: ${session.stream.error}` : ''}.`
          ));
        }
      });
    });
  }

  // Per-frame handler: enforce limits, validate the PNG, write original bytes to
  // disk, record metadata. Never retains decoded pixels. The first VALID frame
  // flips the session to RECORDING via _markReady.
  _onFrame(session, frame, count) {
    if (session.state === STATES.FINALISING || session.state === STATES.COMPLETED ||
        session.state === STATES.CANCELLED || session.state === STATES.FAILED) {
      return; // ignore late frames after finalisation began
    }
    // Cap on ACCEPTED frames (bounds the metadata array and queued writes
    // immediately, not after async writes settle).
    if (session.frames.length >= this.limits.maxFrames) {
      if (!session._cappedFrames) {
        session._cappedFrames = true;
        session.warnings.push(`Frame cap reached (${this.limits.maxFrames}); stopping capture.`);
        this.stop(session.id, { reason: 'frame-cap-reached' }).catch(() => {});
      }
      return;
    }
    if (session.diskBytes + frame.png.length > this.limits.maxDiskBytes) {
      if (!session._cappedDisk) {
        session._cappedDisk = true;
        session.warnings.push(`Disk budget reached (${this.limits.maxDiskBytes} bytes); stopping capture.`);
        this.stop(session.id, { reason: 'disk-cap-reached' }).catch(() => {});
      }
      return;
    }

    // Validate the PNG and read its geometry cheaply (no full decode). Dropped
    // frames are counted; the warning is pushed only ONCE per cause so a backend
    // emitting bad frames forever cannot grow the warnings array without bound.
    let dims;
    try {
      dims = pngDimensions(frame.png);
    } catch (err) {
      session.droppedUndecodable = (session.droppedUndecodable || 0) + 1;
      if (session.droppedUndecodable === 1) {
        session.warnings.push(`Dropped undecodable frame(s): ${err.message}`);
      }
      return;
    }
    if (dims.width * dims.height > this.limits.maxInputPixels) {
      session.droppedOversized = (session.droppedOversized || 0) + 1;
      if (session.droppedOversized === 1) {
        session.warnings.push(
          `Dropped oversized frame(s) (${dims.width}×${dims.height} exceeds the ` +
          `${this.limits.maxInputPixels}px input limit).`
        );
      }
      return;
    }

    // A valid frame has been acquired → the session is READY. Signalled here,
    // on acquisition, independent of whether this frame's disk write succeeds.
    session._firstFrameSeen = true;
    session._markReady && session._markReady();

    const index = session.frames.length + 1;
    const name = `frame_${String(index).padStart(3, '0')}_${String(Math.round(frame.timeMs)).padStart(5, '0')}ms.png`;
    const framePath = path.join(session.dir, name);
    const entry = {
      index, timeMs: frame.timeMs, path: framePath,
      bytes: frame.png.length, width: dims.width, height: dims.height,
      written: false,
    };
    session.frames.push(entry);
    session.diskBytes += frame.png.length;
    session.lastFrameMono = this.clock.now();

    const w = this.fs.writeFile(framePath, frame.png).then(
      () => { entry.written = true; session._writeFailStreak = 0; },
      (err) => {
        // Disk write failed: do NOT advertise a frame file that was never
        // written. Record it so the failure is visible, reclaim its budget, and
        // terminate the session if writes are persistently failing.
        entry.writeError = String(err && err.message ? err.message : err);
        session.diskBytes -= frame.png.length;
        session.errors.push(`Failed to write ${name}: ${entry.writeError}`);
        session._writeFailStreak = (session._writeFailStreak || 0) + 1;
        if (session._writeFailStreak >= 5 && !session._diskFailing) {
          session._diskFailing = true;
          session.errors.push('Persistent disk-write failures; terminating session.');
          this.stop(session.id, { reason: 'disk-write-failures', state: STATES.FAILED }).catch(() => {});
        }
      },
    );
    session.writes.push(w);
  }

  // Arm the monotonic duration deadline. When it fires, finalisation begins —
  // regardless of how many frames were captured. Called synchronously from
  // _markReady, so clock.now() here is the readiness instant.
  //
  // A TIMED recording's duration is measured from READINESS (the first valid
  // frame), so backend/PowerShell cold-start never eats into the requested
  // window: "record 2s" yields ~2s of actual captured motion rather than 2s
  // minus startup. An OPEN-ENDED session instead gets its maxSessionMs safety
  // cap measured from session creation, so total wall-time stays bounded no
  // matter how long startup took.
  _armDeadline(session) {
    session.recordingStartMono = this.clock.now();
    const remaining = session.timed
      ? session.durationMs
      : session.deadlineMs - (this.clock.now() - session.startMono);
    session.deadlineTimer = this.clock.setTimeout(() => {
      const reason = session.timed ? 'duration-reached' : 'max-session-reached';
      this.stop(session.id, { reason }).catch(() => {});
    }, Math.max(0, remaining));
  }

  // Watch for the backend closing unexpectedly mid-recording. Event-driven via
  // whenClosed() (no polling), so it is deterministic under a fake clock. If the
  // stream closes while we are still RECORDING, that is an unexpected exit.
  _armWatchdog(session) {
    if (!session.stream || !session.stream.whenClosed) return;
    session.stream.whenClosed().then(() => {
      if (session.state !== STATES.RECORDING) return; // expected close during stop
      session.errors.push(
        `Capture backend exited unexpectedly${session.stream.error ? `: ${session.stream.error}` : ''}.`
      );
      this.stop(session.id, { reason: 'backend-exited', state: STATES.FAILED }).catch(() => {});
    });
  }

  // Stop the active (or named) recording and finalise. Idempotent and
  // concurrency-safe: repeat/concurrent stops share one finalisation; stopping
  // an already-finalised session returns its stored result.
  async stop(sessionId, opts = {}) {
    const s = this._resolveSession(sessionId);
    if (!s) {
      if (sessionId && this.results.has(sessionId)) return this.results.get(sessionId);
      throw new Error('No recording is in progress. Call start first.');
    }
    const terminalState = opts.state ||
      (opts.reason === 'cancelled' ? STATES.CANCELLED : STATES.COMPLETED);
    return this._finalise(s, terminalState, opts.reason || 'stopped');
  }

  // Cancel: stop promptly and record the cancellation. Partial evidence already
  // written to disk is preserved and still composed if any frames exist.
  async cancel(sessionId) {
    const s = this._resolveSession(sessionId);
    if (!s) {
      if (sessionId && this.results.has(sessionId)) return this.results.get(sessionId);
      throw new Error('No recording is in progress.');
    }
    s.cancelled = true;
    return this._finalise(s, STATES.CANCELLED, 'cancelled');
  }

  _resolveSession(sessionId) {
    if (sessionId) return this.active && this.active.id === sessionId ? this.active : null;
    return this.active;
  }

  // Single finalisation path. Runs once per session; concurrent callers get the
  // same promise. Stops the capture worker, flushes writes, composes a contact
  // sheet from whatever was captured, persists the manifest, releases the guard.
  _finalise(session, terminalState, reason) {
    if (session.finalisePromise) return session.finalisePromise;

    session.finalisePromise = (async () => {
      session.state = STATES.FINALISING;
      if (session.deadlineTimer) this.clock.clearTimeout(session.deadlineTimer);
      if (session._startupTimer) this.clock.clearTimeout(session._startupTimer);

      // Stop the capture worker, bounded so a stuck child cannot hang us.
      if (session.stream) {
        await this._withTimeout(
          Promise.resolve(session.stream.stop()),
          this.limits.shutdownTimeoutMs,
        ).catch((e) => session.warnings.push(`Capture shutdown issue: ${e.message}`));
      }
      // Flush pending frame writes.
      await Promise.allSettled(session.writes);

      const committed = session.frames.filter((f) => f.written);
      const streamErr = session.stream && session.stream.error;
      if (streamErr && !session.errors.includes(streamErr)) session.warnings.push(`Backend: ${streamErr}`);

      // Compose a contact sheet if we have any frames; preserve the session on
      // composition/write failure rather than losing it.
      let contactSheet = null;
      let contactSheetPath = null;
      let latestPath = null;
      let composeWarning = null;
      let finalState = terminalState;

      if (committed.length > 0) {
        try {
          const built = await this._composeFromDisk(session, committed);
          contactSheet = built.contactSheet;
          contactSheetPath = built.contactSheetPath;
          latestPath = built.latestPath;
          if (built.warning) session.warnings.push(built.warning);
        } catch (err) {
          composeWarning = `Contact sheet composition failed: ${err.message}`;
          session.errors.push(composeWarning);
          finalState = STATES.FAILED;
        }
      } else if (terminalState === STATES.COMPLETED) {
        // Completed with zero frames is really a failure.
        finalState = STATES.FAILED;
        session.errors.push(
          `Recording captured no frames${streamErr ? `: ${streamErr}` : ''}.`
        );
      }

      session.state = finalState;
      const elapsedMs = committed.length ? committed[committed.length - 1].timeMs : 0;
      const result = this._buildResult(session, committed, {
        reason, elapsedMs, contactSheet, contactSheetPath, latestPath,
      });
      session.result = result;

      await this._writeManifest(session, { reason, result }).catch((e) => {
        session.warnings.push(`Manifest write failed: ${e.message}`);
      });

      // Release the guard and remember the result for later retrieval.
      if (this.active === session) this.active = null;
      this._rememberResult(session.id, result);
      session._resolveDone(result);
      return result;
    })();

    return session.finalisePromise;
  }

  // Decode the selected frames from disk and compose the contact sheet. Bounds
  // the composed cell count and output pixels so a long session cannot allocate
  // a giant image (Phase 3 replaces this with content-aware selection).
  async _composeFromDisk(session, committed) {
    let selected = committed;
    let warning = null;
    const maxCells = this.limits.maxComposeFrames;
    if (committed.length > maxCells) {
      selected = evenSample(committed, maxCells);
      warning = `Contact sheet shows ${selected.length} of ${committed.length} frames (evenly sampled); all frames remain on disk.`;
    }

    // Clamp thumbWidth so the composed sheet stays within the output-pixel budget.
    const first = decodePng(await this.fs.readFile(selected[0].path));
    const aspect = first.height / first.width;
    const rows = Math.ceil(selected.length / session.cols);
    let thumbWidth = session.thumbWidth;
    const outPixels = () => {
      const w = session.cols * thumbWidth;
      const h = rows * (thumbWidth * aspect + 24);
      return w * h;
    };
    while (thumbWidth > 96 && outPixels() > this.limits.maxOutputPixels) {
      thumbWidth = Math.round(thumbWidth * 0.85);
    }

    const frames = [];
    frames.push({ image: first, index: selected[0].index, timeMs: selected[0].timeMs });
    for (let i = 1; i < selected.length; i++) {
      const img = decodePng(await this.fs.readFile(selected[i].path));
      frames.push({ image: img, index: selected[i].index, timeMs: selected[i].timeMs });
    }

    const sheet = composeContactSheet(frames, { cols: session.cols, thumbWidth });
    const sheetBuffer = encodePng(sheet.width, sheet.height, sheet.data);
    const contactSheetPath = path.join(session.dir, 'contactsheet.png');
    await this.fs.writeFile(contactSheetPath, sheetBuffer);
    const latestPath = path.join(session.baseDir, 'latest-contactsheet.png');
    await this.fs.writeFile(latestPath, sheetBuffer).catch(() => {});

    return {
      contactSheet: { width: sheet.width, height: sheet.height, buffer: sheetBuffer, thumbWidth },
      contactSheetPath, latestPath, warning,
    };
  }

  _buildResult(session, committed, extra) {
    const actualSeconds = extra.elapsedMs / 1000;
    const spacings = [];
    for (let i = 1; i < committed.length; i++) {
      spacings.push(committed[i].timeMs - committed[i - 1].timeMs);
    }
    const meanSpacing = spacings.length
      ? spacings.reduce((a, b) => a + b, 0) / spacings.length : null;
    const maxGap = spacings.length ? Math.max(...spacings) : null;
    const actualFps = actualSeconds > 0 ? committed.length / actualSeconds : null;

    return {
      sessionId: session.id,
      state: session.state,
      completionReason: extra.reason,
      dir: session.dir,
      manifestPath: path.join(session.dir, 'manifest.json'),
      backend: this.backend.name,
      frameCount: committed.length,
      // Requested vs actual timing, reported separately (never conflated).
      fps: session.fps,
      requested: { seconds: session.timed ? session.durationMs / 1000 : null, fps: session.fps },
      actual: {
        seconds: actualSeconds,
        fps: actualFps,
        meanFrameSpacingMs: meanSpacing,
        maxFrameGapMs: maxGap,
      },
      seconds: actualSeconds,   // legacy field (actual)
      elapsedMs: extra.elapsedMs,
      region: session.region,
      title: session.title,
      requestedRegion: session.region,
      cols: session.cols,
      thumbWidth: extra.contactSheet ? extra.contactSheet.thumbWidth : session.thumbWidth,
      detail: session.detail,
      capped: !!session._cappedFrames || !!session._cappedDisk,
      warnings: session.warnings.slice(),
      errors: session.errors.slice(),
      contactSheetPath: extra.contactSheetPath,
      latestPath: extra.latestPath,
      frames: committed.map((f) => ({ path: f.path, index: f.index, timeMs: f.timeMs })),
      contactSheet: extra.contactSheet,
    };
  }

  // Write the versioned manifest atomically (temp file + rename), so a crash
  // mid-write cannot leave a half-written manifest, and a completed/interrupted
  // session remains inspectable after a restart.
  async _writeManifest(session, extra = {}) {
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      sessionId: session.id,
      state: session.state,
      backend: this.backend.name,
      target: { requestedRegion: session.region, title: session.title },
      capture: {
        fps: session.fps,
        intervalMs: session.intervalMs,
        detail: session.detail,
        cols: session.cols,
        thumbWidth: session.thumbWidth,
      },
      timing: {
        startedAt: session.startedWall.toISOString(),
        timed: session.timed,
        requestedMs: session.durationMs,
        deadlineMs: session.deadlineMs,
      },
      frames: session.frames
        .filter((f) => f.written)
        .map((f) => ({ index: f.index, timeMs: f.timeMs, bytes: f.bytes, width: f.width, height: f.height, file: path.basename(f.path) })),
      warnings: session.warnings,
      errors: session.errors,
      completionReason: extra.reason || null,
    };
    const file = path.join(session.dir, 'manifest.json');
    const tmp = `${file}.tmp`;
    await this.fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await this.fs.rename(tmp, file);
  }

  _rememberResult(id, result) {
    this.results.set(id, result);
    while (this.results.size > this.maxResults) {
      const oldest = this.results.keys().next().value;
      this.results.delete(oldest);
    }
  }

  getResult(sessionId) {
    return this.results.get(sessionId) || null;
  }

  // Resolve to a session's final result: the live `done` promise if it is still
  // active/finalising, otherwise its stored result. Rejects if unknown.
  awaitResult(sessionId) {
    if (this.active && this.active.id === sessionId) return this.active.done;
    const stored = this.results.get(sessionId);
    if (stored) return Promise.resolve(stored);
    return Promise.reject(new Error(`Unknown session: ${sessionId}`));
  }

  // Convenience for a fixed-duration recording: start, then await the deadline
  // finalisation and return the full result. Routed through the SAME ownership
  // rules as an open-ended session (a timed record cannot bypass the guard).
  async record(opts = {}) {
    const seconds = clampNumber(opts.seconds, 5, 0.1, this.limits.maxTimedMs / 1000);
    const started = await this.start({ ...opts, durationMs: seconds * 1000 });
    return this.awaitResult(started.sessionId);
  }

  // Cancel any active session and await capture-worker shutdown — called on
  // client disconnect / termination signals. Preserves partial evidence.
  async shutdown() {
    if (this.active) {
      await this.cancel(this.active.id).catch(() => {});
    }
  }

  // Clock-based wait used for `delay`. A cancel during the delay is handled by
  // the post-wait cancelled check in start() (finalisation is idempotent).
  _wait(ms) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = this.clock.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (v) => { if (!done) { done = true; this.clock.clearTimeout(t); resolve(v); } },
        (e) => { if (!done) { done = true; this.clock.clearTimeout(t); reject(e); } },
      );
    });
  }
}

// Evenly sample `count` items from `arr`, always keeping the first and last.
function evenSample(arr, count) {
  if (arr.length <= count) return arr.slice();
  const out = [];
  const step = (arr.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) out.push(arr[Math.round(i * step)]);
  // Dedupe (rounding can collide) while preserving order.
  const seen = new Set();
  return out.filter((f) => (seen.has(f.index) ? false : (seen.add(f.index), true)));
}

// Read a persisted manifest for a recording directory (for restart inspection).
export async function readManifest(dir, fs = realFs) {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

export { DETAIL_PRESETS, normalizeDetail, clampNumber };
