# Marey implementation status

Working branch: `session-reliability`. Baseline reviewed: `a753847`.
Baseline test suite: 13/13 passing on Node 24 / Windows 11 (this machine).

This document tracks what is **done + verified**, **done but unverified**, and
**deferred**, so the work can be resumed. Keep it honest: a fake-backend test
does not establish OS capture support.

## Environment on this machine

- Windows 11, Node v24.21.0, PowerShell available (native Windows backend).
- No Linux/macOS host available here — those backends are reasoned about and
  kept honest, but only the **Windows** native path can be smoke-tested here.

## External-integration facts (verified against current docs, 2026-10-05)

- **MCP Tasks** (`2025-11-25`) are **experimental** and require the *client* to
  negotiate the `tasks` capability. Not safe to depend on. → We use the stable
  path: synchronous pending request + a session-ID retrieval tool, and keep the
  design forward-compatible with `execution.taskSupport: "optional"`.
- **MCP structured results** (`structuredContent` + `outputSchema`) are stable
  in `2025-11-25`; a text `content` fallback is still required for older clients.
- **`notifications/progress`** and **`notifications/cancelled`** are stable.
- **Claude Code `Stop` hook fires when the agent finishes responding**, never on
  a human finishing a demonstration. → Hooks are the wrong trigger for the
  human-observation workflow; use Marey's own local control channel.
- **Claude Code Channels** are research-preview, auth/org-gated, and unavailable
  on Bedrock/Vertex/Foundry. → Treat as an optional, capability-gated enhancement.

## Phase 1 — recording reliability

Status: **complete** — session controller + MCP transport hardening landed and
verified (44/44 tests passing; Windows native + end-to-end MCP smoke-tested).

Implemented in `src/session.mjs` (`SessionController`), with `src/clock.mjs`
(monotonic vs wall clock seam) and `src/capture.mjs` returning original PNG
bytes via a streaming backend. `src/recorder.mjs` is now a thin adapter over the
controller, so the existing MCP tools and CLI keep their signatures.

| Finding (baseline) | Required outcome | State |
| --- | --- | --- |
| Start succeeds before capture ready | Ready = backend init + first valid frame | ✅ Done + verified (unit + Windows smoke) |
| Duration = frame-count target | Monotonic deadline; report actual timing | ✅ Done + verified (unit + Windows smoke) |
| Concurrent starts bypass guard | Ownership acquired atomically pre-await | ✅ Done + verified (unit) |
| Session dirs collide (per-second) | Unique id + dir | ✅ Done + verified (unit + Windows smoke) |
| Memory grows with decoded frames | Bound by bytes; keep encoded frames | ✅ Done + verified (unit) |
| Window capture broadens silently | Honour target or explicit unsupported | ⚠️ Done (Windows backend); window path not smoke-tested yet |
| Failures suppressed | Preserve/report failures; terminate persistent failure | ✅ Done + verified (unit) |
| Transport validation incomplete | Invalid input cannot crash; tool errors actionable | ✅ Done + verified (unit + e2e) |

Verification so far:
- 18 deterministic session tests (`test/session.test.mjs`) on a fake
  clock/backend/fs — readiness, startup failure/timeout, concurrent-start guard,
  monotonic deadline (incl. wall-clock-jump immunity), idempotent/concurrent
  stop, cancel-with-partial-evidence, frame/disk/oversized caps, write-failure
  visibility, mid-recording backend exit, manifest persistence, status,
  shutdown, and `record()` convenience. All pass.
- 13 core tests (`test/core.test.mjs`) still pass after the `recorder.mjs`
  rewrite (PNG codec, image ops, contact sheet, `getFrame`).
- **Windows native smoke test**: `node src/cli.mjs record --seconds 2 --fps 3`
  captured 6 real 1536×960 frames over the full 2s window at ~333ms spacing,
  `completionReason: duration-reached`, versioned manifest written. A timed
  recording's duration is measured from readiness, so PowerShell cold-start does
  not eat into the requested window.
- 12 transport tests (`test/transport.test.mjs`): malformed JSON → parse error
  (null id); batch arrays, `null`, non-objects, non-string methods, bad params
  types all rejected without crashing; unknown method → `-32601`; handler throws
  are reported and the server stays up. End-to-end over real stdio: initialize +
  tools/list expose the 6 baseline tools **plus** a new `status` tool; a tool
  failure (`stop_recording` with nothing running, `get_frame` on a missing path)
  returns `isError:true` rather than a protocol error; an unknown tool is a
  `-32602` protocol error; malformed input does not crash the live process.
