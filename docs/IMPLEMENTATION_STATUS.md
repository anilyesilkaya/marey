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

Status: not started.

## Phase 3 — compact visual evidence

Status: not started.

## Phase 4 — replay buffering + markers

Status: not started.

## Phase 5 — temporal fidelity + agent-driven capture

Status: not started.
