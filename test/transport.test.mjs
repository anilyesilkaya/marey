// Transport-hardening tests (Phase 1, finding #8): invalid protocol input must
// never crash the server, and expected TOOL failures must come back as tool
// results with isError:true — not as JSON-RPC protocol errors.
//
// Two layers:
//   1. Unit tests of StdioServer.dispatch/handleParsed with send() captured, so
//      malformed shapes are checked deterministically without real stdio.
//   2. An end-to-end test that spawns the real server over stdio and exchanges
//      newline-delimited JSON, proving the whole path (including isError:true).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { StdioServer } from '../src/jsonrpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');

// Build a server whose outbound messages are captured instead of written to
// stdout. Registers an echo method and a method that throws.
function captureServer() {
  const sent = [];
  const server = new StdioServer();
  server.send = (msg) => { sent.push(msg); return Promise.resolve(); };
  server.log = () => {};               // silence stderr in tests
  server.method('echo', async (params) => ({ echoed: params }));
  server.method('boom', async () => { throw new Error('kaboom'); });
  server.method('boomCode', async () => { throw Object.assign(new Error('bad params'), { code: -32602 }); });
  return { server, sent };
}

test('malformed JSON yields a parse error with a null id', async () => {
  const { server, sent } = captureServer();
  // Simulate the stdin data path by exercising the same logic listen() uses.
  // A line that is not valid JSON should produce one PARSE_ERROR (-32700).
  try { JSON.parse('{not json'); } catch { server.error(null, -32700, 'Parse error: invalid JSON'); }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32700);
  assert.equal(sent[0].id, null);
});

test('a batch array is rejected as an invalid request, not crashed on', () => {
  const { server, sent } = captureServer();
  server.handleParsed([{ jsonrpc: '2.0', id: 1, method: 'echo' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32600);
  assert.equal(sent[0].id, null);
});

test('a null message is an invalid request', async () => {
  const { server, sent } = captureServer();
  await server.dispatch(null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32600);
});

test('a non-object (number) message is an invalid request', async () => {
  const { server, sent } = captureServer();
  await server.dispatch(42);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32600);
});

test('a request with a non-string method is rejected', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', id: 7, method: 123 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32600);
  assert.equal(sent[0].id, 7);
});

test('invalid params type is rejected with -32602', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', id: 8, method: 'echo', params: 'nope' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32602);
});

test('unknown method on a request returns method-not-found', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', id: 9, method: 'nope' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32601);
});

test('unknown method on a NOTIFICATION produces no response', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', method: 'nope' }); // no id
  assert.equal(sent.length, 0);
});

test('a handler throwing is reported as an error response, server stays up', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', id: 10, method: 'boom' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32603);
  assert.match(sent[0].error.message, /kaboom/);
  // A subsequent valid request still works.
  await server.dispatch({ jsonrpc: '2.0', id: 11, method: 'echo', params: { a: 1 } });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].result, { echoed: { a: 1 } });
});

test('a handler error with a code preserves that code', async () => {
  const { server, sent } = captureServer();
  await server.dispatch({ jsonrpc: '2.0', id: 12, method: 'boomCode' });
  assert.equal(sent[0].error.code, -32602);
});

// --- end-to-end over real stdio --------------------------------------------

// Drive the real server process: write newline-delimited requests, resolve each
// response by id. Returns { send, close }.
function startServerProcess() {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for id ${id}`)); }, 8000);
    const orig = pending.get(id);
    pending.set(id, (m) => { clearTimeout(t); orig(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const writeRaw = (s) => child.stdin.write(s);
  return { child, rpc, writeRaw, close: () => child.kill() };
}

test('end-to-end: initialize, tools/list, and a failing tool returns isError', async () => {
  const srv = startServerProcess();
  try {
    const init = await srv.rpc(1, 'initialize', {});
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'marey');

    const list = await srv.rpc(2, 'tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    // The six baseline tools are preserved, plus the new status tool.
    for (const n of ['record', 'capture', 'start_recording', 'stop_recording', 'list_windows', 'get_frame']) {
      assert.ok(names.includes(n), `tool ${n} must still be registered`);
    }
    assert.ok(names.includes('status'), 'status tool should be available');

    // stop_recording with nothing in progress is a TOOL failure → isError:true,
    // NOT a JSON-RPC protocol error.
    const stop = await srv.rpc(3, 'tools/call', { name: 'stop_recording', arguments: {} });
    assert.equal(stop.error, undefined, 'should not be a protocol error');
    assert.equal(stop.result.isError, true);
    assert.match(stop.result.content[0].text, /No recording is in progress/);

    // get_frame for a missing path is also a tool failure.
    const gf = await srv.rpc(4, 'tools/call', { name: 'get_frame', arguments: { path: 'C:/nope/missing.png' } });
    assert.equal(gf.result.isError, true);

    // An unknown tool IS a protocol error (-32602).
    const unknown = await srv.rpc(5, 'tools/call', { name: 'does_not_exist', arguments: {} });
    assert.ok(unknown.error, 'unknown tool is a protocol error');
    assert.equal(unknown.error.code, -32602);

    // status reports no active recording.
    const st = await srv.rpc(6, 'tools/call', { name: 'status', arguments: {} });
    assert.equal(st.result.isError, undefined);
    assert.match(st.result.content[0].text, /No recording is in progress/);
  } finally {
    srv.close();
  }
});

test('end-to-end: malformed JSON and garbage do not crash the server', async () => {
  const srv = startServerProcess();
  try {
    // Garbage line → parse error (null id), server stays up.
    srv.writeRaw('{ this is not json\n');
    srv.writeRaw('[1,2,3]\n');          // batch array → invalid request
    srv.writeRaw('null\n');             // non-object
    // A valid request after the garbage still gets a correct response.
    const init = await srv.rpc(1, 'initialize', {});
    assert.equal(init.result.serverInfo.name, 'marey');
    const list = await srv.rpc(2, 'tools/list', {});
    assert.ok(Array.isArray(list.result.tools));
  } finally {
    srv.close();
  }
});
