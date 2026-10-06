#!/usr/bin/env node
// Thin CLI around the recorder, for exercising Marey without an MCP client.
//
//   node src/cli.mjs record    --seconds 5 --fps 2 --region primary --detail high
//   node src/cli.mjs observe   --fps 3 --detail high   (opens a control page; Finish to end)
//   node src/cli.mjs replay    --window-seconds 20 --fps 3   (rolling buffer; Mark to clip)
//   node src/cli.mjs session   --for 8 --fps 4 --detail high   (Ctrl+C stops early)
//   node src/cli.mjs capture   --region window --title "Visual Studio"
//   node src/cli.mjs get-frame --dir captures/20260101-120000 --index 4
//   node src/cli.mjs get-frame --dir ... --index 4 --normalized --crop-x 0.5 --crop-w 0.5  (zoom)
//   node src/cli.mjs mark      (pin the current replay window into a clip)
//   node src/cli.mjs finish    (end the active observation; alias: stop)
//   node src/cli.mjs windows
//   node src/cli.mjs backend
//   node src/cli.mjs doctor    (diagnose capture capability on this machine)

import os from 'node:os';
import { record, capture, getFrame, startRecording, stopRecording, observe, replay } from './recorder.mjs';
import { listWindows, detectBackend, captureCapabilities, captureFrame } from './capture.mjs';
import { signalControl, readControlRegistry } from './control.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A flag value counts as "off" when it is the string "false"/"0"/"no" or the
// number 0. (parseArgs yields strings/numbers, never real booleans except for a
// bare flag, which means "on".)
function isFalsey(v) {
  if (v === undefined) return false;
  if (v === 0) return true;
  if (typeof v === 'string') return /^(false|0|no|off)$/i.test(v);
  return false;
}

