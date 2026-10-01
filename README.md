# Marey

**Give AI agents eyes for motion.**

Marey is an MCP server that captures short screen recordings as a sequence of still frames and turns them into a single, agent-readable contact sheet.

It is named after [Étienne-Jules Marey](https://en.wikipedia.org/wiki/%C3%89tienne-Jules_Marey), a pioneer of **chronophotography** — the study of motion through sequences of images. Marey applies the same idea to AI agents: instead of handing a model a video it cannot reliably inspect frame by frame, it converts motion into a visual sequence the model can reason about.

---

## Why Marey?

AI coding agents are increasingly good at understanding screenshots, but motion is still awkward.

A bug such as:

- an anchor jumping while it is dragged,
- a menu flashing and immediately closing,
- a canvas updating in the wrong order,
- an animation stuttering between states,

cannot be understood from a single screenshot.

Marey bridges that gap.

```text
You interact            Marey captures               Agent sees

drag / click / type  →  frame 001 · 0.00 s        →  ┌────┬────┬────┐
                         frame 002 · 0.25 s           │ 01 │ 02 │ 03 │
                         frame 003 · 0.50 s           ├────┼────┼────┤
                         frame 004 · 0.75 s           │ 04 │ 05 │ 06 │
                         ...                           └────┴────┴────┘
                                                      contact sheet
```

Because Marey speaks the [Model Context Protocol](https://modelcontextprotocol.io), an agent can request the recording itself and receive the resulting image directly in context.

No GIF inspection. No manually extracting frames. No dragging a dozen screenshots into chat.

---

## How it works

1. An MCP client asks Marey to record the screen.
2. Marey captures frames at a chosen frame rate.
3. Each frame is numbered and timestamped.
4. Marey composes the frames into a contact sheet.
5. The contact sheet is returned to the agent as MCP image content.
6. Raw frames remain available on disk for closer inspection or re-stitching.

The idea is deliberately simple:

**motion becomes one image containing time.**

---

## Tools

Marey exposes three MCP tools:

| Tool | What it does |
| --- | --- |
| `record` | Records the screen for a fixed duration and returns a timestamped contact sheet |
| `capture` | Captures a single screenshot |
| `list_windows` | Lists visible windows that can be targeted for capture |

### `record`

| Parameter | Default | Description |
| --- | ---: | --- |
| `seconds` | `5` | Recording duration |
| `fps` | `2` | Frames captured per second |
| `region` | `primary` | `primary`, `virtual`, or `window` |
| `title` | — | Window-title substring when `region` is `window` |
| `delay` | `0` | Delay before capture begins |
| `cols` | `4` | Number of thumbnails per contact-sheet row |
| `thumbWidth` | `480` | Thumbnail width in pixels |

The result contains:

- the contact sheet as MCP image content,
- a short text summary with capture metadata,
- raw frames saved locally for later inspection.

### `capture`

Captures one frame immediately using the same region-selection semantics as `record`.

### `list_windows`

Returns visible window titles, and geometry where available, so an agent can choose a target for window capture.

---

## Example

Once Marey is connected to an MCP client, interaction can be as simple as:

> Use Marey to record 6 seconds of the Euclid window at 4 fps while I drag an anchor, then tell me what changes between frames.

The agent receives the complete sequence as a single image and can reason about the transition rather than only the initial state.

---

## Command-line use

Marey also runs standalone, which is handy for verifying your capture backend
before wiring up an MCP client:

```bash
node src/cli.mjs backend                 # report the detected capture backend
node src/cli.mjs windows                 # list targetable windows
node src/cli.mjs capture --region primary
node src/cli.mjs record --seconds 4 --fps 4 --cols 4 --thumbWidth 320
node src/cli.mjs record --region window --title "Euclid" --seconds 6 --fps 4
```

### A note on frame rate

`fps` is the **target** rate. The achievable rate is bounded by how fast the
host can grab and encode a frame — on a 2560×1440 primary monitor, a full-screen
grab plus PNG save costs a few hundred milliseconds, so the practical ceiling is
roughly 2–3 fps at full resolution. Capturing a smaller `region` (or a single
`window`) is faster. On Windows, an entire recording runs inside **one**
PowerShell process rather than one per frame, so capture is not throttled by
process-startup overhead. Frame labels show the *actual* elapsed time of each
frame, so the timeline is always truthful even when the target rate is not met.

---

## Installation

### Requirements

- **Node.js 18+**
- A supported screen-capture backend

**Zero runtime dependencies.** Marey ships with an empty `dependencies` block —
`npm install` pulls nothing. Everything is built on Node builtins:

- **PNG decode/encode** — pure JavaScript over the builtin `zlib`
  ([`src/png.mjs`](src/png.mjs)); no `sharp`, `jimp`, or `pngjs`.
- **Thumbnails, compositing, and frame labels** — a pure-JS image buffer and a
  hand-coded 5×7 bitmap font ([`src/image.mjs`](src/image.mjs),
  [`src/font.mjs`](src/font.mjs)); no image or font library.
- **MCP protocol** — JSON-RPC 2.0 over stdio, hand-rolled
  ([`src/jsonrpc.mjs`](src/jsonrpc.mjs)); no MCP SDK.
- **Screen capture** — `child_process` driving the native or command-line
  backend available on the host ([`src/capture.mjs`](src/capture.mjs)).

### Clone

```bash
git clone https://github.com/anilyesilkaya/marey.git
cd marey
npm install
```

---

## Connect to an MCP client

### Claude Code

```bash
claude mcp add marey -- node /absolute/path/to/marey/src/server.mjs
```

### Claude Desktop or another MCP client

Add Marey to the client's MCP configuration:

```json
{
  "mcpServers": {
    "marey": {
      "command": "node",
      "args": ["/absolute/path/to/marey/src/server.mjs"]
    }
  }
}
```

---

## Capture backends

Marey auto-detects an available screen-capture backend.

| Platform | Full / monitor capture | Window capture |
| --- | --- | --- |
| Windows 10/11 | Built-in PowerShell + `System.Drawing` | Built-in |
| Linux · X11 | `scrot`, ImageMagick `import`, or `ffmpeg` | `ffmpeg` + `xdotool` |
| Linux · Wayland | `grim` | Compositor-dependent |
| macOS | Built-in `screencapture` | Not yet supported |

On Linux, window listing uses `wmctrl` or `xdotool` where available. If
`ffmpeg` is on `PATH`, Marey can use it for X11 capture where supported.

---

## Output

Recordings are stored under `captures/`:

```text
captures/
└── 20260101-120000/
    ├── frame_001_00000ms.png
    ├── frame_002_00500ms.png
    ├── frame_003_01000ms.png
    └── contactsheet.png

captures/latest-contactsheet.png
```

The raw frames make it possible to generate a different contact-sheet layout without recording the interaction again.

---

## Design principles

**Agent-first**

Marey is an MCP server rather than just a screen-recording CLI. The agent can request the visual evidence it needs.

**Still images over video**

The output is intentionally model-friendly: a numbered, timestamped sequence of frames in one image.

**Small surface area**

A handful of tools cover the core workflow: record, capture, inspect.

**Cross-platform core**

Frame composition stays platform-independent while screen capture is delegated to the best backend available on the host.

**Zero dependencies**

The entire pipeline — PNG codec, image compositing, frame labelling, and the
MCP protocol itself — is built on Node builtins. Nothing is pulled from npm, so
there is no supply chain to audit, no install step beyond cloning, and no
version drift in third-party packages.

**Short, deterministic recordings**

Fixed duration and frame rate make captures reproducible and easy for agents to request. An optional delay gives the user time to focus the target window before recording starts.

---

## Why the name?

Étienne-Jules Marey used chronophotography to make motion visible by decomposing it into successive images.

**Marey does the same thing for AI agents.**

---

## License

MIT — see [LICENSE](LICENSE).
