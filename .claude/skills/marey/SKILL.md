---
name: marey
description: >-
  Set up and use Marey — the zero-dependency MCP server in this repo that
  records the screen as a sequence of still frames and returns a single
  contact-sheet image. Use when the user wants to install/connect/configure
  Marey, verify its capture backend, record or screenshot the screen to inspect
  MOTION (dragging, animations, flashes, menus opening/closing, canvas
  re-ordering, stutter, hover states), build a contact sheet from frames, or
  debug a visual behavior that a single screenshot cannot explain. Triggers:
  "set up marey", "connect marey", "record my screen", "capture the screen",
  "contact sheet", "show me the frames", "what changes between frames".
---

# Marey

Marey is an MCP server (in this repo) that captures short screen recordings as
a numbered, timestamped sequence of still frames and composes them into one
**contact sheet** image an agent can reason about. It has **zero npm runtime
dependencies** — everything runs on Node builtins.

Use it whenever a single screenshot is not enough: motion, transitions, timing,
anything that happens *across* frames.

## Prerequisites

- **Node.js 18+** (`node --version`).
- A capture backend for the host OS (auto-detected):
  - **Windows 10/11** — built-in PowerShell + `System.Drawing`. Nothing to install.
  - **Linux (X11)** — `scrot`, ImageMagick `import`, or `ffmpeg`; window capture needs `ffmpeg` + `xdotool`.
  - **Linux (Wayland)** — `grim`.
  - **macOS** — built-in `screencapture` (full-screen only; no window capture yet).

## Step 1 — Verify the backend BEFORE connecting a client

Always confirm capture works standalone first; it isolates OS/permission issues
from MCP wiring. From the repo root:

```bash
node src/cli.mjs backend          # prints the detected backend, e.g. windows:System.Drawing
node src/cli.mjs windows          # lists targetable windows
node src/cli.mjs capture --region primary
```

Then open the newest file under `captures/` (or `captures/latest-capture.png`)
and confirm it is a real screenshot. If `backend` prints `*:none` or `capture`
throws, install a backend from the list above — do NOT proceed to Step 3 until a
plain capture works.

> macOS note: the first run may prompt for Screen Recording permission
> (System Settings → Privacy & Security → Screen Recording). Grant it, then
> retry.

## Step 2 — Try a recording (still no MCP client needed)

```bash
node src/cli.mjs record --seconds 3 --fps 4 --cols 4 --thumbWidth 320
```

Open `captures/latest-contactsheet.png`. You should see a grid of thumbnails,
each labeled with its frame number and **actual** elapsed time (e.g. `#003
1.35S`). The raw frames are in `captures/<timestamp>/`.

**Frame rate is a target, not a guarantee.** Grabbing + PNG-encoding a frame
costs real time (hundreds of ms at full resolution), so the practical ceiling is
~2–3 fps on a large monitor. Capture a smaller `region` or a single `window` for
higher effective rates. Labels always show true elapsed time, so the timeline is
honest even when `fps` is not met.

## Step 3 — Connect to an MCP client

### Claude Code

Use an **absolute path** to `src/server.mjs`:

```bash
claude mcp add marey -- node /absolute/path/to/marey/src/server.mjs
```

Verify with `claude mcp list` (or `/mcp` inside a session). The tools
`record`, `capture`, and `list_windows` should appear.

### Claude Desktop or another MCP client

Add to the client's MCP config (absolute path, forward slashes on Windows too):

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

Restart the client after editing its config.

## Step 4 — Use the tools

Marey exposes exactly three tools over MCP:

| Tool | Purpose |
| --- | --- |
| `record` | Record for a fixed duration → return a contact-sheet image + metadata text |
| `capture` | Take one screenshot → return a single image |
| `list_windows` | List visible windows (title/process/geometry) to pick a target |

### `record` parameters

| Param | Default | Notes |
| --- | ---: | --- |
| `seconds` | `5` | Duration (0.1–120) |
| `fps` | `2` | Target frames/second (0.1–60) |
| `region` | `primary` | `primary`, `virtual` (all monitors), or `window` |
| `title` | — | Window-title substring; **required** when `region: "window"` |
| `delay` | `0` | Seconds to wait before recording (gives the user time to focus/arrange the target) |
| `cols` | `4` | Thumbnails per contact-sheet row |
| `thumbWidth` | `480` | Thumbnail width in px |

`capture` takes `region`, `title`, and `delay` with the same meaning.
`list_windows` takes no arguments.

### Choosing a window target

To record a specific window, call `list_windows` first, copy a distinctive
substring of the title, then pass it as `title` with `region: "window"`:

```
record { seconds: 6, fps: 4, region: "window", title: "Visual Studio Code" }
```

## Recommended workflow for inspecting a motion bug

1. If a specific window is involved, call `list_windows` and note its title.
2. Use `delay` (e.g. `delay: 3`) so the user can trigger the interaction right
   as recording starts; tell the user exactly when to begin.
3. `record` the interaction (`region: "window"` + `title` when possible — it is
   faster and crops out noise).
4. Read the returned contact-sheet image and describe what changes **between**
   numbered frames, referencing frame numbers and timestamps.
5. If more detail is needed, the raw full-resolution frames are on disk under
   `captures/<timestamp>/` — re-inspect a single frame rather than re-recording.

## Tuning tips

- **Blurry/small thumbnails?** Increase `thumbWidth` (e.g. `640`) and/or reduce
  `cols` so each cell is larger.
- **Too many/few frames?** Frame count ≈ `seconds × fps`. For a slow transition,
  lower `fps`; for a fast flash, raise `fps` and shorten `seconds`.
- **Missed the start of the action?** Add `delay` and coordinate with the user.
- **Full-screen capture too slow to hit `fps`?** Switch to `region: "window"` or
  a smaller area.

## Troubleshooting

- `backend` prints `linux:none` → install `scrot`/`grim`/`ffmpeg`/ImageMagick.
- `No window matching '<title>'` → run `list_windows`; the window must be open
  and non-minimized, and the match is a case-sensitive substring on Windows.
- Server connects but tool calls hang → confirm `node src/cli.mjs capture` works
  standalone (Step 1); the issue is the backend, not MCP.
- Garbled output / client can't parse → the server writes JSON-RPC on stdout and
  logs on stderr; never run it with extra stdout writes injected.

## Verifying the install programmatically

Run the core test suite (pure-JS image pipeline; no screen required):

```bash
npm test        # node --test
```

Or drive the MCP server directly over stdio to confirm the protocol layer:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/server.mjs
```

You should get an `initialize` result naming `marey`, then a `tools/list`
result listing `record`, `capture`, and `list_windows`.
