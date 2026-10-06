#!/usr/bin/env node
// Marey — an MCP server that gives AI agents eyes for motion.
//
// Hand-rolled MCP (JSON-RPC 2.0 over stdio). Zero npm runtime dependencies:
// everything below is Node builtins + this project's own modules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServer } from './jsonrpc.mjs';
import { record, capture, getFrame, startRecording, stopRecording, recordingStatus, observe } from './recorder.mjs';
import { listWindows, detectBackend } from './capture.mjs';
import { TargetUnavailableError } from './capture.mjs';

// Single source of truth for the version: package.json. Keeps the version
// reported over MCP in sync with the published npm package automatically.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'marey', version: pkg.version };

const TOOLS = [
  {
    name: 'record',
    description:
      'Record the screen for a fixed duration and return a numbered, ' +
      'timestamped contact sheet (a grid of still frames) as an image. Use ' +
      'this to inspect motion: dragging, animations, flashes, reordering, ' +
      'anything that cannot be understood from a single screenshot. Raw ' +
      'frames are also saved to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Recording duration in seconds (default 5).' },
        fps: { type: 'number', description: 'Frames captured per second (default 2).' },
        region: {
          type: 'string',
          enum: ['primary', 'virtual', 'window'],
          description: 'primary monitor, the full virtual desktop, or a window (default primary). Prefer "window" when a single app is involved: a smaller source means each thumbnail keeps more detail.',
        },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        delay: { type: 'number', description: 'Seconds to wait before recording starts (default 0).' },
        detail: {
          type: 'string',
          enum: ['overview', 'high', 'max'],
          description:
            'Legibility preset for the contact sheet (default "overview"). A returned image has a fixed resolution budget split across columns, so fewer/wider cells show more. "overview" = 4 cols @ 480px (many frames at a glance); "high" = 2 cols @ 760px (UI text usually readable); "max" = 1 col @ 1280px (closest to raw frames). Use "high"/"max" when fine detail or small text matters. Explicit cols/thumbWidth override this.',
        },
        cols: { type: 'number', description: 'Thumbnails per contact-sheet row. Overrides the detail preset. Fewer columns = larger, more legible cells.' },
        thumbWidth: { type: 'number', description: 'Thumbnail width in pixels. Overrides the detail preset. Note: has little effect once the sheet exceeds the client\'s inline-image size cap — reduce cols instead.' },
      },
    },
  },
  {
    name: 'capture',
    description:
      'Capture a single screenshot immediately and return it as an image. ' +
      'Uses the same region-selection semantics as record.',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', enum: ['primary', 'virtual', 'window'], description: 'Capture region (default primary).' },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        delay: { type: 'number', description: 'Seconds to wait before capturing (default 0).' },
      },
    },
  },
  {
    name: 'start_recording',
    description:
      'Begin an OPEN-ENDED recording that runs until stop_recording is called. ' +
      'Use this (instead of record) when the USER controls the timing — e.g. ' +
      'they will perform a drag, open a menu, or trigger an animation and you ' +
      'cannot predict how long it takes. Start it on the user\'s cue, tell them ' +
      'to perform the interaction, then call stop_recording. Only one recording ' +
      'may be active at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        fps: { type: 'number', description: 'Frames captured per second (default 2).' },
        region: { type: 'string', enum: ['primary', 'virtual', 'window'], description: 'Capture region (default primary).' },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        delay: { type: 'number', description: 'Seconds to wait before capture begins (default 0).' },
        detail: { type: 'string', enum: ['overview', 'high', 'max'], description: 'Contact-sheet legibility preset (default "overview"). See record.' },
        cols: { type: 'number', description: 'Thumbnails per contact-sheet row. Overrides the detail preset.' },
        thumbWidth: { type: 'number', description: 'Thumbnail width in pixels. Overrides the detail preset.' },
      },
    },
  },
  {
    name: 'stop_recording',
    description:
      'Stop the recording started by start_recording and return the contact ' +
      'sheet (plus full-resolution frame paths), exactly like record. Errors if ' +
      'no recording is in progress.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'observe',
    description:
      'Watch the USER reproduce something, hands-free. Starts a recording, ' +
      'opens a small local control page in their browser, and BLOCKS until they ' +
      'click Finish (or press F) — then returns the contact sheet exactly like ' +
      'record. Use this for the common request "let me show you the bug": you ' +
      'call observe, tell the user to reproduce it and click Finish when done, ' +
      'and you receive the frames. Unlike record you do not guess a duration; ' +
      'unlike start_recording the user ends it themselves (no second tool call ' +
      'from you). A max-duration safety limit always returns. If no browser can ' +
      'open (headless/remote), the control URL is printed to the server log and ' +
      'the user can finish with the `marey finish` command.',
    inputSchema: {
      type: 'object',
      properties: {
        fps: { type: 'number', description: 'Frames captured per second (default 2).' },
        region: { type: 'string', enum: ['primary', 'virtual', 'window'], description: 'Capture region (default primary).' },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        maxSeconds: { type: 'number', description: 'Safety cap: auto-finish after this many seconds if the user never clicks (default 120, max 600).' },
        detail: { type: 'string', enum: ['overview', 'high', 'max'], description: 'Contact-sheet legibility preset (default "overview"). See record.' },
        cols: { type: 'number', description: 'Thumbnails per contact-sheet row. Overrides the detail preset.' },
        thumbWidth: { type: 'number', description: 'Thumbnail width in pixels. Overrides the detail preset.' },
      },
    },
  },
  {
    name: 'list_windows',
    description:
      'List visible windows (title, process, and geometry where available) so ' +
      'a target can be chosen for window capture.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_frame',
    description:
      'Return a single frame from a prior recording at FULL RESOLUTION, as an ' +
      'image. The contact sheet from `record` is a downscaled overview; when it ' +
      'is too small to read fine detail or small text, call this with the ' +
      "recording's directory and the frame number (both are listed in the " +
      '`record` response), or with a direct frame path. This works over MCP ' +
      'without filesystem access.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Recording directory from a `record` result (its "dir" / "Frames saved under" path).' },
        index: { type: 'number', description: '1-based frame number to fetch (e.g. 4 for frame #004). Required when using `dir`.' },
        path: { type: 'string', description: 'Direct path to a frame PNG, as an alternative to dir + index.' },
      },
    },
  },
  {
    name: 'status',
    description:
      'Report whether an open-ended recording (from start_recording) is ' +
      'currently active, and if so its directory, frame count so far, region, ' +
      'and frame rate. Use this to check state before start_recording or ' +
      'stop_recording.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new StdioServer();

// --- lifecycle -------------------------------------------------------------

server.method('initialize', async () => ({
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
}));

// Notification after initialize completes; nothing to do.
server.method('notifications/initialized', async () => {});

server.method('ping', async () => ({}));

// --- tools -----------------------------------------------------------------

server.method('tools/list', async () => ({ tools: TOOLS }));

server.method('tools/call', async (params) => {
  // params itself must be a well-formed tools/call. A missing/invalid tool name
  // is a PROTOCOL error (the client sent a malformed request).
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw Object.assign(new Error('Invalid tools/call: `name` is required'), { code: -32602 });
  }
  const { name, arguments: rawArgs } = params;
  // Arguments, when present, must be an object; tolerate omission.
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};

  const dispatchTool = () => {
    switch (name) {
      case 'record':
        return handleRecord(args);
      case 'start_recording':
        return handleStartRecording(args);
      case 'stop_recording':
        return handleStopRecording();
      case 'observe':
        return handleObserve(args);
      case 'capture':
        return handleCapture(args);
      case 'list_windows':
        return handleListWindows();
      case 'get_frame':
        return handleGetFrame(args);
      case 'status':
        return handleStatus();
      default:
        // Unknown tool is a protocol-level error, not a tool-execution failure.
        throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
  };

  // Tool-EXECUTION failures (capture backend errors, an unavailable window
  // target, a missing frame, no recording in progress) are reported as tool
  // results with isError:true — not as JSON-RPC protocol errors. That is the
  // MCP contract: the model sees an actionable message and can recover, while
  // the connection stays healthy. Only malformed protocol input (handled above
  // and in jsonrpc.mjs) yields a JSON-RPC error.
  try {
    return await dispatchTool();
  } catch (err) {
    if (err && err.code === -32602) throw err; // genuine protocol error → propagate
    return toolError(name, err);
  }
});