- **End-to-end MCP `record`**: a real `tools/call` over stdio produced a 202 KB
  contact-sheet PNG image result (`isError:false`) from an actual screen grab,
  confirming the server → SessionController → capture chain.

Transport hardening (`src/jsonrpc.mjs`): bounded input buffering (16 MiB line
cap with resync), serialised writes honouring stdout backpressure, EPIPE →
clean exit, parse errors as `-32700` with null id, batch/shape/param validation.
`src/server.mjs` wraps tool execution so expected failures become `isError:true`
results while malformed protocol input stays a JSON-RPC error.

Not yet verified: Linux/macOS native capture (no host here); window-region
capture on any OS (the Windows window path is implemented but not smoke-tested).

## Phase 2 — local controls + observation workflow

Status: **complete** — `observe` workflow, local browser control page, cross-
process `marey finish`/`stop`, and `marey doctor` landed and verified (58 tests
passing across all suites; real Windows observe→finish smoke-tested).

The headline workflow: the agent calls `observe`, the user reproduces the issue
and clicks **Finish** on a local control page (or runs `marey finish`), and the
same `observe` call returns the contact sheet — no duration guess, no second
tool call. Finish decision is out-of-band because the Claude Code `Stop` hook
fires when the agent finishes, not the human, and the MCP server's stdin is the
protocol channel.

Design decision (user-confirmed): the finish control is a **loopback browser
page** auto-opened by `observe`, with a Finish button + `F` key and a Cancel +
`Esc`. A bounded `maxSeconds` safety deadline always returns.

| Component | What it does | State |
| --- | --- | --- |
| `src/control.mjs` control server | Loopback (127.0.0.1) `node:http` page; token-guarded `/status` `/finish` `/cancel`; CSRF-safe (custom-header token); non-loopback refused; `settle()` for timeout | ✅ Done + verified (9 unit tests) |
| Cross-process registry | Temp-file registry (`marey-control.json`, mode 0600) so `marey finish` in another process can reach the live endpoint via `signalControl()` | ✅ Done + verified (unit + real) |
| `observe` (recorder + MCP tool) | Starts a session, opens the control page, blocks as a synchronous pending request until finish/cancel/timeout, returns a record-shaped result with an `observation` field | ✅ Done + verified (5 integration tests + real Windows) |
| `openBrowser` | Cross-platform (`start`/`open`/`xdg-open`), detached+unref'd, never throws; stderr URL fallback when headless | ✅ Done (Windows verified; `--no-open` path verified) |
| `marey doctor` | Reports platform/node/backend/regions/window-grab, performs a **real single-frame capture probe** (pass/fail), reports any active observation; non-zero exit on probe failure | ✅ Done + verified (real Windows) |
| `marey finish` / `marey stop` | Signal the active observation to finish (or `stop --cancel`) from any terminal | ✅ Done + verified (real Windows) |

Verification:
- 9 control-server tests (`test/control.test.mjs`): token guard, CSRF rejection
  of a tokenless POST, live `/status`, finish/cancel/idempotent-finish/timeout
  outcomes, 404 safety, loopback URL shape.
- 5 observe integration tests (`test/observe.test.mjs`) on real timers with a
  fake backend + in-memory fs: Finish returns evidence; Cancel → cancelled with
  partial evidence; `signalControl()` finishes from "another process"; the
  max-duration deadline returns; no-active-observation reports cleanly.
- **Real Windows end-to-end**: `marey observe --no-open` in one process +
  `marey finish` in another captured 5 real frames and returned a contact sheet;
  `marey doctor` grabbed a real 1536×960 frame and reported capture working.
- `tools/list` now exposes 8 tools: the 6 baseline + `status` + `observe`.
  Baseline tools and the `npx -y @anilyesilkaya/marey` install path unchanged.

The MCP `observe` tool auto-opens a browser by design, so it is covered by
integration tests (finish/cancel/timeout) rather than a live MCP smoke test that
would pop a browser window on the host.

## Phase 3 — compact visual evidence

Status: not started.

## Phase 4 — replay buffering + markers

Status: not started.

## Phase 5 — temporal fidelity + agent-driven capture

Status: not started.
