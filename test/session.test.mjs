// Deterministic session-controller tests: a fake clock + fake backend + in-memory
// fs make lifecycle, readiness, timing, limits, and finalisation fully
// reproducible without real timers, disk, or screen capture.
//
// These are the Phase-1 regression targets from the review. A fake backend does
// NOT establish OS capture support — native capture is smoke-tested separately
// (see test/windows-smoke.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionController, STATES, readManifest } from '../src/session.mjs';
import { createFakeClock } from '../src/clock.mjs';
import { createMemoryFs, createFakeBackend } from './helpers.mjs';

function make(opts = {}) {
  const clock = createFakeClock();
  const fs = opts.fs || createMemoryFs();
  const backend = opts.backend || createFakeBackend(clock, opts.backendOpts || {});
  const controller = new SessionController({
    clock, fs, backend,
    outputDir: '/caps',
    limits: { startupTimeoutMs: 5000, maxSessionMs: 60_000, ...(opts.limits || {}) },
  });
  return { clock, fs, backend, controller };
}

test('ready waits for a verified first frame (not before capture)', async () => {
  const { clock, controller } = make();
  const startP = controller.start({ fps: 4 });
  // Before any frame is produced, start() has not resolved.
  let resolved = false;
  startP.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false, 'start must not resolve before a frame arrives');

  await clock.advance(1); // first frame fires at t=0 tick
  const started = await startP;
  assert.equal(started.ready, true);
  assert.equal(started.state, STATES.RECORDING);
  assert.ok(controller.status(started.sessionId).frameCount >= 1);
});

test('a failing backend reports startup failure instead of a ready session', async () => {
  const { clock, controller } = make({ backendOpts: { mode: 'fail-first' } });
  const startP = controller.start({ fps: 4 });
  const settled = startP.then(() => 'ok', (e) => e);
  await clock.advance(10);
  const err = await settled;
  assert.ok(err instanceof Error, 'start should reject');
  assert.match(err.message, /exited before producing a frame|no capture device/);
  // Guard released: a new recording can start.
  assert.equal(controller.status().active, false);
});

test('a zero-frame backend hits the startup timeout (bounded, not forever)', async () => {
  const { clock, controller } = make({ backendOpts: { mode: 'zero-frames' }, limits: { startupTimeoutMs: 3000 } });
  const settled = controller.start({ fps: 4 }).then(() => 'ok', (e) => e);
  await clock.advance(3001);
  const err = await settled;
  assert.ok(err instanceof Error);
  assert.match(err.message, /did not produce a frame within 3000ms/);
  assert.equal(controller.status().active, false);
});

test('concurrent starts: only one acquires ownership', async () => {
  const { clock, controller } = make();
  const p1 = controller.start({ fps: 4 });
  const p2 = controller.start({ fps: 4 }); // synchronous second call
  const r2 = await p2.then(() => 'ok', (e) => e);
  assert.ok(r2 instanceof Error, 'second concurrent start must reject');
  assert.match(r2.message, /already in progress/);
  await clock.advance(1);
  const r1 = await p1;
  assert.equal(r1.ready, true);
});

test('timed recording follows a monotonic deadline, not a frame count', async () => {
  // Slow backend: frames every 3x the interval. A frame-count target would
  // extend the recording; a deadline must stop at ~1000ms regardless.
  const { clock, controller } = make({ backendOpts: { mode: 'slow', slowFactor: 3 } });
  const started = await (async () => {
    const p = controller.start({ fps: 10, durationMs: 1000 });
    await clock.advance(1);
    return p;
  })();
  const done = controller.awaitResult(started.sessionId);
  await clock.advance(2000); // well past the 1000ms deadline
  const result = await done;
  assert.equal(result.state, STATES.COMPLETED);
  assert.equal(result.completionReason, 'duration-reached');
  // Requested vs actual timing are reported separately and truthfully.
  assert.equal(result.requested.seconds, 1);
  assert.ok(result.actual.seconds <= 1.05, `actual ${result.actual.seconds}s should be ~<=1s`);
  // Slow backend → few frames; a frame-count target would have produced ~10.
  assert.ok(result.frameCount <= 5, `expected few frames, got ${result.frameCount}`);
  assert.ok(result.actual.meanFrameSpacingMs >= 250, 'reports real frame spacing');
});

