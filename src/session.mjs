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
import { composeWithinBudget } from './contactsheet.mjs';
import { grayscaleSignature, signatureDiff } from './image.mjs';

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
  maxAnalysisFrames: 240,     // cap on frames DECODED to choose cells (bounds cost)
  maxOutputPixels: 24_000_000,// cap on the composed contact-sheet pixel count
  maxOutputBytes: 3_500_000,  // cap on encoded sheet bytes (≈4.8 MB base64, under
                              // the ~5 MB inline-image limit most MCP clients enforce)
  shutdownTimeoutMs: 5_000,   // max wait for the capture worker to stop
  // Replay (Phase 4): a rolling ring buffer keeps only the last `replayWindowMs`
  // of frames so an arbitrarily long armed session stays bounded; a marker pins
  // the current window into a clip that eviction must not delete.
  replayWindowMs: 20_000,     // default look-back window for a replay marker
  maxReplayWindowMs: 120_000, // hard cap on a requested replay window
  maxReplaySessionMs: 1_800_000, // safety deadline for an armed replay (30 min)
  maxClips: 12,               // cap on markers (clips) retained per replay session
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
      replay: !!s.replay,
      windowMs: s.replayWindowMs || null,
      markCount: s.clips ? s.clips.length : 0,
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

    // Replay mode (Phase 4): a rolling ring buffer keeps only the last
    // `replayWindowMs` of frames, evicting (and deleting) older ones unless a
    // marker has pinned them. Because disk stays bounded by eviction, a replay
    // session may run far longer than an ordinary open-ended one.
    const replay = !!opts.replay && !timed;
    const replayWindowMs = replay
      ? clampNumber(opts.windowMs, this.limits.replayWindowMs, 1000, this.limits.maxReplayWindowMs)
      : null;

    // Every session has a hard deadline so a stalled/zero-frame backend cannot
    // run forever: timed → its duration; replay → a longer bounded cap (disk is
    // held in check by eviction); plain open-ended → the session safety cap.
    const deadlineMs = timed
      ? durationMs
      : (replay ? this.limits.maxReplaySessionMs : this.limits.maxSessionMs);

    const startedWall = this.clock.wall();
    const id = makeSessionId(startedWall);
    const dir = path.join(this.baseDir, id);

    // Build the session object and CLAIM ownership synchronously.
    const session = {
      id, dir, baseDir: this.baseDir,
      state: STATES.STARTING,
      region, title, fps, intervalMs, detail, cols, thumbWidth,
      timed, durationMs, deadlineMs,
      replay, replayWindowMs,
      clips: [],           // replay markers → { markIndex, markedAtMs, frames[] }
      evictedCount: 0,     // frames deleted by ring-buffer eviction (reporting)
      startedWall, startMono: this.clock.now(),
      frames: [],          // { index, timeMs, path, bytes, width, height, written, pinned }
      frameSeq: 0,         // monotonic frame counter (indices never reused, even
                           // after ring-buffer eviction splices entries out)
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
        replay,
        windowMs: replayWindowMs,
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

    const index = ++session.frameSeq;
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

    // Replay ring buffer: once a new frame lands, drop frames that have aged out
    // of the look-back window and are not pinned by a marker. Keeps an armed
    // session bounded on disk no matter how long it runs.
    if (session.replay) this._evictAged(session, frame.timeMs);

    const w = this.fs.writeFile(framePath, frame.png).then(
      () => {
        entry.written = true;
        session._writeFailStreak = 0;
        // If the ring buffer evicted this frame while its write was still in
        // flight, the file would otherwise land on disk untracked (a leak that
        // defeats the whole point of eviction). Delete it now that it exists.
        if (entry.evicted && this.fs.unlink) {
          this.fs.unlink(entry.path).catch(() => {});
        }
      },
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

  // Ring-buffer eviction for a replay session: drop frames older than the
  // look-back window from the newest frame, unless a marker has pinned them.
  // Pinned frames (and anything newer than the cutoff) are retained. Evicted
  // files are deleted from disk and their bytes reclaimed, so disk use stays
  // bounded by (window × fps × frame size) rather than growing without limit.
  _evictAged(session, newestTimeMs) {
    const cutoff = newestTimeMs - session.replayWindowMs;
    const kept = [];
    for (const f of session.frames) {
      if (f.pinned || f.timeMs >= cutoff) {
        kept.push(f);
        continue;
      }
      // Aged out and unpinned → delete the on-disk file and reclaim budget.
      session.evictedCount++;
      session.diskBytes -= f.bytes;
      if (f.written && this.fs.unlink) {
        this.fs.unlink(f.path).catch((e) => {
          // A failed unlink is non-fatal: the disk cap is the hard backstop.
          if (!session._evictWarned) {
            session._evictWarned = true;
            session.warnings.push(`Ring-buffer eviction could not delete a frame: ${e.message}`);
          }
        });
      } else if (!f.written) {
        // Write still in flight: tag it so the write handler deletes the file
        // once it lands, rather than leaking an untracked frame on disk.
        f.evicted = true;
      }
    }
    session.frames = kept;
  }

  // Drop a marker: snapshot the frames currently in the look-back window into a
  // clip and PIN them so eviction never deletes them. Repeatable — each mark
  // yields its own clip. A mark with an empty buffer is a no-op (warned once).
  // Returns { markIndex, markedAtMs, frameCount } for the caller/control page.
  mark(sessionId) {
    const s = this._resolveSession(sessionId);
    if (!s) throw new Error('No recording is in progress to mark.');
    if (!s.replay) throw new Error('mark is only valid for a replay session.');
    if (s.state !== STATES.RECORDING) {
      return { markIndex: s.clips.length, markedAtMs: null, frameCount: 0, note: 'not recording' };
    }

    const newest = s.frames.length ? s.frames[s.frames.length - 1].timeMs : 0;
    const cutoff = newest - s.replayWindowMs;
    const windowFrames = s.frames.filter((f) => f.timeMs >= cutoff);
    if (windowFrames.length === 0) {
      if (!s._emptyMarkWarned) {
        s._emptyMarkWarned = true;
        s.warnings.push('A marker was dropped before any frame was buffered; ignored.');
      }
      return { markIndex: s.clips.length, markedAtMs: newest, frameCount: 0 };
    }

    if (s.clips.length >= this.limits.maxClips) {
      if (!s._clipCapWarned) {
        s._clipCapWarned = true;
        s.warnings.push(`Marker cap reached (${this.limits.maxClips}); further markers are ignored.`);
      }
      return { markIndex: s.clips.length, markedAtMs: newest, frameCount: 0, note: 'clip-cap' };
    }

    for (const f of windowFrames) f.pinned = true; // survive future eviction
    const clip = {
      markIndex: s.clips.length + 1,
      markedAtMs: newest,
      windowMs: s.replayWindowMs,
      frames: windowFrames.slice(),
    };
    s.clips.push(clip);
    return { markIndex: clip.markIndex, markedAtMs: newest, frameCount: windowFrames.length };
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
      let clips = null;
      let finalState = terminalState;

      if (session.replay) {
        // Replay session: compose one contact sheet per marker (clip). A session
        // with no markers falls back to the current window as one implicit clip.
        try {
          clips = await this._composeClips(session, committed);
          const primary = clips.find((c) => c.contactSheet);
          if (primary) {
            // Mirror the first clip's sheet into the top-level fields so a
            // non-replay-aware consumer still gets one usable contact sheet.
            contactSheet = primary.contactSheet;
            contactSheetPath = primary.contactSheetPath;
            latestPath = path.join(session.baseDir, 'latest-contactsheet.png');
          }
        } catch (err) {
          composeWarning = `Replay clip composition failed: ${err.message}`;
          session.errors.push(composeWarning);
          finalState = STATES.FAILED;
        }
      } else if (committed.length > 0) {
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
        reason, elapsedMs, contactSheet, contactSheetPath, latestPath, clips,
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

  // Choose which frames to show, decode them, and compose a contact sheet that
  // fits the output budget. Three Phase-3 concerns, in order:
  //
  //   1. SELECTION — when there are more frames than cells, pick the most
  //      informative ones by visual change (see selectByChange) rather than
  //      sampling blindly by time, so the sheet lands on the moments that
  //      actually changed. All frames stay on disk for get_frame.
  //   2. BUDGET — a returned image has a hard size ceiling in most MCP clients;
  //      composeWithinBudget degrades the layout (thumbWidth, then frame count)
  //      until the encoded sheet fits both a pixel and a byte budget.
  //   3. The composed cell count and analysis cost are both bounded so a long
  //      session cannot allocate a giant image or decode unbounded frames.
  async _composeFromDisk(session, committed) {
    const built = await this._selectAndCompose(session, committed, this.limits.maxOutputBytes);
    const sheetBuffer = built.contactSheet.buffer;
    const contactSheetPath = path.join(session.dir, 'contactsheet.png');
    await this.fs.writeFile(contactSheetPath, sheetBuffer);
    const latestPath = path.join(session.baseDir, 'latest-contactsheet.png');
    await this.fs.writeFile(latestPath, sheetBuffer).catch(() => {});
    return { contactSheet: built.contactSheet, contactSheetPath, latestPath, warning: built.warning };
  }

  // Select informative frames (Phase 3) and compose a single budget-fitted
  // sheet from them, returning the composed image + metadata WITHOUT writing it
  // to disk. Shared by the single-sheet path and the per-clip replay path, so
  // both get the same selection + budget behaviour. `maxBytes` is the byte
  // ceiling for THIS sheet (replay divides the global budget across clips).
  async _selectAndCompose(session, pool, maxBytes) {
    const maxCells = this.limits.maxComposeFrames;

    // --- 1. selection -------------------------------------------------------
    let selected = pool;
    let selectionNote = null;
    if (pool.length > maxCells) {
      // Decode a bounded candidate set to measure frame-to-frame change, then
      // choose the most informative cells. Pixels are discarded after the tiny
      // signatures (bounded memory); selected frames are re-read below.
      const analysed = pool.length > this.limits.maxAnalysisFrames
        ? evenSample(pool, this.limits.maxAnalysisFrames)
        : pool;
      const { entries, sigs } = await this._signaturesFor(analysed);
      selected = entries.length > maxCells ? selectByChange(entries, sigs, maxCells) : entries;
      selectionNote =
        `Shows ${selected.length} of ${pool.length} frames ` +
        `(selected by visual change); all frames remain on disk (use get_frame).`;
    }

    // --- 2. decode the selected frames for composition ----------------------
    const frames = [];
    for (const entry of selected) {
      let img;
      try {
        img = decodePng(await this.fs.readFile(entry.path));
      } catch {
        continue; // skip a torn/half-written frame rather than fail the sheet
      }
      frames.push({ image: img, index: entry.index, timeMs: entry.timeMs });
    }
    if (frames.length === 0) {
      throw new Error('No decodable frames to compose a contact sheet');
    }

    // --- 3. fit within the output budget (pixels + measured bytes) ----------
    const built = composeWithinBudget(frames, {
      cols: session.cols,
      thumbWidth: session.thumbWidth,
      maxPixels: this.limits.maxOutputPixels,
      maxBytes,
      encode: (img) => encodePng(img.width, img.height, img.data),
    });

    const warning = [selectionNote, built.warning].filter(Boolean).join(' ') || null;
    return {
      contactSheet: {
        width: built.image.width,
        height: built.image.height,
        buffer: built.buffer,
        thumbWidth: built.thumbWidth,
        cols: built.cols,
        composedFrames: built.frameCount,
        composedIndices: built.selected.map((f) => f.index),
      },
      warning,
    };
  }

  // Compose one contact sheet per replay marker (clip). The global output-byte
  // budget is divided across the clips shown (bounded by maxClips) so the TOTAL
  // MCP response stays under the client's inline-image cap. A session with no
  // markers falls back to the final look-back window as one implicit clip, so
  // Finish without a mark still returns the most recent motion. Each clip's
  // frames stay on disk; their indices are reported for get_frame.
  async _composeClips(session, committed) {
    // Determine the clip definitions: explicit markers, or one implicit clip
    // from the surviving window if the user finished without marking.
    let defs = session.clips;
    let implicit = false;
    if (defs.length === 0) {
      if (committed.length === 0) return [];
      defs = [{ markIndex: 1, markedAtMs: committed[committed.length - 1].timeMs, frames: committed }];
      implicit = true;
      session.warnings.push(
        'Replay finished with no marker; showing the final ' +
        `${Math.round(session.replayWindowMs / 1000)}s window as one clip.`
      );
    }

    const shown = Math.min(defs.length, this.limits.maxClips);
    if (defs.length > shown) {
      session.warnings.push(`Showing ${shown} of ${defs.length} markers (clip cap).`);
    }
    // Split the byte budget across the clips shown (min floor so each is usable).
    const perClipBytes = Math.max(400_000, Math.floor(this.limits.maxOutputBytes / shown));

    const clips = [];
    let latestPath = null; // first composed clip is mirrored to latest-contactsheet.png
    for (let i = 0; i < shown; i++) {
      const def = defs[i];
      // Only frames that actually made it to disk can be composed.
      const clipCommitted = def.frames.filter((f) => f.written);
      if (clipCommitted.length === 0) continue;
      let built;
      try {
        built = await this._selectAndCompose(session, clipCommitted, perClipBytes);
      } catch (err) {
        session.warnings.push(`Clip ${def.markIndex} could not be composed: ${err.message}`);
        continue;
      }
      const sheetName = implicit ? 'contactsheet.png' : `clip_${String(def.markIndex).padStart(2, '0')}.png`;
      const sheetPath = path.join(session.dir, sheetName);
      await this.fs.writeFile(sheetPath, built.contactSheet.buffer);
      if (latestPath === null) {
        latestPath = path.join(session.baseDir, 'latest-contactsheet.png');
        await this.fs.writeFile(latestPath, built.contactSheet.buffer).catch(() => {});
      }
      clips.push({
        markIndex: def.markIndex,
        markedAtMs: def.markedAtMs,
        windowMs: def.windowMs || session.replayWindowMs,
        frameCount: clipCommitted.length,
        frames: clipCommitted.map((f) => ({ path: f.path, index: f.index, timeMs: f.timeMs })),
        contactSheet: built.contactSheet,
        contactSheetPath: sheetPath,
        warning: built.warning,
      });
      if (built.warning) session.warnings.push(`Clip ${def.markIndex}: ${built.warning}`);
    }
    return clips;
  }

  // Decode each frame in a candidate pool once to compute a cheap grayscale
  // change signature, discarding the full pixels immediately (bounded memory).
  // Undecodable frames are skipped. Returns aligned { entries, sigs }.
  async _signaturesFor(pool) {
    const entries = [];
    const sigs = [];
    for (const entry of pool) {
      let img;
      try {
        img = decodePng(await this.fs.readFile(entry.path));
      } catch {
        continue;
      }
      sigs.push(grayscaleSignature(img));
      entries.push(entry);
    }
    return { entries, sigs };
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
      cols: extra.contactSheet && extra.contactSheet.cols ? extra.contactSheet.cols : session.cols,
      thumbWidth: extra.contactSheet ? extra.contactSheet.thumbWidth : session.thumbWidth,
      // How many frames are actually shown on the sheet (≤ frameCount); the rest
      // remain on disk and are reachable with get_frame.
      composedFrames: extra.contactSheet ? extra.contactSheet.composedFrames : null,
      detail: session.detail,
      capped: !!session._cappedFrames || !!session._cappedDisk,
      warnings: session.warnings.slice(),
      errors: session.errors.slice(),
      contactSheetPath: extra.contactSheetPath,
      latestPath: extra.latestPath,
      frames: committed.map((f) => ({ path: f.path, index: f.index, timeMs: f.timeMs })),
      contactSheet: extra.contactSheet,
      // Replay (Phase 4): per-marker clips, each with its own contact sheet. Null
      // for a normal (non-replay) recording. The first clip's sheet is mirrored
      // into the top-level contactSheet above so existing single-sheet consumers
      // keep working; a replay-aware consumer emits one image per clip.
      replay: !!session.replay,
      evictedFrames: session.replay ? session.evictedCount : null,
      markCount: extra.clips ? extra.clips.length : null,
      clips: extra.clips || null,
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

// Select `count` frames preferring those with the most visual CHANGE from the
// previous frame, always keeping the first and last and preserving temporal
// order. `entries` and `sigs` are aligned (sigs[i] is entries[i]'s signature).
//
// Rationale: a recording of a bug has long static stretches and a few moments
// where something actually happens (a flash, a reorder, a drag landing). Even
// time-sampling spends cells on the static stretches; this spends them on the
// transitions, which is what the agent needs to see. Falls back to even
// sampling when there is no change signal or signatures are unavailable.
function selectByChange(entries, sigs, count) {
  const n = entries.length;
  if (n <= count) return entries.slice();
  if (count < 2 || sigs.length !== n) return evenSample(entries, count);

  // Per-frame change: how much each frame differs from the one before it. The
  // first frame has no predecessor (change 0); it is kept explicitly below.
  const change = new Array(n).fill(0);
  let total = 0;
  for (let i = 1; i < n; i++) {
    change[i] = signatureDiff(sigs[i], sigs[i - 1]);
    total += change[i];
  }
  // Nothing changed across the whole recording → no signal; sample by time.
  if (total === 0) return evenSample(entries, count);

  // Keep first + last; fill remaining slots with the highest-change interior
  // frames (ties → earliest index, for determinism). Restore temporal order.
  const keep = new Set([0, n - 1]);
  const interior = [];
  for (let i = 1; i < n - 1; i++) interior.push(i);
  interior.sort((a, b) => (change[b] - change[a]) || (a - b));
  for (let k = 0; k < interior.length && keep.size < count; k++) keep.add(interior[k]);
  return [...keep].sort((a, b) => a - b).map((i) => entries[i]);
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

export { DETAIL_PRESETS, normalizeDetail, clampNumber, selectByChange, evenSample };
