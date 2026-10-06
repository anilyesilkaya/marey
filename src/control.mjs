// A tiny loopback HTTP control surface for the `observe` workflow. Zero npm
// dependencies — node:http only.
//
// Why this exists: the Claude Code `Stop` hook fires when the AGENT finishes
// responding, not when a human finishes a demonstration, and the MCP server's
// stdin is the protocol channel so it cannot read the user's keyboard. The
// human therefore needs an out-of-band local control to signal "done". This
// serves a small control page the user interacts with; a click resolves the
// pending `observe` call with the captured evidence.
//
// Security model — localhost is NOT private. Any web page the user visits can
// issue requests to 127.0.0.1:<port>, so:
//   - every state-changing request (/finish, /cancel) requires a per-session
//     token delivered ONLY in the control-page URL, sent back in a custom
//     header. A cross-site POST that tries to add that header triggers a CORS
//     preflight this server never approves, so the browser blocks it; a simple
//     cross-site POST without the header is rejected for lacking the token.
//   - we never emit permissive CORS headers, so a cross-site page cannot read
//     our responses to learn the token.
//   - non-loopback connections are refused outright.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Addresses we accept connections from. We bind to 127.0.0.1, but check anyway
// so a misconfiguration cannot silently expose the control surface to a LAN.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Create (but do not yet start) a control server. Options:
//   getStatus() -> object merged into the /status payload (frameCount, elapsed…)
//   token       -> override the generated token (tests)
//   title       -> label shown on the page
//
// Returns a handle: { token, url, port, outcome, settled, settle, listen,
// close }. `outcome` resolves to 'finished' | 'cancelled' | <server reason>.
export function createControlServer(opts = {}) {
  const token = opts.token || randomBytes(16).toString('hex');
  const getStatus = typeof opts.getStatus === 'function' ? opts.getStatus : () => ({});
  // onMark (Phase 4 replay): when provided, the page shows a repeatable MARK
  // button and the /mark endpoint is live. Unlike finish/cancel, a mark does NOT
  // settle the outcome — the recording continues so more marks can be dropped.
  const onMark = typeof opts.onMark === 'function' ? opts.onMark : null;
  const title = opts.title || 'Marey';
  const instructions = opts.instructions ||
    'Reproduce the issue, then click Finish. This returns the frames to the agent.';

  let settled = false;
  let resolveOutcome;
  const outcome = new Promise((r) => { resolveOutcome = r; });
  const settle = (reason) => {
    if (settled) return false;
    settled = true;
    resolveOutcome(reason || 'finished');
    return true;
  };

  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      // A handler fault must never crash the server (the observe call is still
      // blocking on `outcome`).
      try { res.writeHead(500, jsonHeaders()).end('{"error":"internal"}'); } catch {}
    }
  });

  function route(req, res) {
    const remote = req.socket.remoteAddress;
    if (!LOOPBACK.has(remote)) { res.writeHead(403).end('Forbidden'); return; }

    const url = new URL(req.url, 'http://127.0.0.1');
    const qToken = url.searchParams.get('t');
    const hToken = req.headers['x-marey-token'];

    // Control page. Without the right token we serve a neutral "invalid link"
    // page (status 200 so a drive-by cannot probe token validity via status).
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, htmlHeaders());
      res.end(qToken === token
        ? controlPage(token, title, { marking: !!onMark, instructions })
        : invalidPage());
      return;
    }

    // Live status for the page's poller. Token-guarded.
    if (req.method === 'GET' && url.pathname === '/status') {
      if (qToken !== token) { res.writeHead(403, jsonHeaders()).end('{"error":"forbidden"}'); return; }
      let payload = {};
      try { payload = getStatus() || {}; } catch { payload = {}; }
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ...payload, settled }));
      return;
    }

    // Mark (Phase 4 replay): pin the current look-back window into a clip. Unlike
    // finish/cancel this does NOT settle the outcome — recording continues so the
    // user can drop more markers. Token-guarded in a custom header (CSRF-safe),
    // and only live when an onMark handler was supplied.
    if (req.method === 'POST' && url.pathname === '/mark') {
      if (hToken !== token) { res.writeHead(403, jsonHeaders()).end('{"error":"forbidden"}'); return; }
      if (!onMark) { res.writeHead(404, jsonHeaders()).end('{"error":"marking not enabled"}'); return; }
      let info = {};
      try { info = onMark() || {}; } catch (e) { info = { error: e.message }; }
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, ...info }));
      return;
    }

    // State-changing endpoints require the token in a custom header (CSRF-safe).
    if (req.method === 'POST' && (url.pathname === '/finish' || url.pathname === '/cancel')) {
      if (hToken !== token) { res.writeHead(403, jsonHeaders()).end('{"error":"forbidden"}'); return; }
      const reason = url.pathname === '/finish' ? 'finished' : 'cancelled';
      const first = settle(reason);
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, reason, first }));
      return;
    }

    res.writeHead(404, jsonHeaders()).end('{"error":"not found"}');
  }

  const handle = {
    token,
    url: null,
    port: null,
    outcome,
    get settled() { return settled; },
    // Allow the observe handler to settle on a server-side timeout.
    settle,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const addr = server.address();
      handle.port = addr.port;
      handle.url = `http://127.0.0.1:${addr.port}/?t=${token}`;
      return handle.url;
    },
    address() { return server.address(); },
    async close() {
      // Destroy any lingering keep-alive sockets so close() cannot hang on the
      // browser's idle connections (Node 18.2+).
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return handle;
}