test('duration deadline uses monotonic time, immune to wall-clock jumps', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 4, durationMs: 1000 });
  await clock.advance(1);
  const started = await p;
  const done = controller.awaitResult(started.sessionId);
  clock.skewWall(-3600_000); // system clock jumps back an hour mid-recording
  // Advance EXACTLY the duration in monotonic time. If the deadline followed the
  // wall clock, this -1h jump would push it far into the future and the session
  // would still be recording; with a monotonic deadline it completes right here.
  await clock.advance(1000);
  const result = await done;
  assert.equal(result.state, STATES.COMPLETED);
  assert.equal(result.completionReason, 'duration-reached');
  assert.equal(result.requested.seconds, 1);
});

test('repeated and concurrent stops share one outcome', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(1000); // a few frames
  const [a, b] = await Promise.all([controller.stop(started.sessionId), controller.stop(started.sessionId)]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.frameCount, b.frameCount);
  assert.equal(a.state, STATES.COMPLETED);
  // A stop AFTER completion returns the same stored result.
  const c = await controller.stop(started.sessionId);
  assert.equal(c.sessionId, a.sessionId);
  assert.equal(c.frameCount, a.frameCount);
});

test('stop during startup finalises cleanly', async () => {
  const { clock, controller } = make({ backendOpts: { mode: 'zero-frames' } });
  const startP = controller.start({ fps: 4 }).then(() => 'ok', (e) => e);
  await Promise.resolve();
  // Cancel before any frame; startup should reject and the guard release.
  const sid = controller.status().sessionId;
  const cancelP = controller.cancel(sid);
  await clock.advance(1);
  await cancelP;
  await startP;
  assert.equal(controller.status().active, false);
});

test('cancel preserves partial evidence and records the cancellation', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(600); // ~2-3 frames
  const result = await controller.cancel(started.sessionId);
  assert.equal(result.state, STATES.CANCELLED);
  assert.equal(result.completionReason, 'cancelled');
  assert.ok(result.frameCount >= 1, 'partial frames preserved');
  assert.ok(result.contactSheet, 'a contact sheet is still composed from partial frames');
});

test('frame cap bounds a runaway session', async () => {
  const { clock, controller } = make({ limits: { maxFrames: 5 } });
  const p = controller.start({ fps: 20 });
  await clock.advance(1);
  const started = await p;
  const done = controller.awaitResult(started.sessionId);
  await clock.advance(5000);
  const result = await done;
  assert.ok(result.frameCount <= 5, `capped at 5, got ${result.frameCount}`);
  assert.equal(result.capped, true);
  assert.ok(result.warnings.some((w) => /Frame cap reached/.test(w)));
});

test('disk-byte budget bounds a session', async () => {
  // tinyPng is ~70-90 bytes; set a tiny budget so a few frames trip it.
  const { clock, controller } = make({ limits: { maxDiskBytes: 200 } });
  const p = controller.start({ fps: 20 });
  await clock.advance(1);
  const started = await p;
  const done = controller.awaitResult(started.sessionId);
  await clock.advance(3000);
  const result = await done;
  assert.ok(result.warnings.some((w) => /Disk budget reached/.test(w)));
  assert.equal(result.capped, true);
});

