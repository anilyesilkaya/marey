import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionController, selectByChange } from '../src/session.mjs';
import { createFakeClock } from '../src/clock.mjs';
import { createFakeBackend, createMemoryFs, tinyPng } from './helpers.mjs';
import { evidenceSummary, recordingMetadata } from '../src/evidence.mjs';
import { getFrames } from '../src/recorder.mjs';
import { decodePng } from '../src/png.mjs';

test('three-cell selection shows immediate before, changed, and after frames', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ index: i + 1 }));
  const sigs = entries.map((_, i) => Uint8Array.of(i < 5 ? 0 : 255));
  assert.deepEqual(selectByChange(entries, sigs, 3).map((e) => e.index), [5, 6, 7]);
  assert.deepEqual(selectByChange(entries, sigs, 2).map((e) => e.index), [5, 6]);
  assert.deepEqual(selectByChange(entries, sigs, 1).map((e) => e.index), [6]);
});

test('frame selection covers multiple separated transitions with neighborhoods', () => {
  const values = [0, 0, 0, 255, 255, 255, 255, 255, 100, 100, 100, 100];
  const entries = values.map((_, i) => ({ index: i + 1 }));
  assert.deepEqual(selectByChange(entries, values.map((v) => Uint8Array.of(v)), 8).map((e) => e.index), [1, 3, 4, 5, 8, 9, 10, 12]);
});

test('analysis of long recordings does not thin away a single-frame flash', async () => {
  const clock = createFakeClock(); const fs = createMemoryFs();
  const fills = Array.from({ length: 400 }, (_, i) => i === 123 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  const controller = new SessionController({ clock, fs, backend: createFakeBackend(clock, { fills }), limits: { maxComposeFrames: 3 } });
  const starting = controller.start({ fps: 60 }); await clock.advance(1);
  const started = await starting; await clock.advance(399 * 1000 / 60);
  const result = await controller.stop(started.sessionId);
  assert.ok(result.frameCount >= 400);
  assert.deepEqual(result.contactSheet.composedIndices, [123, 124, 125]);
});

test('slow capture reports achieved FPS, gaps, quality and identical persisted metadata', async () => {
  const clock = createFakeClock(); const fs = createMemoryFs();
  const controller = new SessionController({ clock, fs, backend: createFakeBackend(clock, { mode: 'slow', slowFactor: 3 }) });
  const starting = controller.start({ fps: 10 }); await clock.advance(1);
  const started = await starting; await clock.advance(900);
  const result = await controller.stop(started.sessionId);
  assert.equal(result.actual.fps, 1000 / 300);
  assert.equal(result.actual.maxFrameGapMs, 300);
  assert.equal(result.quality.status, 'degraded');
  assert.equal(result.quality.gaps.length, 3);
  const metadata = recordingMetadata(result);
  assert.equal(metadata.requested.fps, 10);
  assert.match(evidenceSummary(result), /achieved 3.33 fps/);
  assert.match(evidenceSummary(result), /largest frame gap 300.0ms/);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.deepEqual(manifest.quality, metadata.quality);
  assert.deepEqual(manifest.actual, metadata.actual);
});

test('mid-recording failure retains evidence and explains failure to the model', async () => {
  const clock = createFakeClock(); const fs = createMemoryFs();
  const controller = new SessionController({ clock, fs, backend: createFakeBackend(clock, { mode: 'exit-after', exitAfter: 2, error: 'device lost' }) });
  const starting = controller.start({ fps: 10 }); await clock.advance(1); const started = await starting;
  await clock.advance(250);
  const result = await controller.stop(started.sessionId);
  assert.equal(result.state, 'failed'); assert.ok(result.contactSheet);
  assert.equal(result.quality.status, 'degraded');
  assert.match(evidenceSummary(result), /device lost/);
  assert.match(evidenceSummary(result), /completion backend-exited/);
});

test('manifest-write failure appears in returned evidence quality', async () => {
  const clock = createFakeClock(); const fs = createMemoryFs();
  const controller = new SessionController({ clock, fs, backend: createFakeBackend(clock) });
  const starting = controller.start({ fps: 10 }); await clock.advance(1);
  const started = await starting; await clock.advance(100);
  fs._setFailWrite((p) => p.endsWith('manifest.json.tmp') ? new Error('disk unavailable') : null);
  const result = await controller.stop(started.sessionId);
  assert.equal(result.quality.status, 'degraded');
  assert.ok(result.warnings.some((w) => w.includes('Manifest write failed')));
});

test('replay eviction does not invent acquisition gaps or distort achieved FPS', async () => {
  const clock = createFakeClock(); const fs = createMemoryFs();
  const controller = new SessionController({ clock, fs, backend: createFakeBackend(clock) });
  const starting = controller.start({ fps: 10, replay: true, windowMs: 1000 });
  await clock.advance(1); const started = await starting;
  await clock.advance(500); controller.mark(started.sessionId);
  await clock.advance(3000);
  const result = await controller.stop(started.sessionId);
  assert.ok(result.evictedFrames > 0);
  assert.equal(result.actual.fps, 10);
  assert.equal(result.quality.gapCount, 0);
  assert.equal(result.actual.maxFrameGapMs, 100);
});

test('time-range inspection selects transition context, crops consistently, and rejects empty ranges', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-range-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frames = [];
  for (let i = 0; i < 10; i++) {
    const file = `frame_${String(i + 1).padStart(3, '0')}.png`;
    await writeFile(path.join(dir, file), tinyPng(20, 10, i < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    frames.push({ file, index: i + 1, timeMs: i * 50 });
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifestVersion: 1, frames }));
  const range = await getFrames({ dir, startMs: 100, endMs: 400, maxFrames: 3, crop: { x: 0, y: 0, w: 10, h: 10 } });
  assert.equal(range.availableFrames, 7);
  assert.deepEqual(range.frames.map((f) => f.index), [5, 6, 7]);
  assert.equal(decodePng(range.image.buffer).width, range.image.width);
  await assert.rejects(getFrames({ dir, startMs: 500, endMs: 600 }), /No recorded frames/);
  await assert.rejects(getFrames({ dir, startMs: 20, endMs: 10 }), /Time range/);
  await assert.rejects(getFrames({ dir, maxFrames: 100 }), /maxFrames/);
});
