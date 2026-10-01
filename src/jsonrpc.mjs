// Minimal JSON-RPC 2.0 transport over stdio using newline-delimited JSON.
//
// MCP's stdio transport frames each message as a single line of JSON on
// stdin/stdout. This reads that stream, dispatches by method, and writes
// responses — no SDK, just Node builtins.
//
// IMPORTANT: stdout carries protocol messages only. All logging must go to
// stderr, or it will corrupt the JSON-RPC stream.

export class StdioServer {
  constructor() {
    this.handlers = new Map();
    this.buffer = '';
    this.inFlight = 0;
    this.ended = false;
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

  send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  reply(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  error(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    this.send({ jsonrpc: '2.0', id, error: err });
  }

  async dispatch(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    const handler = this.handlers.get(method);
    if (!handler) {
      // Notifications never get a response, even for unknown methods.
      if (!isNotification) {
        this.error(id, -32601, `Method not found: ${method}`);
      }
      return;
    }

    this.inFlight++;
    try {
      const result = await handler(params || {});
      if (!isNotification) this.reply(id, result);
    } catch (err) {
      this.log(`[marey] error in ${method}:`, err && err.stack ? err.stack : err);
      if (!isNotification) {
        this.error(id, err.code || -32603, err.message || 'Internal error');
      }
    } finally {
      this.inFlight--;
      // If stdin already closed, exit once the last request drains.
      if (this.ended && this.inFlight === 0) process.exit(0);
    }
  }

  // Begin reading newline-delimited JSON from stdin.
  listen() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.log('[marey] failed to parse line:', line);
          continue;
        }
        // Fire and forget; dispatch handles its own errors.
        this.dispatch(msg);
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
