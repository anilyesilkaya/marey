// Opt-in real-pixel tests: CI runs these on an isolated Xvfb display. Ordinary
// npm test does not require desktop permissions or installed native tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureImage, listWindows } from '../src/capture.mjs';
import { startRecording, stopRecording, getFrames } from '../src/recorder.mjs';
import { decodePng } from '../src/png.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enabled = process.platform === 'linux' && process.env.MAREY_NATIVE_TESTS === '1';

test('real X11 capture: blank PNG, brief flash, stable targets, and time-range retrieval', { skip: !enabled, timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-native-'));
  const display = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '640x480x24', '-nolisten', 'tcp', '-noreset']);
  let diagnostics = ''; display.stderr.on('data', (d) => { diagnostics += d; });
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const children = [display];
  t.after(async () => {
    children.reverse().forEach((child) => child.kill());
    if (previousDisplay == null) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
    if (previousWayland == null) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland;
    await rm(dir, { recursive: true, force: true });
  });
  const number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Xvfb startup timed out: ${diagnostics}`)), 5000);
    display.once('error', (err) => { clearTimeout(timer); reject(err); });
    display.stdout.once('data', (d) => { clearTimeout(timer); resolve(d.toString().trim()); });
  });
  process.env.DISPLAY = `:${number}`; delete process.env.WAYLAND_DISPLAY;
  await exec('xsetroot', ['-solid', '#000000']);
  const blank = await captureImage({ rect: { x: 10, y: 20, w: 200, h: 100 } });
  assert.equal(blank.image.width, 200); assert.equal(blank.image.height, 100);
  assert.deepEqual(blank.target.bounds, { x: 10, y: 20, width: 200, height: 100 });
  assert.deepEqual([...blank.image.data.subarray(0, 4)], [0, 0, 0, 255]);
  await assert.rejects(captureImage({ rect: { x: 600, y: 0, w: 100, h: 100 } }), /outside/);

  const started = await startRecording({ fps: 20, rect: { x: 0, y: 0, w: 200, h: 100 }, outputDir: dir });
  await sleep(200);
  await exec('xsetroot', ['-solid', '#ff00ff']);
  await sleep(100);
  await exec('xsetroot', ['-solid', '#000000']);
  await sleep(200);
  const result = await stopRecording();
  assert.equal(result.backend, 'linux:ffmpeg-stream');
  assert.equal(result.timingSource, 'capture-pts');
  assert.ok(result.actual.fps >= 15, `achieved only ${result.actual.fps}fps`);
  assert.ok(result.actual.maxFrameGapMs < 150);
  const colors = [];
  for (const f of result.frames) colors.push([...decodePng(await readFile(f.path)).data.subarray(0, 3)]);
  const flash = colors.findIndex((rgb) => rgb[0] === 255 && rgb[1] === 0 && rgb[2] === 255);
  assert.ok(flash > 0 && flash < colors.length - 1, '100ms flash must be present between baseline frames');
  const range = await getFrames({ dir: started.dir, startMs: 0, endMs: result.actual.lastFrameMs });
  assert.ok(range.frames.length >= 3);

  for (let i = 0; i < 2; i++) {
    const child = spawn('xmessage', ['-title', 'Marey smoke target', '-geometry', '180x100+20+30', 'capture me']);
    children.push(child); child.stdout.resume(); child.stderr.resume();
  }
  let windows;
  for (let i = 0; i < 30; i++) {
    windows = (await listWindows()).filter((w) => w.title === 'Marey smoke target');
    if (windows.length === 2) break;
    await sleep(50);
  }
  assert.equal(windows.length, 2);
  await assert.rejects(captureImage({ region: 'window', title: 'Marey smoke target' }), /ambiguous/);
  const window = windows[0];
  const image = await captureImage({ region: 'window', windowId: window.id, rect: { x: 5, y: 5, w: 100, h: 60 } });
  assert.equal(image.image.width, 100); assert.equal(image.image.height, 60);
  assert.equal(image.target.windowId, window.id);

  // Exercise the shipped MCP server, including retained evidence after a real
  // target disappears while an open-ended recording is active.
  const server = spawn(process.execPath, [path.resolve('src/server.mjs')]);
  children.push(server); server.stderr.resume();
  let buffer = ''; const pending = new Map(); let sequence = 0;
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk; let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 5000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-11-25' });
  const recording = await rpc('tools/call', { name: 'record', arguments: { seconds: 0.3, fps: 20, rect: { x: 0, y: 0, w: 200, h: 100 } } });
  assert.ok(recording.result.structuredContent.actual.fps >= 15);
  assert.equal(recording.result.structuredContent.target.bounds.width, 200);
  assert.match(recording.result.content[1].text, /achieved/);
  const opening = await rpc('tools/call', { name: 'start_recording', arguments: { fps: 20, region: 'window', windowId: window.id } });
  assert.equal(opening.result.structuredContent.target.windowId, window.id);
  await exec('xdotool', ['windowunmap', window.id]);
  await sleep(200);
  const partial = await rpc('tools/call', { name: 'stop_recording', arguments: {} });
  assert.equal(partial.result.isError, true);
  assert.equal(partial.result.structuredContent.state, 'failed');
  assert.equal(partial.result.structuredContent.completionReason, 'backend-exited');
  assert.equal(partial.result.content[0].type, 'image', 'failed stream retains its captured pixels');
  assert.match(partial.result.content[1].text, /Error:/);
  assert.ok((await listWindows()).find((w) => w.id === window.id)?.hidden);
  await assert.rejects(captureImage({ region: 'window', windowId: window.id }), /hidden/);
});
