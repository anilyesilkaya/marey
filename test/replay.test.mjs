// Phase 4 replay integration tests. These exercise the real control server + a
// real SessionController on the REAL clock (the control page and marking use
// real timers), with a fake backend injected so no actual screen capture
// happens. They cover the /mark endpoint's CSRF guard, that a mark does NOT end
// the recording, cross-process marking (what `marey mark` does), and the full
// arm → mark (twice) → finish → two clips round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionController } from '../src/session.mjs';
import { createRealClock } from '../src/clock.mjs';
import {
  createControlServer, writeControlRegistry, clearControlRegistry,
  readControlRegistry, signalControl,
} from '../src/control.mjs';
import { createMemoryFs, tinyPng } from './helpers.mjs';

// A real-timer fake backend: emits a tiny frame every intervalMs via real
// setTimeout, so a real-clock replay session buffers frames deterministically
// enough for a short test without touching the screen.
function realTimerBackend() {
  return {
    name: 'fake-realtime',
    startStream({ intervalMs }, onFrame) {
      let count = 0, stopped = false, exited = false, resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      const start = Date.now();
      const tick = () => {
        if (stopped) return;
        count++;
        onFrame({ png: tinyPng(8, 6, [count % 256, 0, 0, 255]), timeMs: Date.now() - start }, count);
        if (!stopped) setTimeout(tick, intervalMs).unref?.();
      };
      setTimeout(tick, 0).unref?.();
      return {
        stop() { stopped = true; if (!exited) { exited = true; resolveClosed(); } return closed; },
        whenClosed() { return closed; },
        get exited() { return exited; },
        get framesSeen() { return count; },
        get error() { return null; },
      };
    },
  };
}

function makeController() {
  return new SessionController({
    clock: createRealClock(),
    backend: realTimerBackend(),
    fs: createMemoryFs(),
    outputDir: '/caps',
    limits: { startupTimeoutMs: 2000 },
  });
}

// Minimal re-implementation of recorder.replay wired to an injectable
// controller, so the test controls the clock/backend/fs. (recorder.replay uses
// the process-shared real-fs controller; here we isolate it.) `drive` receives
// the live control handle and performs marks/finish; it returns the outcome
// path to settle with ('finished' | 'cancelled').
async function replayWith(controller, drive, { windowMs = 100000, maxMs = 5000 } = {}) {
  const started = await controller.start({ fps: 30, replay: true, windowMs });
  const control = createControlServer({
    getStatus: () => {
      const s = controller.status(started.sessionId);
      return {
        frameCount: s.frameCount ?? 0, elapsedMs: s.elapsedMs ?? 0,
        region: s.region, fps: s.fps, markCount: s.markCount ?? 0,
      };
    },
    onMark: () => controller.mark(started.sessionId),
  });
  await control.listen();
  writeControlRegistry(control, { sessionId: started.sessionId, mode: 'replay' });
  const timer = setTimeout(() => control.settle('timed-out'), maxMs);
  timer.unref?.();
  try {
    await drive(control, started);
    const outcome = await control.outcome;
    clearTimeout(timer);
    const raw = outcome === 'cancelled'
      ? await controller.cancel(started.sessionId)
      : await controller.stop(started.sessionId, { reason: outcome });
    return { outcome, result: raw, sessionId: started.sessionId };
  } finally {
    clearControlRegistry();
    await control.close().catch(() => {});
  }
}

const post = (control, route) => fetch(`http://127.0.0.1:${control.port}${route}`, {
  method: 'POST', headers: { 'X-Marey-Token': control.token },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the control page exposes a Mark button only when marking is enabled', async () => {
  // With onMark → the page has a Mark control and /mark is live.
  const marking = createControlServer({ onMark: () => ({ markIndex: 1 }) });
  await marking.listen();
  try {
    const page = await (await fetch(`${marking.url}`)).text();
    assert.match(page, /id="mark"/, 'replay page should render a Mark button');
    const r = await post(marking, '/mark');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.markIndex, 1);
  } finally {
    await marking.close();
  }

  // Without onMark → no Mark button and /mark is 404 (observe behaves as before).
  const plain = createControlServer({});
  await plain.listen();
  try {
    const page = await (await fetch(`${plain.url}`)).text();
    assert.doesNotMatch(page, /id="mark"/, 'observe page must not render a Mark button');
    const r = await post(plain, '/mark');
    assert.equal(r.status, 404, '/mark is not enabled without onMark');
  } finally {
    await plain.close();
  }
});

