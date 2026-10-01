#!/usr/bin/env node
// Marey — an MCP server that gives AI agents eyes for motion.
//
// Hand-rolled MCP (JSON-RPC 2.0 over stdio). Zero npm runtime dependencies:
// everything below is Node builtins + this project's own modules.

import { StdioServer } from './jsonrpc.mjs';
import { record, capture } from './recorder.mjs';
import { listWindows, detectBackend } from './capture.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'marey', version: '0.1.0' };

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
          description: 'primary monitor, the full virtual desktop, or a window (default primary).',
        },
        title: { type: 'string', description: 'Window-title substring to match when region is "window".' },
        delay: { type: 'number', description: 'Seconds to wait before recording starts (default 0).' },
        cols: { type: 'number', description: 'Thumbnails per contact-sheet row (default 4).' },
        thumbWidth: { type: 'number', description: 'Thumbnail width in pixels (default 480).' },
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
    name: 'list_windows',
    description:
      'List visible windows (title, process, and geometry where available) so ' +
      'a target can be chosen for window capture.',
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
  const { name, arguments: args = {} } = params;
  switch (name) {
    case 'record':
      return handleRecord(args);
    case 'capture':
      return handleCapture(args);
    case 'list_windows':
      return handleListWindows();
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
});

// --- tool handlers ---------------------------------------------------------

async function handleRecord(args) {
  const result = await record(args);
  const summary =
    `Recorded ${result.frameCount} frames over ${result.seconds}s ` +
    `at ${result.fps} fps (${result.region}` +
    `${result.title ? ` · "${result.title}"` : ''}).\n` +
    `Elapsed: ${(result.elapsedMs / 1000).toFixed(2)}s. ` +
    `Contact sheet: ${result.contactSheet.width}×${result.contactSheet.height}px.\n` +
    `Frames saved under: ${result.dir}\n` +
    `Contact sheet: ${result.contactSheetPath}`;

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

// --- boot ------------------------------------------------------------------

server.log(`[marey] MCP server ready (protocol ${PROTOCOL_VERSION}). Awaiting stdio.`);
server.listen();