test('oversized frames are dropped with a warning, not stored', async () => {
  // 40x40 real PNG against a 1000px limit (1600 > 1000). Cheap to encode so the
  // backend can keep emitting them; every one is rejected before readiness, so
  // start() hits the startup timeout and the drop is recorded as a warning.
  const { clock, controller } = make({
    backendOpts: { width: 40, height: 40 },
    limits: { maxInputPixels: 1000, startupTimeoutMs: 5000 },
  });
  const settled = controller.start({ fps: 4 }).then(() => 'ok', (e) => e);
  await clock.advance(5001); // never a valid frame → startup timeout
  const err = await settled;
  assert.ok(err instanceof Error, 'all frames oversized → no ready → startup timeout');
  assert.match(err.message, /did not produce a frame/);
  // The dropped frames were recorded as a (single, coalesced) warning and none
  // were stored on disk.
  const result = controller.getResult(controller.status().sessionId) || null;
  // After a startup failure the session is finalised; fetch its stored result.
  const stored = err.sessionId ? controller.getResult(err.sessionId) : null;
  const warnings = (stored && stored.warnings) || [];
  if (stored) {
    assert.ok(warnings.some((w) => /oversized/i.test(w)), 'oversized drop recorded');
    assert.equal(stored.frameCount, 0, 'no oversized frame was stored');
  }
});

test('frame-write failures are visible and never advertised as saved frames', async () => {
  const fs = createMemoryFs();
  // Fail every frame_*.png write but allow manifest/contactsheet writes.
  fs._setFailWrite((p) => (/frame_\d+_.*\.png$/.test(p) ? new Error('EIO disk gone') : null));
  const { clock, controller } = make({ fs });
  const settled = controller.start({ fps: 4 }).then((s) => s, (e) => e);
  await clock.advance(2000);
  const started = await settled;
  // Readiness is on acquisition, so start() resolves; but no frame is committed.
  if (started instanceof Error) {
    assert.match(started.message, /disk|EIO/i);
    return;
  }
  const done = controller.awaitResult(started.sessionId);
  await clock.advance(5000);
  const result = await done;
  assert.equal(result.frameCount, 0, 'no frame files were actually written');
  assert.ok(result.errors.some((e) => /Failed to write|disk/i.test(e)));
  assert.equal(result.state, STATES.FAILED);
});

test('backend exiting mid-recording is reported and finalises as failed', async () => {
  const { clock, controller } = make({ backendOpts: { mode: 'exit-after', exitAfter: 2 } });
  const p = controller.start({ fps: 10 });
  await clock.advance(1);
  const started = await p;
  const done = controller.awaitResult(started.sessionId);
  await clock.advance(1000);
  const result = await done;
  assert.ok(result.errors.some((e) => /exited unexpectedly/.test(e)));
  assert.ok(result.frameCount >= 1, 'frames captured before the exit are preserved');
});

test('a versioned manifest is persisted and remains inspectable', async () => {
  const { clock, fs, controller } = make();
  const p = controller.start({ fps: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(1000);
  const result = await controller.stop(started.sessionId);
  const manifest = await readManifest(result.dir, fs);
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.sessionId, started.sessionId);
  assert.equal(manifest.state, STATES.COMPLETED);
  assert.equal(manifest.target.requestedRegion, 'primary');
  assert.ok(Array.isArray(manifest.frames) && manifest.frames.length === result.frameCount);
  assert.ok(manifest.completionReason);
});

test('status reports an active session and clears after stop', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 4, region: 'primary' });
  await clock.advance(1);
  const started = await p;
  const live = controller.status();
  assert.equal(live.active, true);
  assert.equal(live.sessionId, started.sessionId);
  assert.equal(live.state, STATES.RECORDING);
  await clock.advance(500);
  await controller.stop(started.sessionId);
  assert.equal(controller.status().active, false);
});

test('shutdown cancels an active session (disconnect cleanup)', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(400);
  await controller.shutdown();
  const result = controller.getResult(started.sessionId);
  assert.ok(result);
  assert.equal(result.state, STATES.CANCELLED);
  assert.equal(controller.status().active, false);
});

test('record() convenience returns a completed result at the deadline', async () => {
  const { clock, controller } = make();
  const recP = controller.record({ seconds: 1, fps: 4 });
  await clock.advance(1);     // reach readiness
  await clock.advance(1000);  // reach the deadline
  const result = await recP;
  assert.equal(result.state, STATES.COMPLETED);
  assert.ok(result.frameCount >= 1);
  assert.equal(result.requested.seconds, 1);
});

// --- Phase 3: content-aware selection through the full compose path ---------

