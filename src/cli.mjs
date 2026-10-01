#!/usr/bin/env node
// Thin CLI around the recorder, for exercising Marey without an MCP client.
//
//   node src/cli.mjs record    --seconds 5 --fps 2 --region primary --detail high
//   node src/cli.mjs session   --for 8 --fps 4 --detail high   (Ctrl+C stops early)
//   node src/cli.mjs capture   --region window --title "Visual Studio"
//   node src/cli.mjs get-frame --dir captures/20260101-120000 --index 4
//   node src/cli.mjs windows
//   node src/cli.mjs backend

import { record, capture, getFrame, startRecording, stopRecording } from './recorder.mjs';
import { listWindows, detectBackend } from './capture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const r = await getFrame(args);
      console.log(`Frame ${r.width}×${r.height} (full resolution) → ${r.path}`);
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
      console.log('Usage: marey <record|session|capture|get-frame|windows|backend> [--flags]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
