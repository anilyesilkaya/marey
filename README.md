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

## Installation

### Requirements

- **Node.js 18+**
- A supported screen-capture backend

The image-processing core is pure JavaScript. The MCP SDK is the only npm runtime dependency; screen capture uses the native or command-line backend available on the host system.

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
| Linux · X11 | `scrot`, ImageMagick `import`, or `ffmpeg` | `ffmpeg` |
| Linux · Wayland | `grim` | Compositor-dependent |
| macOS / WSL | Best effort via `ffmpeg` | Backend-dependent |

If `ffmpeg` is available on `PATH`, Marey can use it where supported.

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

**Short, deterministic recordings**

Fixed duration and frame rate make captures reproducible and easy for agents to request. An optional delay gives the user time to focus the target window before recording starts.

---

## Why the name?

Étienne-Jules Marey used chronophotography to make motion visible by decomposing it into successive images.

**Marey does the same thing for AI agents.**

---

## License

MIT — see [LICENSE](LICENSE).