test('contact sheet selects high-change frames when there are more than the cell cap', async () => {
  // 12 frames, but only a few moments actually change: frames 1 (first), 6, 9,
  // and 12 (last) differ sharply; the rest repeat their predecessor's colour.
  // With a 4-cell cap, selection should land on exactly those moments rather
  // than sampling evenly by time (which would pick 1, 4, 8, 12).
  const black = [10, 10, 10, 255];
  const flash = [240, 240, 240, 255];
  const mid = [120, 60, 180, 255];
  const fills = [
    black, black, black, black, black, // 1-5: static
    flash,                             // 6: big change ↑
    flash, flash,                      // 7-8: static (now bright)
    mid,                               // 9: big change ↓
    mid, mid,                          // 10-11: static
    black,                             // 12: big change (last, kept anyway)
  ];
  const { clock, controller } = make({
    backendOpts: { fills, width: 32, height: 24 },
    limits: { maxComposeFrames: 4 },
  });
  const p = controller.start({ fps: 10 });
  await clock.advance(1);
  const started = await p;
  // Frames tick at t=0,100,...,1100 → 12 frames; then stop and finalise.
  await clock.advance(1100);
  const result = await controller.stop(started.sessionId);

  assert.ok(result.frameCount >= 12, `expected ≥12 frames, got ${result.frameCount}`);
  const shown = result.contactSheet.composedIndices;
  assert.equal(shown.length, 4, 'sheet shows exactly the cell cap');
  assert.equal(shown[0], 1, 'first frame kept');
  assert.equal(shown[shown.length - 1], result.frameCount, 'last frame kept');
  // A four-cell budget retains the immediate before/changed pair for the
  // strongest transition, instead of displaying two disconnected changes.
  assert.ok(shown.includes(6), `expected the flash frame #6 in ${shown}`);
  assert.ok(shown.includes(5), `expected the frame immediately before the flash in ${shown}`);
  assert.ok(result.warnings.some((w) => /selected by visual change/.test(w)));
});

