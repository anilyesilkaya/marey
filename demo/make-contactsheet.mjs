// Render a staged interaction at fixed times with Chrome's debugging pipe,
// then compose it with Marey. Fixture times are not acquisition measurements.
// The README hero wraps the real frames in explanatory labels and a dashed
// clipped-label annotation; the full contact sheet contains the raw frames.
// Usage: node demo/make-contactsheet.mjs
// Optional: CHROME_BIN=/path/to/chrome (Chrome, Chromium, or Edge).
// Containers without browser sandbox support: add --no-sandbox.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { decodePng, encodePng } from '../src/png.mjs';
import { composeContactSheet } from '../src/contactsheet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(here, 'frames');
const WIDTH = 480, HEIGHT = 420, FPS = 25, COUNT = 20;
const candidates = [
  process.env.CHROME_BIN,
  'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const chrome = candidates.find((candidate) => {
  if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) return false;
  return spawnSync(candidate, ['--version'], { timeout: 10000, windowsHide: true }).status === 0;
});
if (!chrome) throw new Error('Install Chrome/Chromium/Edge, or set CHROME_BIN to its executable.');

mkdirSync(framesDir, { recursive: true });
// Serve only the fixture on loopback; managed browsers may disable file URLs.
const html = readFileSync(path.join(here, 'menu-clipping.html'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const fixture = new URL(`http://127.0.0.1:${server.address().port}/?t=0`);
const profile = mkdtempSync(path.join(os.tmpdir(), 'marey-demo-chrome-'));
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--force-device-scale-factor=1', '--force-color-profile=srgb',
  ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : []),
  `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_CONFIG_HOME: path.join(profile, 'config') },
});
let diagnostics = '', input = '', sequence = 0;
const pending = new Map();
browser.stderr.setEncoding('utf8');
browser.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
function rejectPending(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
browser.on('error', rejectPending);
browser.on('exit', (code) => rejectPending(new Error(`Browser exited (${code}): ${diagnostics}`)));
browser.stdio[4].setEncoding('utf8');
browser.stdio[4].on('data', (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\0')) !== -1) {
    const message = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser timed out: ${method}\n${diagnostics}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

const frames = [];
try {
  await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  const navigation = await send('Page.navigate', { url: fixture.href }, sessionId);
  if (navigation.errorText) throw new Error(`Fixture navigation failed: ${navigation.errorText}`);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try {
      const check = await send('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(fixture.href)} && typeof renderAt === 'function'`,
        returnByValue: true,
      }, sessionId);
      ready = check.result?.value === true;
    } catch (error) {
      if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Browser did not load the fixture script.');
  await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
  for (let i = 0; i < COUNT; i++) {
    const timeMs = i * 1000 / FPS;
    const state = await send('Runtime.evaluate', {
      expression: `renderAt(${timeMs}); ({
        open: !document.getElementById('menu').hidden,
        clipped: Array.from(document.querySelectorAll('#menu button')).some((button) => button.scrollWidth > button.clientWidth)
      })`, returnByValue: true,
    }, sessionId);
    if (state.exceptionDetails || state.result?.value?.open !== (timeMs >= 320) || state.result?.value?.clipped !== (timeMs >= 440)) {
      throw new Error(`Unexpected menu state at ${timeMs}ms: ${JSON.stringify(state)}`);
    }
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    }, sessionId);
    const buffer = Buffer.from(data, 'base64');
    const image = decodePng(buffer);
    if (image.width !== WIDTH || image.height !== HEIGHT) throw new Error(`Unexpected screenshot size: ${image.width}x${image.height}`);
    const out = path.join(framesDir, `frame_${String(i + 1).padStart(3, '0')}_${String(timeMs).padStart(5, '0')}ms.png`);
    writeFileSync(out, buffer);
    frames.push({ image, index: i + 1, timeMs });
    process.stderr.write(`rendered frame ${i + 1}/${COUNT} @ ${timeMs}ms\n`);
  }
  saveSheet('contactsheet.png', frames, 4);

  // Measure the actual menu so the editorial outline marks its exact location.
  const menuBounds = await send('Runtime.evaluate', {
    expression: `renderAt(480); document.getElementById('menu').getBoundingClientRect().toJSON()`,
    returnByValue: true,
  }, sessionId);
  const bounds = menuBounds.result?.value;
  if (!bounds?.width || !bounds?.height) throw new Error('Cannot locate the menu for the explanatory annotation.');
  const heroIndices = [8, 10, 13]; // 0.28s, 0.36s, 0.48s.
  const sheet = composeContactSheet(heroIndices.map((index) => frames[index - 1]), { cols: 3, thumbWidth: WIDTH });
  const replacements = {
    SHEET: encodePng(sheet.width, sheet.height, sheet.data).toString('base64'),
    LEFT: 16 + 2 * (WIDTH + 8) + bounds.x,
    TOP: 16 + bounds.y,
    WIDTH: bounds.width,
    HEIGHT: bounds.height,
  };
  const heroHtml = readFileSync(path.join(here, 'menu-hero.html'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (match, key) => String(replacements[key]));
  await send('Emulation.setDeviceMetricsOverride', { width: sheet.width, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
  const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: heroHtml }, sessionId);
  const heroReady = await send('Runtime.evaluate', {
    expression: `Promise.all([document.fonts.ready, ...Array.from(document.images, (image) => image.decode())])`,
    awaitPromise: true,
  }, sessionId);
  if (heroReady.exceptionDetails) throw new Error('The annotated hero failed to load its contact sheet.');
  const hero = await send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: sheet.width, height: 760, scale: 1 },
  }, sessionId);
  writeFileSync(path.join(here, 'contactsheet-hero.png'), Buffer.from(hero.data, 'base64'));
  process.stderr.write(`contactsheet-hero.png: ${sheet.width}x760 (annotated)\n`);
} finally {
  const exited = once(browser, 'exit');
  browser.kill();
  const killTimer = setTimeout(() => browser.kill('SIGKILL'), 2000);
  if (browser.exitCode === null && browser.signalCode === null) await exited;
  clearTimeout(killTimer);
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

function saveSheet(name, selected, cols) {
  const sheet = composeContactSheet(selected, { cols, thumbWidth: WIDTH });
  writeFileSync(path.join(here, name), encodePng(sheet.width, sheet.height, sheet.data));
  process.stderr.write(`${name}: ${sheet.width}x${sheet.height}\n`);
}