// Best-effort open the user's default browser at `url`. Never throws; returns
// false if the platform opener could not be spawned (the caller then prints the
// URL to stderr so the user can open it manually). Detached + unref'd so it
// does not tie the browser's lifetime to this process.
export function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title arg so a URL
      // with spaces/quotes is not mistaken for the title.
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // opener missing (e.g. headless) → caller falls back
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// --- response helpers -------------------------------------------------------

function htmlHeaders() {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}

// --- pages ------------------------------------------------------------------

function invalidPage() {
  return `<!doctype html><meta charset="utf-8"><title>Marey</title>
<body style="font:15px system-ui;margin:3rem;color:#333">
This Marey control link is invalid or has expired. You can close this tab.
</body>`;
}

// The control page: a live "Recording…" indicator, a Finish button (F) and a
// Cancel button (Esc). It polls /status and, once the session is settled (by a
// click here, by `marey finish`, or by the server-side timeout), shows a final
// message. The token is inlined so the page's own fetches can authenticate; it
// is sent in the X-Marey-Token header on POSTs.
//
// When `marking` is true (Phase 4 replay) the page also shows a repeatable MARK
// button (M / Space) that pins the current look-back window into a clip WITHOUT
// ending the recording, and a running marker count.
function controlPage(token, title, opts = {}) {
  const marking = !!opts.marking;
  const instructions = opts.instructions || 'Reproduce the issue, then click Finish. This returns the frames to the agent.';
  // token is hex from randomBytes, so it is safe to inline inside a JS string.
  const markButton = marking
    ? `<button class="mark" id="mark">Mark &nbsp;·&nbsp; M</button>\n      `
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — recording</title>
<style>
  :root { color-scheme: light dark; }
  body { font:16px/1.5 system-ui,sans-serif; margin:0; display:grid; place-items:center;
         min-height:100vh; background:#0b0b0c; color:#e8e8ea; }
  .card { width:min(92vw,420px); padding:28px; border-radius:14px; background:#161618;
          box-shadow:0 10px 40px rgba(0,0,0,.5); text-align:center; }
  .dot { display:inline-block; width:11px; height:11px; border-radius:50%; background:#e5484d;
         margin-right:8px; animation:pulse 1.2s infinite; vertical-align:middle; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes flash { 0%{background:#3b5bdb} 100%{background:#2a2a2e} }
  h1 { font-size:17px; margin:0 0 4px; font-weight:600; letter-spacing:.2px; }
  .meta { color:#9a9aa2; font-size:13px; margin-bottom:22px; min-height:1.4em; }
  .clock { font-size:40px; font-variant-numeric:tabular-nums; margin:6px 0 2px; }
  .marks { color:#9bb0ff; font-size:13px; min-height:1.4em; margin-bottom:6px; }
  button { font:inherit; cursor:pointer; border:0; border-radius:10px; padding:12px 18px;
           margin:6px 4px; min-width:130px; }
  .finish { background:#2e7d32; color:#fff; font-weight:600; }
  .cancel { background:#2a2a2e; color:#d6d6da; }
  .mark { background:#3b5bdb; color:#fff; font-weight:600; }
  .mark.flash { animation:flash .4s ease-out; }
  .hint { color:#75757c; font-size:12px; margin-top:14px; }
  .done { color:#8fd19e; font-weight:600; }
</style></head>
<body>
  <div class="card" id="card">
    <div><span class="dot" id="dot"></span><span id="state">Recording</span></div>
    <div class="clock" id="clock">00:00</div>
    <div class="meta" id="meta">starting…</div>
    ${marking ? '<div class="marks" id="marks">No markers yet</div>' : ''}
    <div>
      ${markButton}<button class="finish" id="finish">Finish &nbsp;·&nbsp; F</button>
      <button class="cancel" id="cancel">Cancel &nbsp;·&nbsp; Esc</button>
    </div>
    <div class="hint">${escapeHtml(instructions)}</div>
  </div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const MARKING = ${marking ? 'true' : 'false'};
  const $ = (id) => document.getElementById(id);
  let done = false;
  let markCount = 0;

  function fmt(ms) {
    if (!(ms >= 0)) ms = 0;
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
  }

  function renderMarks(n) {
    if (!MARKING) return;
    markCount = n;
    $('marks').textContent = n > 0
      ? n + ' marker' + (n===1?'':'s') + ' saved'
      : 'No markers yet — Mark to save the last few seconds';
  }

  async function poll() {
    if (done) return;
    try {
      const r = await fetch('/status?t=' + TOKEN, { cache:'no-store' });
      const s = await r.json();
      if (s.settled) { finishedUI(s.reasonLabel || 'ended'); return; }
      $('clock').textContent = fmt(s.elapsedMs);
      const bits = [];
      if (s.frameCount != null) bits.push(s.frameCount + ' frame' + (s.frameCount===1?'':'s'));
      if (s.region) bits.push(s.region + (s.title ? ' · "'+s.title+'"' : ''));
      if (s.fps) bits.push(s.fps + ' fps');
      $('meta').textContent = bits.join(' · ') || 'recording…';
      if (MARKING && typeof s.markCount === 'number' && s.markCount !== markCount) renderMarks(s.markCount);
    } catch (e) { /* server likely closed after settle */ }
    setTimeout(poll, 500);
  }

  function finishedUI(label) {
    done = true;
    $('dot').style.animation = 'none';
    $('dot').style.background = '#6b6b70';
    $('state').textContent = 'Done';
    $('meta').innerHTML = '<span class="done">' + label + '</span> — you can close this tab.';
    $('finish').disabled = true; $('cancel').disabled = true;
    if (MARKING) $('mark').disabled = true;
  }

  async function act(path, label) {
    if (done) return;
    done = true;
    try {
      await fetch(path, { method:'POST', headers:{ 'X-Marey-Token': TOKEN } });
    } catch (e) {}
    finishedUI(label);
  }

  // Mark does NOT end the recording — fire-and-refresh the marker count.
  async function mark() {
    if (done) return;
    const btn = $('mark');
    btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
    try {
      const r = await fetch('/mark', { method:'POST', headers:{ 'X-Marey-Token': TOKEN } });
      const j = await r.json().catch(() => ({}));
      if (typeof j.markIndex === 'number' && j.markIndex > markCount) renderMarks(j.markIndex);
    } catch (e) {}
  }

  $('finish').onclick = () => act('/finish', 'Finished');
  $('cancel').onclick = () => act('/cancel', 'Cancelled');
  if (MARKING) $('mark').onclick = mark;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F' || e.key === 'Enter') act('/finish', 'Finished');
    else if (e.key === 'Escape') act('/cancel', 'Cancelled');
    else if (MARKING && (e.key === 'm' || e.key === 'M' || e.key === ' ')) { e.preventDefault(); mark(); }
  });
  poll();
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// --- cross-process control registry ----------------------------------------
//
// `marey finish` / `marey stop` run in a SEPARATE process from the MCP server,
// so they cannot call settle() directly. The observe handler writes a tiny
// registry file describing the live control endpoint (port + token); the CLI
// reads it and POSTs /finish or /cancel just like the browser page does. The
// file lives in the OS temp dir and is removed when the observation ends.

export function registryPath() {
  return path.join(os.tmpdir(), 'marey-control.json');
}

// Record the live control endpoint. `extra` may carry sessionId/startedAt for
// the CLI to display. Best-effort: a failure here must not break observe.
export function writeControlRegistry(handle, extra = {}) {
  try {
    writeFileSync(registryPath(), JSON.stringify({
      pid: process.pid,
      port: handle.port,
      token: handle.token,
      url: handle.url,
      ...extra,
    }), { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function readControlRegistry() {
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf8'));
  } catch { return null; }
}

export function clearControlRegistry() {
  try { unlinkSync(registryPath()); } catch {}
}

// Signal the live observation (from another process) to finish, cancel, or mark.
// POSTs to the registered loopback endpoint with the token header. Returns
// { ok, reason } on success or { ok:false, error } if nothing is reachable.
// A 'mark' pins the current replay window into a clip and leaves the recording
// running; finish/cancel end it. The response body (e.g. markIndex, frameCount)
// is merged in so callers can report what happened.
export async function signalControl(action = 'finish') {
  const reg = readControlRegistry();
  if (!reg || !reg.port || !reg.token) {
    return { ok: false, error: 'No active observation found.' };
  }
  const route = action === 'cancel' ? '/cancel' : action === 'mark' ? '/mark' : '/finish';
  try {
    const res = await fetch(`http://127.0.0.1:${reg.port}${route}`, {
      method: 'POST',
      headers: { 'X-Marey-Token': reg.token },
    });
    if (res.status === 404 && action === 'mark') {
      return { ok: false, error: 'This observation is not a replay session; nothing to mark.' };
    }
    if (!res.ok) return { ok: false, error: `Control server returned ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { ok: true, reason: body.reason || action, sessionId: reg.sessionId || null, ...body };
  } catch (err) {
    // Endpoint unreachable → stale registry (server already gone). Clean it up.
    clearControlRegistry();
    return { ok: false, error: `No reachable observation (stale control file removed): ${err.message}` };
  }
}
