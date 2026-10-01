// Build the README demo contact sheet DETERMINISTICALLY and PRIVATELY.
//
// Why not a live Marey screen recording? On a real workstation a live capture
// grabs whatever is on the desktop (a privacy risk) and loses the window when
// focus changes. Instead we render the demo fixture headlessly at fixed
// timestamps — Chrome never touches the desktop — and compose the frames with
// Marey's OWN contact-sheet code. The result is byte-for-byte the same artifact
// a live `record` would produce: identical caption bar, layout, and labels.
//
// Usage:  node demo/make-contactsheet.mjs
// Output: demo/contactsheet.png  (+ demo/frames/frame_*.png)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodePng, encodePng } from '../src/png.mjs';
import { composeContactSheet } from '../src/contactsheet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(here, 'frames');
const fixture = 'file:///' + path.join(here, 'jump-bug.html').replace(/\\/g, '/');

// Recording shape: 4 s at 4 fps = 16 frames (matches the README narrative and
// keeps the sheet readable). timeMs is the real elapsed time of each frame.
const FPS = 4;
const SECONDS = 4;
const COUNT = FPS * SECONDS;
const STEP_MS = 1000 / FPS;

// Resolve a Chrome/Edge binary.
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CANDIDATES.find(existsSync);
if (!chrome) throw new Error('No Chrome/Edge found; set a path in CANDIDATES.');

mkdirSync(framesDir, { recursive: true });

const frames = [];
for (let i = 0; i < COUNT; i++) {
  const timeMs = Math.round(i * STEP_MS);
  const out = path.join(framesDir, `frame_${String(i + 1).padStart(3, '0')}_${String(timeMs).padStart(5, '0')}ms.png`);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=940,600',
    `--screenshot=${out}`,
    `${fixture}?t=${timeMs}`,
  ], { stdio: 'ignore' });

  const image = decodePng(readFileSync(out));
  frames.push({ image, index: i + 1, timeMs });
  process.stderr.write(`captured frame ${i + 1}/${COUNT} @ ${timeMs}ms\n`);
}

// Compose with Marey's real compositor. "high" detail preset: 2 cols @ 760px.
const sheet = composeContactSheet(frames, { cols: 2, thumbWidth: 760 });
const sheetPath = path.join(here, 'contactsheet.png');
writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.data));
process.stderr.write(`\nfull contact sheet: ${sheetPath} (${sheet.width}x${sheet.height})\n`);

// Hero sheet for the top of the README: a landscape re-compose of the six
// frames that tell the story (Marey can re-layout saved frames without
// re-recording). 1-based indices: track, arm-guide, JUMP, pinned, overtaken, hold.
const HERO = [6, 7, 8, 11, 13, 16];
const heroFrames = HERO.map((n, i) => ({ ...frames[n - 1], index: n }));
const hero = composeContactSheet(heroFrames, { cols: 3, thumbWidth: 620 });
const heroPath = path.join(here, 'contactsheet-hero.png');
writeFileSync(heroPath, encodePng(hero.width, hero.height, hero.data));
process.stderr.write(`hero contact sheet: ${heroPath} (${hero.width}x${hero.height})\n`);
