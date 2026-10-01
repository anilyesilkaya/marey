# marey

**An MCP server that lets AI agents watch your screen — as a sequence of stills.**

Named after [Étienne-Jules Marey](https://en.wikipedia.org/wiki/%C3%89tienne-Jules_Marey),
who pioneered *chronophotography*: capturing motion as a series of still frames on a
single plate. Marey (the server) does the same for AI agents — it records the screen
and returns the motion as frames an agent can actually see.

## Why

LLMs read still images, not video or GIFs. When you record a GIF of a bug — "the
anchor jitters when I drag it", "the menu flashes and closes" — and hand it to an
agent, it only receives the first frame. The motion is lost.

Marey closes that gap. It captures a timed sequence of screenshots and returns them
as a **contact sheet**: one image holding a numbered, timestamped grid of every
frame. Because it speaks the [Model Context Protocol](https://modelcontextprotocol.io),
the agent can *request the recording itself* and receive that image inline — no
saving files, no dragging screenshots into chat.

```
   agent asks           marey captures            agent receives
  "record 5s of   ──►   frame_001  frame_002  ──►   one contact-sheet
   the Euclid           frame_003  frame_004         image (N tiles,
   canvas"              ...                          numbered + timed)
```

## What it exposes

Marey is an MCP server. It offers a small set of tools to any connected agent:

| Tool | Purpose |
|---|---|
| `record` | Capture the screen for `seconds` at `fps`; return a contact-sheet image + metadata |
| `capture` | Grab a single frame right now |
| `list_windows` | Enumerate capturable windows (for `region: "window"`) |

`record` returns MCP **image content** (the contact sheet) plus a short text summary
(frame count, dimensions, elapsed time), so the agent sees the motion directly in its
context. Raw frames are also written to disk so you can re-stitch them differently.

## Requirements

- **Node.js 18+** — the only hard requirement. The core (PNG read/write + contact-sheet
  compositing) is pure JavaScript with **zero runtime dependencies** beyond the MCP SDK.
- A **screen-capture backend**, auto-detected at runtime:
  - **Windows 10/11** — built-in PowerShell + `System.Drawing` (nothing to install).
  - **Linux (X11)** — `scrot`, ImageMagick `import`, or `ffmpeg`.
  - **Linux (Wayland)** — `grim`.
  - **Any OS** — `ffmpeg` on `PATH` is used when present (also enables window capture).

## Install

```bash
git clone https://github.com/anilyesilkaya/marey.git
cd marey
npm install
```

## Connect it to an agent

Add Marey to your MCP client config. For **Claude Code**:

```bash
claude mcp add marey -- node /absolute/path/to/marey/src/server.mjs
```

For **Claude Desktop** (`claude_desktop_config.json`) or any MCP client:

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

Once connected, just ask the agent to record:

> "Use marey to record 6 seconds of the Euclid window at 4fps while I drag an anchor,
> then tell me what you see."

## Tool reference

### `record`

| Param | Default | Meaning |
|---|---|---|
| `seconds` | `5` | Recording duration |
| `fps` | `2` | Frames per second (raise for fast motion; lowers readability) |
| `region` | `primary` | `primary` \| `virtual` (all monitors) \| `window` |
| `title` | — | Window-title substring (required when `region` is `window`) |
| `delay` | `0` | Count-in seconds before the first frame |
| `cols` | `4` | Thumbnails per row in the contact sheet |
| `thumbWidth` | `480` | Thumbnail width in px (height follows aspect ratio) |

Returns: an image block (the contact sheet) + a text summary. Frames and the sheet are
also saved under `captures/<timestamp>/`.

### `capture`

One frame of `region` (same `region`/`title` semantics as `record`). Returns a single
image block.

### `list_windows`

Returns the titles (and geometry where available) of visible windows, so an agent can
pick a `title` for window capture.

## Output on disk

```
captures/20260101-120000/
  frame_001_00000ms.png     raw frames (kept for re-stitching)
  frame_002_00500ms.png
  ...
  contactsheet.png          the composed grid returned to the agent
captures/latest-contactsheet.png   always mirrors the most recent sheet
```

## Platform support

| Platform | Full / monitor capture | Window capture |
|---|---|---|
| Windows 10/11 | ✅ built-in | ✅ built-in |
| Linux (X11) | ✅ `scrot` / `import` / `ffmpeg` | ✅ `ffmpeg` |
| Linux (Wayland) | ✅ `grim` | ⚠️ compositor-dependent |
| macOS / WSL | best-effort via `ffmpeg` | — |

## Design decisions

Defaults chosen for the open questions — all are up for revision:

- **MCP server, not a CLI.** The whole point is that the agent requests the recording
  and receives the result inline. (A thin CLI wrapper over the same core is an easy
  add if you want manual recordings too.)
- **Contact sheet is the delivered artifact.** One image conveys the full sequence;
  raw frames are kept on disk for re-stitching at a different `cols`/`thumbWidth`
  without re-recording.
- **Zero-dependency core.** A pure-JS PNG codec + compositor keeps the irreplaceable
  "frames → one image" step identical on every OS; only the OS-specific *capture*
  shells out to a native tool. The one external dependency is the MCP SDK itself.
- **Fixed duration + FPS**, not start/stop hotkeys — scriptable and good for short
  interactions. An optional `delay` gives you time to focus the target.

## License

MIT — see [LICENSE](LICENSE).
