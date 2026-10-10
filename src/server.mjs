#!/usr/bin/env node
// Marey — an MCP server that gives AI agents eyes for motion.
//
// Hand-rolled MCP (JSON-RPC 2.0 over stdio). Zero npm runtime dependencies:
// everything below is Node builtins + this project's own modules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServer } from './jsonrpc.mjs';
import { record, capture, getFrame, startRecording, stopRecording, recordingStatus, observe, replay, getFrames } from './recorder.mjs';
import { listWindows, detectBackend } from './capture.mjs';
import { TargetUnavailableError } from './capture.mjs';
import { recordingMetadata, evidenceSummary } from './evidence.mjs';

// Single source of truth for the version: package.json. Keeps the version
// reported over MCP in sync with the published npm package automatically.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
let protocolVersion = '2024-11-05';
const structured = (value) => protocolVersion >= '2025-06-18' ? { structuredContent: value } : {};
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
        fps: { type: 'number', description: 'Target frames per second (default 15). Check achieved FPS and gaps in the result; short events can still fall between frames.' },
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
        fps: { type: 'number', description: 'Target frames per second (default 15). Check achieved FPS and gaps in the result; short events can still fall between frames.' },
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
        fps: { type: 'number', description: 'Target frames per second (default 15). Check achieved FPS and gaps in the result; short events can still fall between frames.' },
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
    name: 'replay',
    description:
      'Watch the USER with an instant-replay buffer, hands-free. Like observe, ' +
      'but instead of recording the whole session it keeps only the last few ' +
      'seconds in a rolling buffer; whenever the user clicks MARK (or runs ' +
      '`marey mark`) the moment that just happened is saved as a clip. Use this ' +
      'for "it just glitched — did you see that?": the bug is unpredictable or ' +
      'intermittent, so the user cannot start a recording before it happens. ' +
      'You call replay, tell the user to click Mark right after each glitch and ' +
      'Finish when done, and you receive one contact sheet per marked moment. ' +
      'Multiple marks return multiple clips. A max-duration safety limit always ' +
      'returns. If no browser can open, the control URL is printed to the server ' +
      'log and the user can mark/finish with `marey mark` / `marey finish`.',
    inputSchema: {
      type: 'object',
      properties: {
        fps: { type: 'number', description: 'Target frames per second (default 15). Check achieved FPS and gaps in the result; short events can still fall between frames. The rolling buffer holds windowSeconds × fps frames.' },
        windowSeconds: { type: 'number', description: 'Look-back window kept in the rolling buffer, in seconds (default 20, max 120). Each Mark saves the frames from the last this-many seconds.' },
        region: { type: 'string', enum: ['primary', 'virtual', 'window'], description: 'Capture region (default primary).' },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        maxSeconds: { type: 'number', description: 'Safety cap: auto-finish after this many seconds if the user never clicks Finish (default 600, max 1800).' },
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
      'without filesystem access.\n' +
      'To ZOOM IN on part of a frame, pass `crop`. Easiest is a normalized ' +
      'rectangle — fractions 0..1 of the frame — so you can target a region you ' +
      'see on the contact sheet without knowing the exact pixel size: e.g. ' +
      '{"normalized":true,"x":0.5,"y":0,"w":0.5,"h":0.5} is the top-right ' +
      'quadrant. The crop is returned at full resolution, so a small UI detail ' +
      'becomes legible without transferring the whole frame.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Recording directory from a `record` result (its "dir" / "Frames saved under" path).' },
        index: { type: 'number', description: '1-based frame number to fetch (e.g. 4 for frame #004). Required when using `dir`.' },
        path: { type: 'string', description: 'Direct path to a frame PNG, as an alternative to dir + index.' },
        crop: {
          type: 'object',
          description: 'Optional sub-rectangle to return at full resolution. Omit to get the whole frame.',
          properties: {
            normalized: { type: 'boolean', description: 'When true, x/y/w/h are fractions of the frame (0..1). When false/omitted, they are pixels.' },
            x: { type: 'number', description: 'Left edge of the crop (fraction if normalized, else pixels). Default 0.' },
            y: { type: 'number', description: 'Top edge of the crop (fraction if normalized, else pixels). Default 0.' },
            w: { type: 'number', description: 'Crop width (fraction if normalized, else pixels). Default: to the right edge.' },
            h: { type: 'number', description: 'Crop height (fraction if normalized, else pixels). Default: to the bottom edge.' },
          },
        },
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

const WINDOW_ID_SCHEMA = { type: 'string', description: 'Stable native window ID from list_windows. Preferred over title; requires region:"window".' };
const RECT_SCHEMA = { type: 'object', description: 'Capture only this rectangle, in pixels relative to the selected display/window. Applied during recording, not only to output thumbnails.',
  properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, w: { type: 'integer', minimum: 1 }, h: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false };
for (const tool of TOOLS) {
  if (['record', 'capture', 'start_recording', 'observe', 'replay'].includes(tool.name)) {
    Object.assign(tool.inputSchema.properties, { windowId: WINDOW_ID_SCHEMA, rect: RECT_SCHEMA });
  }
  if (['record', 'stop_recording', 'observe', 'replay'].includes(tool.name)) {
    tool.outputSchema = { type: 'object', properties: { quality: { type: 'object' }, actual: { type: 'object' }, target: { type: 'object' }, warnings: { type: 'array', items: { type: 'string' } }, errors: { type: 'array', items: { type: 'string' } } }, required: ['quality', 'actual', 'target'] };
  }
}
TOOLS.push({ name: 'get_frames', description: 'Inspect a chronological time range from a recording as one contact sheet. Preserves before/changed/after neighborhoods. Use to investigate a transition without calling get_frame separately for every frame. Times are acquisition milliseconds, not frame numbers. Original frames remain available with get_frame.',
  inputSchema: { type: 'object', properties: {
    dir: { type: 'string', description: 'Recording directory from a record/replay result.' },
    startMs: { type: 'number', minimum: 0, description: 'Inclusive start time in milliseconds (default 0).' },
    endMs: { type: 'number', minimum: 0, description: 'Inclusive end time in milliseconds (default last frame).' },
    maxFrames: { type: 'integer', minimum: 2, maximum: 36, description: 'Maximum displayed frames (default 12). If fewer fit, selection retains transition context.' },
    crop: TOOLS.find((t) => t.name === 'get_frame').inputSchema.properties.crop,
  }, required: ['dir'] } });

const server = new StdioServer();

// --- lifecycle -------------------------------------------------------------

server.method('initialize', async (params) => {
  protocolVersion = params?.protocolVersion == null ? '2024-11-05'
    : PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
  return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
});

// Notification after initialize completes; nothing to do.
server.method('notifications/initialized', async () => {});

server.method('ping', async () => ({}));

// --- tools -----------------------------------------------------------------

server.method('tools/list', async () => ({ tools: TOOLS.map((tool) => {
  if (protocolVersion >= '2025-06-18') return tool;
  const { outputSchema, ...legacy } = tool; return legacy;
}) }));

server.method('tools/call', async (params) => {
  // params itself must be a well-formed tools/call. A missing/invalid tool name
  // is a PROTOCOL error (the client sent a malformed request).
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw Object.assign(new Error('Invalid tools/call: `name` is required'), { code: -32602 });
  }
  const { name, arguments: rawArgs } = params;
  // Arguments, when present, must be an object; tolerate omission.
  if (rawArgs != null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    throw Object.assign(new Error('Invalid tools/call: arguments must be an object'), { code: -32602 });
  }
  const args = rawArgs || {};

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
      case 'replay':
        return handleReplay(args);
      case 'capture':
        return handleCapture(args);
      case 'list_windows':
        return handleListWindows();
      case 'get_frame':
        return handleGetFrame(args);
      case 'get_frames':
        return handleGetFrames(args);
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
    `stop_recording to get the contact sheet.\nRecording dir: ${s.dir}\nResolved target: ${JSON.stringify(s.target)}`;
  return { ...structured(s), content: [{ type: 'text', text }] };
}

async function handleStopRecording() {
  const result = await stopRecording();
  const note = result.capped ? ` (stopped automatically: ${result.completionReason})` : '';
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

async function handleReplay(args) {
  const result = await replay({
    ...args,
    onUrl: (url, opened) => {
      server.log(`[marey] replay control page: ${url}` +
        (opened ? ' (opened in your browser)' : ' (open this URL, or run `marey mark` / `marey finish`)'));
    },
  });
  return replayResult(result);
}

// Formatter for a replay result: one contact-sheet image per marked clip,
// followed by a summary that locates every clip's frames for get_frame. Falls
// back to the single-sheet formatter if (somehow) there are no clips.
function replayResult(result) {
  const clips = result.clips || [];
  if (clips.length === 0) return contactSheetResult(result, 'Replay captured');

  const how =
    result.observation === 'cancelled' ? 'Replay cancelled by the user'
    : result.observation === 'timed-out' ? 'Replay hit its time limit'
    : 'Replay finished by the user';

  const content = [];
  const sections = [];
  clips.forEach((clip, i) => {
    content.push(imageContent(clip.contactSheet.buffer));
    const frameList = clip.frames
      .map((f) => `    #${String(f.index).padStart(3, '0')}  ${(f.timeMs / 1000).toFixed(2)}s  ${f.path}`)
      .join('\n');
    sections.push(
      `Clip ${i + 1} of ${clips.length} (marker #${clip.markIndex}) — ` +
      `${clip.frameCount} frames over the ${(clip.windowMs / 1000).toFixed(0)}s before the mark, ` +
      `shown ${clip.contactSheet.composedFrames}.\n` +
      `  Contact sheet: ${clip.contactSheet.width}×${clip.contactSheet.height}px → ${clip.contactSheetPath}\n` +
      `  Full-resolution frames (get_frame with this dir + the frame number):\n${frameList}`,
    );
  });

  const summary =
    `${how}: ${clips.length} clip${clips.length === 1 ? '' : 's'} from ` +
    `${result.frameCount} buffered frames (${result.region}` +
    `${result.title ? ` · "${result.title}"` : ''}, ${result.fps} fps).\n` +
    (result.evictedFrames ? `${result.evictedFrames} older frames were evicted from the rolling buffer.\n` : '') +
    `Detail: ${result.detail} (${result.cols} cols @ ${result.thumbWidth}px). ` +
    `One contact sheet per marked moment is shown above, in order.\n` +
    `\nIf fine detail is not legible, call get_frame to fetch a specific frame at ` +
    `full resolution (dir below + the frame number), or re-run with detail:"high"/"max".\n` +
    `\nRecording dir: ${result.dir}\n\n${sections.join('\n\n')}`;

  content.push({ type: 'text', text: `${summary}\n\n${evidenceSummary(result)}` });
  return { content, ...structured(recordingMetadata(result)), ...(result.state === 'failed' ? { isError: true } : {}) };
}

// Shared formatter for record / stop_recording: a contact-sheet image plus a
// summary that surfaces every frame's full-resolution path, so the agent can
// fetch the exact frame it needs via get_frame when the overview is too small.
function contactSheetResult(result, verb) {
  const frameList = result.frames
    .map((f) => `  #${String(f.index).padStart(3, '0')}  ${(f.timeMs / 1000).toFixed(2)}s  ${f.path}`)
    .join('\n');

  const summary =
    `${verb} ${result.frameCount} frames through ${result.seconds.toFixed(2)}s ` +
    `(${result.region}` +
    `${result.title ? ` · "${result.title}"` : ''}).\n` +
    `Detail: ${result.detail} (${result.cols} cols @ ${result.thumbWidth}px). ` +
    `Contact sheet: ${result.contactSheet.width}×${result.contactSheet.height}px.\n` +
    `\nThe contact sheet below is a downscaled overview. If fine detail or small ` +
    `text is not legible, call get_frame to fetch a specific frame at full ` +
    `resolution (dir below + the frame number), or re-record with ` +
    `detail:"high"/"max" or region:"window".\n` +
    `\nRecording dir: ${result.dir}\n` +
    `Full-resolution frames (use get_frame with this dir + the frame number):\n${frameList}\n` +
    `\nContact sheet: ${result.contactSheetPath}\n\n${evidenceSummary(result)}`;

  return {
    ...structured(recordingMetadata(result)),
    ...(result.state === 'failed' ? { isError: true } : {}),
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
    `Saved: ${result.path}\nActual target: ${JSON.stringify(result.target)}`;

  return {
    ...structured({ target: result.target, backend: result.backend, width: result.width, height: result.height, path: result.path }),
    content: [
      imageContent(result.image.buffer),
      { type: 'text', text: summary },
    ],
  };
}

async function handleGetFrame(args) {
  const frame = await getFrame(args);
  const summary = frame.crop
    ? `Cropped frame at full resolution: ${frame.width}×${frame.height}px ` +
      `(region ${frame.crop.x},${frame.crop.y} ${frame.crop.w}×${frame.crop.h} ` +
      `from a ${frame.source.width}×${frame.source.height}px frame).\n${frame.path}`
    : `Frame at full resolution: ${frame.width}×${frame.height}px.\n${frame.path}`;
  return {
    content: [
      imageContent(frame.buffer),
      { type: 'text', text: summary },
    ],
  };
}

async function handleGetFrames(args) {
  const result = await getFrames(args);
  const { image, ...metadata } = result;
  return { ...structured(metadata), content: [imageContent(image.buffer), { type: 'text', text:
    `Time range ${args.startMs ?? 0}–${args.endMs ?? 'last'}ms: showing ${result.frames.length} of ${result.availableFrames} recorded frames.\n` +
    result.frames.map((f) => `#${String(f.index).padStart(3, '0')} @ ${f.timeMs.toFixed(1)}ms`).join('\n') +
    `\nRecording dir: ${result.dir}\n${[...result.warnings, ...result.captureWarnings, ...result.captureErrors].join('\n')}\nCapture quality: ${JSON.stringify(result.quality)}; range quality: ${JSON.stringify(result.rangeQuality)}. Gaps contain no visual evidence; use get_frame for originals.` }] };
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
          return `• ID ${w.id ?? 'unavailable'}: ${w.title}${proc}${geo}${w.hidden ? ' [hidden/minimized — cannot capture]' : ''}`;
        })
        .join('\n')
    : '(no windows reported by this platform/backend)';

  return {
    ...structured({ backend, windows }),
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

server.log(`[marey] MCP server ready (protocol negotiation enabled). Awaiting stdio.`);
server.listen();