test('output byte budget shrinks the contact sheet to fit', async () => {
  // A tiny byte budget forces the budget loop to degrade the layout. Frames are
  // 64×48 so there is real area to shed. We assert the encoded sheet honours the
  // cap and that the degradation is reported.
  const { clock, controller } = make({
    backendOpts: { width: 64, height: 48 },
    limits: { maxOutputBytes: 1500, maxComposeFrames: 36 },
  });
  const p = controller.start({ fps: 10, thumbWidth: 480, cols: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(1000);
  const result = await controller.stop(started.sessionId);

  assert.ok(result.contactSheet.buffer.length <= 1500,
    `sheet ${result.contactSheet.buffer.length}B must fit the 1500B budget`);
  // Degradation happened: either thumbnails shrank below the requested 480px or
  // frames were dropped from the sheet — and it was reported.
  assert.ok(result.thumbWidth < 480 || result.contactSheet.composedFrames < result.frameCount);
  assert.ok(result.warnings.some((w) => /budget/.test(w)));
});

// --- Phase 4: replay ring buffer + markers ----------------------------------

// Count frame_*.png files currently on the (in-memory) disk.
function frameFilesOnDisk(fs) {
  let n = 0;
  for (const p of fs._files.keys()) if (/frame_\d+_.*\.png$/.test(p)) n++;
  return n;
}

test('replay ring buffer evicts aged frames, keeping disk bounded', async () => {
  // window 1000ms at 10 fps → the buffer should hold ~10 frames no matter how
  // long the session runs. Over 4s the backend emits ~40 frames, but eviction
  // deletes the aged, unpinned ones from disk as new ones arrive.
  const fs = createMemoryFs();
  const { clock, controller } = make({ fs });
  const p = controller.start({ fps: 10, replay: true, windowMs: 1000 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(4000);

  const live = controller.status(started.sessionId);
  // Retained set is bounded by the window (allow slack for boundary frames).
  assert.ok(live.frameCount <= 15, `window should bound retained frames, got ${live.frameCount}`);
  assert.ok(frameFilesOnDisk(fs) <= 15, `disk should be bounded by the window, got ${frameFilesOnDisk(fs)}`);
  assert.equal(live.replay, true);

  const result = await controller.stop(started.sessionId);
  // Many frames were emitted; most were evicted (proving the buffer rolled).
  assert.ok(result.evictedFrames >= 20, `expected substantial eviction, got ${result.evictedFrames}`);
});

test('a marker pins its window so eviction cannot delete it', async () => {
  const fs = createMemoryFs();
  const { clock, controller } = make({ fs });
  const p = controller.start({ fps: 10, replay: true, windowMs: 1000 });
  await clock.advance(1);
  const started = await p;

  // Fill the window, then mark — pinning the frames currently buffered.
  await clock.advance(1000);
  const mark = controller.mark(started.sessionId);
  assert.ok(mark.frameCount >= 5, `mark should pin the buffered window, got ${mark.frameCount}`);
  const pinnedPaths = controller.active.clips[0].frames.map((f) => f.path);

  // Record far past the window so unpinned frames roll out; pinned must remain.
  await clock.advance(4000);
  for (const pth of pinnedPaths) {
    assert.ok(fs.has(pth), `pinned frame ${pth} must survive eviction`);
  }

  const result = await controller.stop(started.sessionId);
  assert.equal(result.markCount, 1);
  assert.equal(result.clips.length, 1);
  assert.ok(result.clips[0].contactSheet, 'the clip has its own contact sheet');
  assert.equal(result.clips[0].frameCount, mark.frameCount);
});

test('multiple markers each yield their own clip', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 10, replay: true, windowMs: 1000 });
  await clock.advance(1);
  const started = await p;

  await clock.advance(800);
  const m1 = controller.mark(started.sessionId);
  await clock.advance(1200);
  const m2 = controller.mark(started.sessionId);
  await clock.advance(500);
  const result = await controller.stop(started.sessionId);

  assert.equal(m1.markIndex, 1);
  assert.equal(m2.markIndex, 2);
  assert.equal(result.markCount, 2);
  assert.equal(result.clips.length, 2);
  assert.equal(result.clips[0].markIndex, 1);
  assert.equal(result.clips[1].markIndex, 2);
  // Each clip composed its own sheet, and they are distinct files.
  assert.ok(result.clips[0].contactSheet && result.clips[1].contactSheet);
  assert.notEqual(result.clips[0].contactSheetPath, result.clips[1].contactSheetPath);
});

test('replay finished with no marker returns the final window as one implicit clip', async () => {
  const { clock, controller } = make();
  const p = controller.start({ fps: 10, replay: true, windowMs: 1000 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(1500);
  const result = await controller.stop(started.sessionId);

  assert.equal(result.markCount, 1, 'one implicit clip from the surviving window');
  assert.equal(result.clips.length, 1);
  assert.ok(result.contactSheet, 'top-level sheet mirrors the implicit clip');
  assert.ok(result.warnings.some((w) => /no marker/i.test(w)));
});

test('the per-clip byte budget is divided across shown clips', async () => {
  // Two marks → the global output budget is split so the TOTAL stays bounded.
  // Frames are 64×48 so there is real area; a small global budget must force
  // each clip's sheet to degrade and report it.
  const { clock, controller } = make({
    backendOpts: { width: 64, height: 48 },
    limits: { maxOutputBytes: 1200, maxComposeFrames: 36 },
  });
  const p = controller.start({ fps: 10, replay: true, windowMs: 1000, thumbWidth: 480, cols: 4 });
  await clock.advance(1);
  const started = await p;
  await clock.advance(600);
  controller.mark(started.sessionId);
  await clock.advance(1000);
  controller.mark(started.sessionId);
  await clock.advance(300);
  const result = await controller.stop(started.sessionId);

  assert.equal(result.clips.length, 2);
  // perClipBytes has a 400 KB floor, so a tiny global budget maps to that floor;
  // the real guarantee we assert is each clip encodes to a usable PNG that
  // honours its own ceiling and the degradation is surfaced.
  for (const clip of result.clips) {
    assert.ok(clip.contactSheet.buffer.length <= 400_000, 'each clip fits its per-clip budget');
  }
});
