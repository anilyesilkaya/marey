---
name: marey
description: >-
  Use Marey to inspect visual behavior that changes over time by capturing the
  screen or a specific window as timestamped frames and a contact sheet. Use for
  animations, transitions, dragging, hover states, menus opening or closing,
  flashes, rendering glitches, visual reordering, stutter, and other UI behavior
  that cannot be understood reliably from a single screenshot. Also use when
  setting up, connecting, configuring, testing, or troubleshooting Marey.
---

# Marey

Marey is an MCP server in this repository for inspecting **temporal visual
behavior**.

It captures a screen or window as timestamped still frames and combines the
frames into a contact sheet that can be inspected as a single image.

Use Marey when understanding **what changes between frames** matters.

## Decide whether to use Marey

Use:

- `capture` when one static screenshot is sufficient.
- `record` when the behavior involves motion, timing, transitions, interaction,
  or a state change.
- `list_windows` before targeting a specific application window.

Typical reasons to use `record` include:

- dragging or resizing
- animations and transitions
- hover behavior
- menus or popovers opening and closing
- flicker or flashes
- canvas or DOM elements moving or reordering
- rendering glitches that appear briefly
- stutter or inconsistent frame-to-frame behavior
- UI state changes caused by an interaction

Do **not** record several seconds of the screen when a single screenshot can
answer the question.

Prefer the smallest relevant capture scope. A specific window is usually better
than the entire desktop.

# Normal workflow

When Marey is already connected, do not repeat installation or backend checks.

## Static visual inspection

Call:

```text
capture
```

Prefer a specific window when possible.

## Temporal visual inspection

1. If the relevant window is not known, call `list_windows`.
2. Select the target using a distinctive substring of its title.
3. Call `record`.
4. Inspect the returned contact sheet.
5. Compare frames in chronological order.
6. Refer to both **frame numbers and timestamps** when describing a change.
7. If one transition needs closer inspection, inspect the corresponding
   full-resolution raw frames before making another recording.

Do not infer exact timing from frame numbers or requested FPS. Use the timestamp
shown on each frame because FPS is only a target.

# Recording defaults

Start with the smallest recording likely to reveal the behavior.

### Normal UI interaction

```text
seconds: 4
fps: 3
cols: 4
thumbWidth: 480
```

### Slow animation or transition

```text
seconds: 6
fps: 2
```

### Short or fast visual event

```text
seconds: 2
fps: 6
```

Higher requested FPS does not guarantee higher effective FPS. Screen capture and
PNG encoding take time.

If frames are being missed:

1. Prefer `region: "window"` over full-screen capture.
2. Reduce the captured area if possible.
3. Shorten the recording.
4. Increase `fps` only when the event genuinely requires it.

If the contact sheet is difficult to inspect, increase `thumbWidth` or reduce
`cols`.

# Targeting a window

Call `list_windows` first when the target title is uncertain.

Then record using:

```text
region: "window"
title: "<distinctive window-title substring>"
```

Example:

```text
record {
  seconds: 4,
  fps: 3,
  region: "window",
  title: "Visual Studio Code"
}
```

Prefer window capture because it:

- removes unrelated visual noise
- reduces privacy exposure
- reduces capture cost
- can improve effective frame rate
- produces easier-to-read contact sheets

# Coordinating an interaction

If the behavior must be triggered manually, use `delay`.

Example:

```text
delay: 3
```

Tell the user what action should be performed during the recording and keep the
interaction simple enough to reproduce reliably.

Do not use long delays when they are unnecessary.

# Interpreting a recording

Treat the recording as a sequence, not as independent screenshots.

When analyzing the result:

1. Establish the initial state.
2. Find the first frame where a visible change occurs.
3. Follow the change through subsequent frames.
4. Identify the final stable state.
5. Reference relevant frames and timestamps.
6. Distinguish what is directly visible from what is inferred.

Prefer statements such as:

```text
The menu is closed at #003 (0.84 s), begins appearing at #004 (1.17 s), and is
fully visible by #005 (1.51 s).
```

Avoid unsupported timing claims based only on the requested FPS.

If the contact sheet does not contain enough detail, inspect the relevant raw
full-resolution frames under:

```text
captures/<timestamp>/
```

Do this before re-recording unless the event itself was missed.

# Available MCP tools

Marey exposes three tools.

| Tool | Use |
| --- | --- |
| `record` | Capture temporal behavior and return a contact sheet |
| `capture` | Capture one screenshot |
| `list_windows` | Discover windows that can be targeted |

## `record`

Parameters:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `seconds` | `5` | Recording duration, 0.1–120 seconds |
| `fps` | `2` | Target frames per second, 0.1–60 |
| `region` | `primary` | `primary`, `virtual`, or `window` |
| `title` | — | Window-title substring required for `window` |
| `delay` | `0` | Delay before recording starts |
| `cols` | `4` | Contact-sheet columns |
| `thumbWidth` | `480` | Thumbnail width in pixels |

`capture` supports `region`, `title`, and `delay`.

`list_windows` takes no arguments.

# Setup

Only perform these steps when Marey is being installed, connected, or
troubleshot.

## Requirements

- Node.js 18+

Capture backends are auto-detected:

- **Windows 10/11:** PowerShell + `System.Drawing`
- **Linux X11:** `scrot`, ImageMagick `import`, or `ffmpeg`
- **Linux Wayland:** `grim`
- **macOS:** built-in `screencapture`

Window capture on Linux requires the appropriate backend support.

## Verify capture before MCP configuration

From the repository root:

```bash
node src/cli.mjs backend
node src/cli.mjs windows
node src/cli.mjs capture --region primary
```

Confirm that the resulting screenshot is valid.

If the backend reports `*:none` or capture fails, fix the capture backend before
debugging MCP configuration.

Then test recording:

```bash
node src/cli.mjs record --seconds 3 --fps 4 --cols 4 --thumbWidth 320
```

Inspect:

```text
captures/latest-contactsheet.png
```

# Connect Claude Code

Use an absolute path:

```bash
claude mcp add marey -- node /absolute/path/to/marey/src/server.mjs
```

Verify using:

```bash
claude mcp list
```

or `/mcp` inside Claude Code.

The following tools should be available:

```text
record
capture
list_windows
```

# Connect another MCP client

Use an absolute path to `src/server.mjs`:

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

Restart the MCP client after modifying its configuration.

# Troubleshooting

### No capture backend

```text
linux:none
```

Install a supported capture backend.

### Window cannot be found

Run `list_windows` again and choose a distinctive substring from the current
window title.

The window must be visible and non-minimized.

### MCP connects but capture hangs

Test:

```bash
node src/cli.mjs capture
```

If this also fails, troubleshoot the capture backend rather than MCP.

### MCP output cannot be parsed

The server uses:

- stdout for JSON-RPC
- stderr for diagnostic logging

Do not add arbitrary stdout logging to the MCP server.

# Verification

Run the test suite:

```bash
npm test
```

To test the MCP protocol directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/server.mjs
```

The response should identify the server as `marey` and list:

```text
record
capture
list_windows
```
