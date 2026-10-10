import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PngStreamParser, startFfmpegStream, deferredStream } from '../src/capture-stream.mjs';
import { startStreamPortable } from '../src/capture.mjs';
import { captureRect, selectWindow } from '../src/capture-target.mjs';
import { createFakeClock } from '../src/clock.mjs';
import { tinyPng } from './helpers.mjs';

test('PNG stream handles arbitrary chunk boundaries and several frames per chunk', () => {
  const pngs = [tinyPng(), tinyPng(9, 7), tinyPng(10, 8)];
  const bytes = Buffer.concat(pngs);
  const received = [];
  const parser = new PngStreamParser((png) => received.push(Buffer.from(png)));
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  parser.finish();
  assert.deepEqual(received, pngs);
  const combined = [];
  const parser2 = new PngStreamParser((png) => combined.push(png));
  parser2.push(bytes);
  assert.deepEqual(combined, pngs);
});

test('PNG stream rejects corruption, truncation, and oversized chunks', () => {
  assert.throws(() => new PngStreamParser(() => {}).push(Buffer.alloc(8)), /signature/);
  const parser = new PngStreamParser(() => {});
  parser.push(tinyPng().subarray(0, 20));
  assert.throws(() => parser.finish(), /Truncated/);
  const huge = Buffer.from(tinyPng()); huge.writeUInt32BE(1000, 8);
  assert.throws(() => new PngStreamParser(() => {}, 100).push(huge), /limit/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  return child;
}

test('continuous stream pairs acquisition timestamps across independent stdout/stderr ordering', async () => {
  const child = fakeChild(); const frames = [];
  const handle = startFfmpegStream([], (frame) => frames.push(frame), {}, () => child);
  child.stdout.write(tinyPng());
  assert.equal(frames.length, 0, 'must not invent a timestamp from output arrival');
  child.stderr.write('[Parsed_showinfo_1] n: 0 pts: 0 pts_time:0.00\n[Parsed_showinfo_1] n: 1 pts: 50 pts_time:0.05\n');
  child.stdout.write(tinyPng());
  assert.deepEqual(frames.map((f) => f.timeMs), [0, 50]);
  assert.equal(frames[0].timingSource, 'capture-pts');
  await handle.stop(); assert.equal(handle.error, null);
});

test('unmatched timestamps and process errors are surfaced instead of fabricated frames', async () => {
  const child = fakeChild(); const handle = startFfmpegStream([], () => {}, {}, () => child);
  child.stderr.write('[Parsed_showinfo_1] n: 0 pts: 0 pts_time:0\n');
  child.emit('close', 0); await handle.whenClosed();
  assert.match(handle.error, /Incomplete/);
  const failed = fakeChild(); const failure = startFfmpegStream([], () => {}, {}, () => failed);
  failed.stderr.write('screen permission denied\n'); failed.emit('close', 1);
  await failure.whenClosed(); assert.match(failure.error, /permission denied/);
});

test('stopping during asynchronous target discovery still stops the created stream', async () => {
  let release; let stops = 0;
  const prepared = new Promise((r) => { release = r; });
  const stream = deferredStream(() => prepared);
  const stopped = stream.stop();
  release({ stop: async () => { stops++; }, whenClosed: async () => {} });
  await stopped;
  assert.equal(stops, 1); assert.equal(stream.exited, true);
});

test('portable fallback schedules acquisition deadlines without adding encoding time to every interval', async () => {
  const clock = createFakeClock(); const times = [];
  const handle = startStreamPortable({ intervalMs: 100 }, (f) => times.push(f.timeMs), {
    clock, grabPng: async () => {
      await new Promise((r) => clock.setTimeout(r, 40));
      return tinyPng();
    },
  });
  await clock.advance(350); await handle.stop();
  assert.deepEqual(times, [0, 100, 200, 300]);
});

test('window targeting excludes hidden matches, rejects ambiguity, and accepts stable IDs', () => {
  const windows = [
    { id: '10', title: 'Chromium clipboard', width: 10, height: 10, hidden: true },
    { id: '11', title: 'Editor Chromium', width: 800, height: 600, hidden: false },
  ];
  assert.equal(selectWindow(windows, { title: 'Chromium' }).id, '11');
  assert.equal(selectWindow(windows, { windowId: '0xb' }).id, '11');
  assert.throws(() => selectWindow(windows, { windowId: '10' }), /hidden/);
  assert.throws(() => selectWindow(windows, { windowId: '-root' }), /native window ID/);
  assert.throws(() => selectWindow([...windows, { ...windows[1], id: '12' }], { title: 'Chromium' }), /ambiguous/);
  assert.throws(() => selectWindow(windows, {}), /requires/);
});

test('capture rectangle rejects fractional, missing, and out-of-target geometry', () => {
  const rect = { x: 1, y: 2, w: 30, h: 40 };
  assert.deepEqual(captureRect(rect, { width: 50, height: 50 }), rect);
  assert.throws(() => captureRect({ ...rect, x: 0.5 }), /integer/);
  assert.throws(() => captureRect({ ...rect, w: 0 }), /integer/);
  assert.throws(() => captureRect({ x: 0, y: 0 }), /integer/);
  assert.throws(() => captureRect(rect, { width: 10, height: 10 }), /outside/);
});