// Build a getFrame crop rectangle from CLI flags, or return undefined when no
// crop flag is present. --normalized makes x/y/w/h fractions of the frame.
function buildCropArg(args) {
  const keys = ['crop-x', 'crop-y', 'crop-w', 'crop-h'];
  if (!keys.some((k) => args[k] !== undefined)) return undefined;
  return {
    normalized: !!args.normalized && !isFalsey(args.normalized),
    x: args['crop-x'],
    y: args['crop-y'],
    w: args['crop-w'],
    h: args['crop-h'],
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = /^-?\d*\.?\d+$/.test(next) ? Number(next) : next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (command) {
    case 'record': {
      const r = await record(args);
      console.log(`Recorded ${r.frameCount} frames in ${(r.elapsedMs / 1000).toFixed(2)}s`);
      console.log(`Contact sheet: ${r.contactSheetPath}`);
      console.log(`Frames dir:    ${r.dir}`);
      break;
    }
    case 'capture': {
      const r = await capture(args);
      console.log(`Captured ${r.width}×${r.height} → ${r.path}`);
      break;
    }
    case 'get-frame': {
      // Optional crop: --crop-x/-y/-w/-h (pixels, or fractions with --normalized).
      const crop = buildCropArg(args);
      const r = await getFrame({ ...args, crop });
      if (r.crop) {
        console.log(
          `Frame ${r.width}×${r.height} (crop ${r.crop.x},${r.crop.y} ` +
          `${r.crop.w}×${r.crop.h} of ${r.source.width}×${r.source.height}) → ${r.path}`,
        );
      } else {
        console.log(`Frame ${r.width}×${r.height} (full resolution) → ${r.path}`);
      }
      break;
    }
    case 'session': {
      // Demonstrate the open-ended start/stop session from the CLI: start, keep
      // recording for --for seconds (press Ctrl+C to stop early), then stop.
      const held = typeof args.for === 'number' ? args.for : 5;
      const s = await startRecording(args);
      console.log(`Recording started (${s.region}) at ${s.fps} fps → ${s.dir}`);
      let stopping = false;
      const finish = async () => {
        if (stopping) return;
        stopping = true;
        const r = await stopRecording();
        console.log(`Stopped: ${r.frameCount} frames over ${r.seconds.toFixed(2)}s`);
        console.log(`Contact sheet: ${r.contactSheetPath}`);
        process.exit(0);
      };
      process.on('SIGINT', finish);
      console.log(`Recording for ${held}s (Ctrl+C to stop early)...`);
      await sleep(held * 1000);
      await finish();
      break;
    }
    case 'observe': {
      // Start an observation: open the local control page and block until the
      // user clicks Finish/Cancel (or `marey finish` is run), or the deadline.
      // --no-open, --open false, or --open 0 suppress auto-opening the browser.
      const open = args['no-open'] ? false : !isFalsey(args.open);
      console.log('Starting observation — reproduce the issue, then click Finish (or run `marey finish`).');
      const result = await observe({
        ...args,
        open,
        onUrl: (url, opened) => {
          console.log(opened ? `Control page opened: ${url}` : `Open this URL to finish: ${url}`);
        },
      });
      const how = result.observation === 'cancelled' ? 'cancelled'
        : result.observation === 'timed-out' ? 'timed out' : 'finished';
      console.log(`Observation ${how}: ${result.frameCount} frames over ${result.seconds.toFixed(2)}s`);
      console.log(`Contact sheet: ${result.contactSheetPath}`);
      console.log(`Frames dir:    ${result.dir}`);
      break;
    }
    case 'replay': {
      // Rolling instant-replay buffer: keep only the last --window-seconds of
      // frames; Mark (button, M/Space, or `marey mark`) pins the current window
      // into a clip. Finish/Cancel ends it and composes one sheet per clip.
      const open = args['no-open'] ? false : !isFalsey(args.open);
      console.log('Starting replay — reproduce the issue, then click Mark (or run `marey mark`) to save the moment. Finish when done.');
      const result = await replay({
        ...args,
        windowSeconds: args['window-seconds'],
        open,
        onUrl: (url, opened) => {
          console.log(opened ? `Control page opened: ${url}` : `Open this URL to mark/finish: ${url}`);
        },
      });
      const how = result.observation === 'cancelled' ? 'cancelled'
        : result.observation === 'timed-out' ? 'timed out' : 'finished';
      const clips = result.clips || [];
      console.log(`Replay ${how}: ${clips.length} clip${clips.length === 1 ? '' : 's'} from ${result.frameCount} buffered frames.`);
      clips.forEach((c, i) => {
        console.log(`  Clip ${i + 1} (marker #${c.markIndex}): ${c.frameCount} frames → ${c.contactSheetPath}`);
      });
      console.log(`Frames dir: ${result.dir}`);
      break;
    }
    case 'mark': {
      // Pin the current replay window into a clip, from any terminal. Leaves the
      // recording running (unlike finish/stop).
      const r = await signalControl('mark');
      if (r.ok) {
        console.log(r.frameCount
          ? `Marked clip #${r.markIndex} (${r.frameCount} frames).`
          : `Mark registered${r.note ? ` (${r.note})` : ''}.`);
      } else {
        console.log(r.error);
        process.exit(1);
      }
      break;
    }
    case 'finish':
    case 'stop': {
      // Signal the active observation (running in the MCP server or a separate
      // `observe` process) to finish/cancel. This is the out-of-band control.
      const action = command === 'stop' && args.cancel ? 'cancel' : 'finish';
      const r = await signalControl(action);
      if (r.ok) {
        console.log(`Observation ${r.reason}${r.sessionId ? ` (${r.sessionId})` : ''}.`);
      } else {
        console.log(r.error);
        process.exit(1);
      }
      break;
    }
    case 'doctor': {
      await runDoctor();
      break;
    }
    case 'windows': {
      const windows = await listWindows();
      if (!windows.length) {
        console.log('(no windows reported)');
        break;
      }
      for (const w of windows) {
        const geo = w.width != null ? ` [${w.width}×${w.height} @ ${w.x},${w.y}]` : '';
        console.log(`• ${w.title}${w.process ? ` (${w.process})` : ''}${geo}`);
      }
      break;
    }
    case 'backend': {
      console.log(await detectBackend());
      break;
    }
    default:
      console.log('Usage: marey <record|observe|replay|session|capture|get-frame|mark|finish|windows|backend|doctor> [--flags]');
      process.exit(command ? 1 : 0);
  }
}

// `marey doctor` — diagnose whether capture actually works on THIS machine.
// Beyond detecting which backend tool exists, it performs a REAL single-frame
// capture probe (the only honest proof capture works) and reports an active
// observation if one is running. Exit code is non-zero if the probe fails.
async function runDoctor() {
  console.log('Marey doctor\n────────────');
  console.log(`Platform:     ${process.platform} (${process.arch})`);
  console.log(`Node:         ${process.version}`);

  let caps;
  try {
    caps = await captureCapabilities();
    console.log(`Backend:      ${caps.backend}`);
    console.log(`Regions:      ${caps.regions.join(', ')}`);
    console.log(`Window grab:  ${caps.windowCapture ? 'yes' : 'no (primary/virtual only)'}`);
  } catch (err) {
    console.log(`Backend:      detection failed: ${err.message}`);
  }

  // The real test: can we actually acquire a frame right now?
  let probeOk = false;
  process.stdout.write('Capture probe: ');
  try {
    const t0 = Date.now();
    const img = await captureFrame({ region: 'primary' });
    const ms = Date.now() - t0;
    probeOk = img && img.width > 0 && img.height > 0;
    console.log(probeOk
      ? `ok — grabbed ${img.width}×${img.height} in ${ms}ms`
      : 'FAILED — backend returned an empty frame');
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
  }

  // Report an in-flight observation, if any (its control page / finish target).
  const reg = readControlRegistry();
  if (reg && reg.port) {
    console.log(`\nActive observation: session ${reg.sessionId || '?'} — control at ${reg.url || `127.0.0.1:${reg.port}`}`);
    console.log('  (run `marey finish` to end it)');
  } else {
    console.log('\nActive observation: none');
  }

  console.log(`\nCaptures dir: ${process.cwd()}/captures`);
  console.log(`Temp dir:     ${os.tmpdir()}`);
  console.log(probeOk ? '\nResult: capture works on this machine. ✓' : '\nResult: capture is NOT working. ✗');
  if (!probeOk) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
