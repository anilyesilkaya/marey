// observe() integration tests. These exercise the real control server + a real
// SessionController on the REAL clock (the control page uses real timers), with
// a fake backend injected so no actual screen capture happens. The human's
// Finish/Cancel is driven two ways: via signalControl() (what `marey finish`
// does from another process) and via the control-server outcome directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';

import { SessionController } from '../src/session.mjs';
import { createRealClock } from '../src/clock.mjs';
import {
  createControlServer, writeControlRegistry, clearControlRegistry,
  readControlRegistry, signalControl,
} from '../src/control.mjs';
import { createMemoryFs, tinyPng } from './helpers.mjs';

// A real-timer fake backend: emits a tiny frame every intervalMs via real
// setTimeout, so observe()'s real-clock session captures frames deterministically
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

// Minimal re-implementation of recorder.observe wired to an injectable
// controller, so the test controls the clock/backend/fs. (recorder.observe uses
// the process-shared real-fs controller; here we isolate it.)
async function observeWith(controller, { outcomeVia, maxMs = 5000 } = {}) {
  const started = await controller.start({ fps: 20 });
  const control = createControlServer({
    getStatus: () => {
      const s = controller.status(started.sessionId);
      return { frameCount: s.frameCount ?? 0, elapsedMs: s.elapsedMs ?? 0, region: s.region, fps: s.fps };
    },
  });
  await control.listen();
  writeControlRegistry(control, { sessionId: started.sessionId });
  const timer = setTimeout(() => control.settle('timed-out'), maxMs);
  timer.unref?.();
  try {
    // Trigger the chosen finish path shortly after a couple frames.
    await new Promise((r) => setTimeout(r, 120));
    await outcomeVia(control);
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

function makeController() {
  return new SessionController({
    clock: createRealClock(),
    backend: realTimerBackend(),
    fs: createMemoryFs(),
    outputDir: '/caps',
    limits: { startupTimeoutMs: 2000 },
  });
}

test('observe returns evidence when the user clicks Finish', async () => {
  const controller = makeController();
  const { outcome, result } = await observeWith(controller, {
    outcomeVia: (control) => fetch(`http://127.0.0.1:${control.port}/finish`, {
      method: 'POST', headers: { 'X-Marey-Token': control.token },
    }),
  });
  assert.equal(outcome, 'finished');
  assert.equal(result.state, 'completed');
  assert.ok(result.frameCount >= 1, 'captured at least one frame');
  assert.ok(result.contactSheet, 'a contact sheet was composed');
});

test('observe maps Cancel to a cancelled session (partial evidence kept)', async () => {
  const controller = makeController();
  const { outcome, result } = await observeWith(controller, {
    outcomeVia: (control) => fetch(`http://127.0.0.1:${control.port}/cancel`, {
      method: 'POST', headers: { 'X-Marey-Token': control.token },
    }),
  });
  assert.equal(outcome, 'cancelled');
  assert.equal(result.state, 'cancelled');
  assert.equal(result.completionReason, 'cancelled');
});

test('signalControl() finishes the observation from "another process"', async () => {
  const controller = makeController();
  const { outcome, result } = await observeWith(controller, {
    // This is exactly what `marey finish` does: read the registry, POST /finish.
    outcomeVia: async () => {
      const reg = readControlRegistry();
      assert.ok(reg && reg.sessionId, 'registry should describe the live observation');
      const r = await signalControl('finish');
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'finished');
    },
  });
  assert.equal(outcome, 'finished');
  assert.ok(result.frameCount >= 1);
});

test('observe hits its max-duration deadline if the user never acts', async () => {
  const controller = makeController();
  const started = await controller.start({ fps: 20 });
  const control = createControlServer({ getStatus: () => controller.status(started.sessionId) });
  await control.listen();
  const timer = setTimeout(() => control.settle('timed-out'), 300); // short deadline
  try {
    const outcome = await control.outcome;
    assert.equal(outcome, 'timed-out');
    const raw = await controller.stop(started.sessionId, { reason: outcome });
    assert.equal(raw.completionReason, 'timed-out');
    assert.ok(raw.frameCount >= 1);
  } finally {
    clearTimeout(timer);
    await control.close();
  }
});

test('signalControl() with no active observation reports cleanly', async () => {
  clearControlRegistry();
  const r = await signalControl('finish');
  assert.equal(r.ok, false);
  assert.match(r.error, /No active observation/);
});