test('/mark rejects a request without the token header (CSRF-safe)', async () => {
  let marks = 0;
  const control = createControlServer({ onMark: () => ({ markIndex: ++marks }) });
  await control.listen();
  try {
    // No X-Marey-Token header → forbidden, and onMark is never invoked.
    const r = await fetch(`http://127.0.0.1:${control.port}/mark`, { method: 'POST' });
    assert.equal(r.status, 403);
    assert.equal(marks, 0, 'onMark must not run for a tokenless request');
  } finally {
    await control.close();
  }
});

test('a mark does NOT settle the outcome; the recording continues', async () => {
  const control = createControlServer({ onMark: () => ({ markIndex: 1 }) });
  await control.listen();
  try {
    await post(control, '/mark');
    await post(control, '/mark');
    // Still unsettled after marks — only finish/cancel settles.
    assert.equal(control.settled, false, 'marking must not end the observation');
    const status = await (await fetch(`${control.url.replace('/?t=', '/status?t=')}`)).json();
    assert.equal(status.settled, false);
    await post(control, '/finish');
    assert.equal(await control.outcome, 'finished');
  } finally {
    await control.close();
  }
});

test('replay: arm → mark twice → finish → two clips with their own sheets', async () => {
  const controller = makeController();
  const { outcome, result } = await replayWith(controller, async (control) => {
    await wait(120);                 // buffer a few frames
    const m1 = await (await post(control, '/mark')).json();
    assert.equal(m1.markIndex, 1);
    assert.ok(m1.frameCount >= 1, 'first mark pinned buffered frames');
    await wait(120);                 // buffer more
    const m2 = await (await post(control, '/mark')).json();
    assert.equal(m2.markIndex, 2);
    await wait(60);
    await post(control, '/finish');  // end it
  });

  assert.equal(outcome, 'finished');
  assert.equal(result.state, 'completed');
  assert.equal(result.markCount, 2, 'two markers → two clips');
  assert.equal(result.clips.length, 2);
  assert.ok(result.clips[0].contactSheet && result.clips[1].contactSheet,
    'each clip composed its own contact sheet');
  assert.notEqual(result.clips[0].contactSheetPath, result.clips[1].contactSheetPath);
});

test('`marey mark` from "another process" pins a clip via signalControl', async () => {
  const controller = makeController();
  const { result } = await replayWith(controller, async () => {
    await wait(120);
    // Exactly what `marey mark` does: read the registry, POST /mark with token.
    const reg = readControlRegistry();
    assert.ok(reg && reg.mode === 'replay', 'registry should describe a replay session');
    const r = await signalControl('mark');
    assert.equal(r.ok, true);
    assert.equal(r.markIndex, 1);
    assert.ok(r.frameCount >= 1);
    await wait(60);
    await signalControl('finish');
  });
  assert.equal(result.markCount, 1);
  assert.equal(result.clips.length, 1);
});

test('signalControl("mark") on a non-replay observation reports cleanly', async () => {
  // An observe-style control server has no onMark → /mark is 404; the CLI maps
  // that to a friendly "not a replay session" message rather than a crash.
  const control = createControlServer({});  // no onMark (observe)
  await control.listen();
  writeControlRegistry(control, { sessionId: 'x' });
  try {
    const r = await signalControl('mark');
    assert.equal(r.ok, false);
    assert.match(r.error, /not a replay session/i);
  } finally {
    clearControlRegistry();
    await control.close();
  }
});
