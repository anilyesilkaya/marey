// Continuous FFmpeg PNG transport. Match each image with its acquisition PTS
// from showinfo, even when stdout and stderr arrive in a different order.
import { spawn } from 'node:child_process';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 64 * 1024 * 1024;

export class PngStreamParser {
  constructor(onPng, maxBytes = MAX_BYTES) {
    this.onPng = onPng;
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.offset = 8;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      if (!this.buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Invalid PNG stream signature');
      let complete = false;
      while (this.offset + 8 <= this.buffer.length) {
        const length = this.buffer.readUInt32BE(this.offset);
        const end = this.offset + 12 + length;
        if (end > this.maxBytes) throw new Error('PNG stream frame exceeds byte limit');
        if (end > this.buffer.length) break;
        const type = this.buffer.toString('ascii', this.offset + 4, this.offset + 8);
        this.offset = end;
        if (type === 'IEND') {
          const png = this.buffer.subarray(0, end);
          this.buffer = this.buffer.subarray(end);
          this.offset = 8;
          this.onPng(png);
          complete = true;
          break;
        }
      }
      if (!complete) break;
    }
    if (this.buffer.length > this.maxBytes) throw new Error('PNG stream buffer exceeds byte limit');
  }
  finish() {
    if (this.buffer.length) throw new Error('Truncated PNG stream');
  }
}

export function startFfmpegStream(inputArgs, onFrame, metadata = {}, spawnProcess = spawn) {
  const child = spawnProcess('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'info', '-probesize', '32', '-analyzeduration', '0', ...inputArgs,
    '-an', '-vf', [metadata.cropFilter, 'setpts=PTS-STARTPTS', 'showinfo'].filter(Boolean).join(','), '-fps_mode', 'passthrough',
    '-c:v', 'png', '-pix_fmt', 'rgb24', '-threads', '1', '-flush_packets', '1', '-f', 'image2pipe', 'pipe:1',
  ], { windowsHide: true });
  const images = [];
  const timestamps = [];
  let pendingBytes = 0;
  let lineBuffer = '';
  let diagnostics = '';
  let failure = null;
  let count = 0;
  let exited = false;
  let stopping = false;
  let killTimer;
  const fail = (err) => { failure ||= err.message; child.kill(); };
  const drain = () => {
    while (images.length && timestamps.length && !stopping && !failure) {
      const png = images.shift();
      pendingBytes -= png.length;
      const timeMs = timestamps.shift();
      onFrame({ png, timeMs, target: metadata.target, timingSource: 'capture-pts' }, ++count);
    }
    if (pendingBytes > MAX_BYTES || images.length > 120 || timestamps.length > 120) {
      fail(new Error('Capture timestamps and images failed to synchronize'));
    }
  };
  const parser = new PngStreamParser((png) => {
    images.push(png); pendingBytes += png.length; drain();
  });
  child.stdout.on('data', (chunk) => {
    if (stopping || failure) return;
    try { parser.push(chunk); } catch (err) { fail(err); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    lineBuffer += chunk;
    let nl;
    while ((nl = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, nl);
      lineBuffer = lineBuffer.slice(nl + 1);
      const match = line.match(/\[.*showinfo.*\].*\bn:\s*\d+.*\bpts_time:\s*([-+\deE.]+)/);
      if (match) {
        const value = Number(match[1]) * 1000;
        if (!Number.isFinite(value) || value < 0) fail(new Error('Invalid capture timestamp'));
        else { timestamps.push(value); drain(); }
      } else if (!line.includes('showinfo')) {
        diagnostics = (diagnostics + line + '\n').slice(-8192);
      }
    }
    if (lineBuffer.length > 16384) fail(new Error('Capture diagnostic line exceeds limit'));
  });
  child.on('error', fail);
  const closed = new Promise((resolve) => child.on('close', (code) => {
    exited = true;
    clearTimeout(killTimer);
    if (!stopping && !failure) {
      try { parser.finish(); } catch (err) { failure = err.message; }
      if (images.length || timestamps.length) failure ||= 'Incomplete capture timestamp/image pair';
      if (code !== 0) failure ||= `FFmpeg exited ${code}: ${diagnostics.trim()}`;
    }
    resolve();
  }));
  return {
    ...metadata,
    timingSource: 'capture-pts',
    stop() {
      stopping = true;
      if (!exited) {
        child.kill();
        killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
        killTimer.unref?.();
      }
      return closed;
    },
    whenClosed: () => closed,
    get exited() { return exited; },
    get framesSeen() { return count; },
    get error() { return failure; },
  };
}

// SessionController expects a synchronous handle; target discovery is async.
// Cancellation during discovery must still stop a subsequently created child.
export function deferredStream(prepare) {
  let stream;
  let stopped = false;
  let exited = false;
  let failure;
  const closed = (async () => {
    try {
      stream = await prepare(() => stopped);
      if (stopped) await stream.stop();
      await stream.whenClosed();
    } catch (err) { failure = err.message; }
    finally { exited = true; }
  })();
  return {
    async stop() { stopped = true; if (stream) await stream.stop(); return closed; },
    whenClosed: () => closed,
    get exited() { return exited; },
    get framesSeen() { return stream?.framesSeen || 0; },
    get error() { return failure || stream?.error || null; },
    get target() { return stream?.target || null; },
    get backend() { return stream?.backend || null; },
    get timingSource() { return stream?.timingSource || null; },
    get warnings() { return stream?.warnings || []; },
  };
}