// --- tool handlers ---------------------------------------------------------

async function handleRecord(args) {
  return contactSheetResult(await record(args), 'Recorded');
}

async function handleStartRecording(args) {
  const s = await startRecording(args);
  const text =
    `Recording started (${s.region}${s.title ? ` · "${s.title}"` : ''}) at ${s.fps} fps, ` +
    `detail "${s.detail}".\nTell the user to perform the interaction now, then call ` +
    `stop_recording to get the contact sheet.\nRecording dir: ${s.dir}`;
  return { content: [{ type: 'text', text }] };
}

async function handleStopRecording() {
  const result = await stopRecording();
  const note = result.capped ? ' (stopped automatically at the frame cap)' : '';
  return contactSheetResult(result, `Stopped recording${note}; captured`);
}

async function handleObserve(args) {
  // Surface the control URL on the server log so a headless/remote user (no
  // auto-opened browser) can still open the page or run `marey finish`.
  const result = await observe({
    ...args,
    onUrl: (url, opened) => {
      server.log(`[marey] observation control page: ${url}` +
        (opened ? ' (opened in your browser)' : ' (open this URL, or run `marey finish`)'));
    },
  });
  const how =
    result.observation === 'cancelled' ? 'Observation cancelled by the user; captured'
    : result.observation === 'timed-out' ? 'Observation hit its time limit; captured'
    : 'Observation finished by the user; captured';
  return contactSheetResult(result, how);
}

