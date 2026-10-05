// Minimal JSON-RPC 2.0 transport over stdio using newline-delimited JSON.
//
// MCP's stdio transport frames each message as a single line of JSON on
// stdin/stdout. This reads that stream, dispatches by method, and writes
// responses — no SDK, just Node builtins.
//
// IMPORTANT: stdout carries protocol messages only. All logging must go to
// stderr, or it will corrupt the JSON-RPC stream.
//
// Robustness contract (Phase 1, finding #8 — "invalid protocol input cannot
// crash"): malformed JSON, non-object messages, batch arrays, bad/duplicate
// ids, and oversized lines are all turned into well-formed error responses (or
// safely ignored where no response is possible) — never an unhandled throw.
// Outbound writes are serialised and respect stdout backpressure so a slow
// client cannot make us buffer without bound.

// JSON-RPC 2.0 standard error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Guard against an unbounded line (a client that never sends a newline, or a
// hostile stream). Inbound MCP messages are small — requests never carry image
// payloads — so this ceiling is generous and only trips on malformed input.
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class StdioServer {
  constructor() {
    this.handlers = new Map();
    this.buffer = '';
    this.inFlight = 0;
    this.ended = false;
    this.skipToNewline = false;   // resync state after an oversized line
    this._writeChain = Promise.resolve();
  }

  // Register a handler: async (params) => result. Throwing an Error with an
  // optional `.code` becomes a JSON-RPC error response.
  method(name, handler) {
    this.handlers.set(name, handler);
    return this;
  }

  log(...args) {
    process.stderr.write(args.map(String).join(' ') + '\n');
  }

  // Serialise outbound writes and honour backpressure: if the stdout buffer is
  // full, wait for 'drain' before writing the next message. Writes are chained
  // so ordering is preserved and we never grow Node's internal buffer without
  // bound. Returns a promise that resolves once this message is flushed.
  send(message) {
    let line;
    try {
      line = JSON.stringify(message) + '\n';
    } catch (err) {
      // A result we built is unserialisable — should not happen, but never let
      // it crash the transport. Emit a generic internal error instead.
      this.log('[marey] failed to serialize message:', err && err.message);
      line = JSON.stringify({
        jsonrpc: '2.0', id: message && message.id != null ? message.id : null,
        error: { code: INTERNAL_ERROR, message: 'Response serialization failed' },
      }) + '\n';
    }
    this._writeChain = this._writeChain.then(() => new Promise((resolve) => {
      const ok = process.stdout.write(line);
      if (ok) resolve();
      else process.stdout.once('drain', resolve);
    }));
    return this._writeChain;
  }

  reply(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  error(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    // A null id is valid for errors that cannot be tied to a request (e.g. a
    // parse error), per JSON-RPC 2.0.
    this.send({ jsonrpc: '2.0', id: id === undefined ? null : id, error: err });
  }

  // Validate and route a single parsed message. Returns nothing; emits at most
  // one response. Never throws for malformed shapes — those become errors.
  async dispatch(msg) {
    // A JSON-RPC id must be a string, number, or null. Anything else cannot be
    // echoed safely, so we respond (where possible) with a null id.
    const rawId = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id : undefined;
    const id = (typeof rawId === 'string' || typeof rawId === 'number') ? rawId : null;
    const hasValidId = typeof rawId === 'string' || typeof rawId === 'number';
    // A request expects a response; a notification (no id) never does.
    const isNotification = rawId === undefined || rawId === null;

    // Shape validation: must be a plain object with a string method.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.error(null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
      return;
    }
    if (typeof msg.method !== 'string' || !msg.method) {
      if (!isNotification) this.error(id, INVALID_REQUEST, 'Invalid Request: method must be a string');
      return;
    }
    // params, when present, must be an object or array (JSON-RPC "structured").
    if (msg.params !== undefined && msg.params !== null &&
        (typeof msg.params !== 'object')) {
      if (!isNotification) this.error(id, INVALID_PARAMS, 'Invalid params: must be an object or array');
      return;
    }

    const handler = this.handlers.get(msg.method);
    if (!handler) {
      // Notifications never get a response, even for unknown methods.
      if (!isNotification) this.error(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      return;
    }

    this.inFlight++;
    try {
      const result = await handler(msg.params || {});
      // Only reply to requests with a usable id.
      if (!isNotification && hasValidId) this.reply(id, result);
    } catch (err) {
      this.log(`[marey] error in ${msg.method}:`, err && err.stack ? err.stack : err);
      if (!isNotification && hasValidId) {
        this.error(id, err && err.code ? err.code : INTERNAL_ERROR, (err && err.message) || 'Internal error');
      }
    } finally {
      this.inFlight--;
      // If stdin already closed, exit once the last request drains.
      if (this.ended && this.inFlight === 0) process.exit(0);
    }
  }

  // Handle one parsed top-level JSON value. Arrays are JSON-RPC batches, which
  // this server does not support (MCP removed batching); reject them clearly
  // instead of crashing or silently dropping them.
  handleParsed(parsed) {
    if (Array.isArray(parsed)) {
      this.error(null, INVALID_REQUEST,
        'Batch requests are not supported; send one JSON-RPC message per line.');
      return;
    }
    // Fire and forget; dispatch handles its own errors.
    this.dispatch(parsed);
  }

  // Begin reading newline-delimited JSON from stdin.
  listen() {
    // A disconnected client makes stdout writes fail with EPIPE; exit cleanly
    // rather than crashing with an unhandled error.
    process.stdout.on('error', (err) => {
      if (err && err.code === 'EPIPE') process.exit(0);
      this.log('[marey] stdout error:', err && err.message);
    });

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk;

      // Bounded buffering: if a single line exceeds the ceiling, report a parse
      // error once and resync by discarding until the next newline.
      if (this.buffer.length > MAX_LINE_BYTES) {
        const nl = this.buffer.indexOf('\n');
        if (nl === -1) {
          if (!this.skipToNewline) {
            this.skipToNewline = true;
            this.error(null, PARSE_ERROR, 'Message exceeds maximum size; discarding.');
          }
          this.buffer = '';          // drop the oversized partial
          return;
        }
      }

      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        // If we were discarding an oversized line, the newline resyncs us.
        if (this.skipToNewline) {
          this.skipToNewline = false;
          continue;
        }
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // Per JSON-RPC 2.0, a parse error is reported with a null id.
          this.log('[marey] failed to parse line:', line.slice(0, 200));
          this.error(null, PARSE_ERROR, 'Parse error: invalid JSON');
          continue;
        }
        this.handleParsed(msg);
      }
    });
    process.stdin.on('end', () => {
      this.ended = true;
      // Wait for any in-flight request to finish before exiting; dispatch's
      // finally handler exits once inFlight drains.
      if (this.inFlight === 0) process.exit(0);
    });
  }
}
