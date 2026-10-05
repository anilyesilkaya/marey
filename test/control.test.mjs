// Control-server tests: drive the real loopback HTTP surface with fetch and
// verify the token guard, CSRF defense, live status, and outcome resolution.
// No browser involved — the page is served as text and the endpoints are hit
// directly, which is exactly how `marey finish` and a drive-by site would.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createControlServer } from '../src/control.mjs';

// Spin up a server with a fixed token and a stub status, returning helpers.
async function make(statusObj = {}) {
  let status = { frameCount: 0, elapsedMs: 0, region: 'primary', fps: 2, ...statusObj };
  const ctl = createControlServer({ token: 'testtoken', getStatus: () => status, title: 'Marey' });
  await ctl.listen();
  const base = `http://127.0.0.1:${ctl.port}`;
  return {
    ctl, base,
    setStatus: (s) => { status = { ...status, ...s }; },
    get: (p, headers) => fetch(base + p, { headers }),
    post: (p, headers) => fetch(base + p, { method: 'POST', headers }),
  };
}

test('control page is served with the right token and withheld without it', async () => {
  const h = await make();
  try {
    const ok = await h.get('/?t=testtoken');
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.match(body, /Recording/);
    assert.match(body, /Finish/);

    // Wrong token → neutral invalid page (200, no control UI, no token leak).
    const bad = await h.get('/?t=wrong');
    assert.equal(bad.status, 200);
    const badBody = await bad.text();
    assert.match(badBody, /invalid or has expired/);
    assert.doesNotMatch(badBody, /testtoken/);
  } finally { await h.ctl.close(); }
});

test('/status requires the token and reports live fields', async () => {
  const h = await make({ frameCount: 3, elapsedMs: 1500 });
  try {
    const forbidden = await h.get('/status?t=nope');
    assert.equal(forbidden.status, 403);

    const r = await h.get('/status?t=testtoken');
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.frameCount, 3);
    assert.equal(s.elapsedMs, 1500);
    assert.equal(s.settled, false);
  } finally { await h.ctl.close(); }
});

test('POST /finish without the token header is rejected (CSRF defense)', async () => {
  const h = await make();
  try {
    // A simple cross-site POST would not carry our custom header.
    const r = await h.post('/finish');
    assert.equal(r.status, 403);
    // The outcome must NOT have resolved.
    let resolved = false;
    h.ctl.outcome.then(() => { resolved = true; });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(resolved, false, 'a tokenless POST must not settle the session');
  } finally { await h.ctl.close(); }
});

test('POST /finish with the token header resolves the outcome as finished', async () => {
  const h = await make();
  try {
    const r = await h.post('/finish', { 'X-Marey-Token': 'testtoken' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.reason, 'finished');
    assert.equal(body.first, true);
    const outcome = await h.ctl.outcome;
    assert.equal(outcome, 'finished');
    // After settle, /status reports settled:true so the page can finalise.
    const s = await (await h.get('/status?t=testtoken')).json();
    assert.equal(s.settled, true);
  } finally { await h.ctl.close(); }
});

test('POST /cancel resolves the outcome as cancelled', async () => {
  const h = await make();
  try {
    await h.post('/cancel', { 'X-Marey-Token': 'testtoken' });
    assert.equal(await h.ctl.outcome, 'cancelled');
  } finally { await h.ctl.close(); }
});

test('a second finish is idempotent (first:false), outcome unchanged', async () => {
  const h = await make();
  try {
    const a = await (await h.post('/finish', { 'X-Marey-Token': 'testtoken' })).json();
    const b = await (await h.post('/finish', { 'X-Marey-Token': 'testtoken' })).json();
    assert.equal(a.first, true);
    assert.equal(b.first, false);
    assert.equal(await h.ctl.outcome, 'finished');
  } finally { await h.ctl.close(); }
});

test('server-side settle() (timeout path) resolves the outcome without a request', async () => {
  const h = await make();
  try {
    assert.equal(h.ctl.settled, false);
    const first = h.ctl.settle('timed-out');
    assert.equal(first, true);
    assert.equal(await h.ctl.outcome, 'timed-out');
    // A later POST is a no-op (already settled).
    const late = await (await h.post('/finish', { 'X-Marey-Token': 'testtoken' })).json();
    assert.equal(late.first, false);
  } finally { await h.ctl.close(); }
});

test('unknown routes 404 without crashing the server', async () => {
  const h = await make();
  try {
    const r = await h.get('/nope?t=testtoken');
    assert.equal(r.status, 404);
    // Server still answers a valid request afterward.
    const ok = await h.get('/status?t=testtoken');
    assert.equal(ok.status, 200);
  } finally { await h.ctl.close(); }
});

test('listen() exposes a loopback url carrying the token', async () => {
  const h = await make();
  try {
    assert.match(h.ctl.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=testtoken$/);
    assert.ok(h.ctl.port > 0);
  } finally { await h.ctl.close(); }
});