// Shared formatter for record / stop_recording: a contact-sheet image plus a
// summary that surfaces every frame's full-resolution path, so the agent can
// fetch the exact frame it needs via get_frame when the overview is too small.
function contactSheetResult(result, verb) {
  const frameList = result.frames
    .map((f) => `  #${String(f.index).padStart(3, '0')}  ${(f.timeMs / 1000).toFixed(2)}s  ${f.path}`)
    .join('\n');

  const summary =
    `${verb} ${result.frameCount} frames over ${result.seconds.toFixed(2)}s ` +
    `at ${result.fps} fps (${result.region}` +
    `${result.title ? ` · "${result.title}"` : ''}).\n` +
    `Detail: ${result.detail} (${result.cols} cols @ ${result.thumbWidth}px). ` +
    `Contact sheet: ${result.contactSheet.width}×${result.contactSheet.height}px.\n` +
    `\nThe contact sheet below is a downscaled overview. If fine detail or small ` +
    `text is not legible, call get_frame to fetch a specific frame at full ` +
    `resolution (dir below + the frame number), or re-record with ` +
    `detail:"high"/"max" or region:"window".\n` +
    `\nRecording dir: ${result.dir}\n` +
    `Full-resolution frames (use get_frame with this dir + the frame number):\n${frameList}\n` +
    `\nContact sheet: ${result.contactSheetPath}`;

  return {
    content: [
      imageContent(result.contactSheet.buffer),
      { type: 'text', text: summary },
    ],
  };
}

async function handleCapture(args) {
  const result = await capture(args);
  const summary =
    `Captured ${result.width}×${result.height}px (${result.region}` +
    `${result.title ? ` · "${result.title}"` : ''}).\n` +
    `Saved: ${result.path}`;

  return {
    content: [
      imageContent(result.image.buffer),
      { type: 'text', text: summary },
    ],
  };
}

async function handleGetFrame(args) {
  const frame = await getFrame(args);
  const summary = `Frame at full resolution: ${frame.width}×${frame.height}px.\n${frame.path}`;
  return {
    content: [
      imageContent(frame.buffer),
      { type: 'text', text: summary },
    ],
  };
}

async function handleStatus() {
  const s = recordingStatus();
  const text = s.active
    ? `A recording is in progress.\n` +
      `Directory: ${s.dir}\nFrames so far: ${s.frameCount}\n` +
      `Region: ${s.region}${s.title ? ` · "${s.title}"` : ''} at ${s.fps} fps.\n` +
      `Call stop_recording to finish and get the contact sheet.`
    : 'No recording is in progress. Call record (fixed duration) or start_recording (open-ended) to begin.';
  return { content: [{ type: 'text', text }] };
}

async function handleListWindows() {
  const [windows, backend] = await Promise.all([listWindows(), detectBackend()]);
  const lines = windows.length
    ? windows
        .map((w) => {
          const geo =
            w.width != null && w.height != null
              ? ` [${w.width}×${w.height} @ ${w.x ?? '?'},${w.y ?? '?'}]`
              : '';
          const proc = w.process ? ` (${w.process})` : '';
          return `• ${w.title}${proc}${geo}`;
        })
        .join('\n')
    : '(no windows reported by this platform/backend)';

  return {
    content: [
      {
        type: 'text',
        text: `Capture backend: ${backend}\n\nWindows:\n${lines}`,
      },
    ],
  };
}

// --- helpers ---------------------------------------------------------------

function imageContent(pngBuffer) {
  return {
    type: 'image',
    data: pngBuffer.toString('base64'),
    mimeType: 'image/png',
  };
}

// Turn a tool-execution failure into an MCP tool result with isError:true, so
// the model receives an actionable message instead of a dropped request. A
// TargetUnavailableError gets a hint to pick a different target.
function toolError(toolName, err) {
  const base = (err && err.message) ? err.message : String(err);
  let text = `${toolName} failed: ${base}`;
  if (err instanceof TargetUnavailableError) {
    text += '\nUse list_windows to see available targets, or omit `title` and ' +
      'use region "primary"/"virtual".';
  }
  return { content: [{ type: 'text', text }], isError: true };
}

// --- boot ------------------------------------------------------------------

server.log(`[marey] MCP server ready (protocol ${PROTOCOL_VERSION}). Awaiting stdio.`);
server.listen();
