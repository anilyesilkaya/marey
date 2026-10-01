# Marey v0.1.0

**Give AI agents eyes for motion.** A screenshot tells an agent what the screen
*looks like*. Marey tells it what *changed*.

Marey is an MCP server that turns a short screen interaction into a timestamped,
agent-readable **contact sheet** — a grid of still frames an agent can inspect as
a temporal sequence, with any frame retrievable at full resolution.

## Install

```bash
claude mcp add marey -- npx -y marey
```

Or install the Claude Code plugin (MCP server + skill):

```text
/plugin marketplace add anilyesilkaya/marey
/plugin install marey@marey
```

**Zero runtime dependencies.** Requires Node.js 18+.

## Supported platforms

| Platform | Monitor capture | Window capture |
| --- | --- | --- |
| Windows 10/11 | PowerShell + `System.Drawing` | ✓ |
| Linux · X11 | `scrot`, ImageMagick, or `ffmpeg` | `ffmpeg` + `xdotool` |
| Linux · Wayland | `grim` | compositor-dependent |
| macOS | `screencapture` | not yet supported |

## Example prompt

> Use Marey to record my editor window for 5 seconds at 4 fps with high detail
> while I drag this control point, then tell me what changes between frames.

The agent receives the whole interaction as one image and reasons about the
transition — not just the initial state. See the README for a worked example
where Marey exposes a drag that jumps mid-gesture.

## Known limitations

- `fps` is a **target**; the achievable rate is bounded by capture + PNG-encode
  time (roughly 2–3 fps at full screen on a 2560×1440 monitor). Capture a window
  or a smaller region for higher effective rates.
- **macOS window capture** is not yet supported (full-screen only).
- **Linux** requires a capture backend on `PATH` (`scrot` / `grim` / `ffmpeg`);
  window capture needs `ffmpeg` + `xdotool`.
- Recordings are written to `./captures/` in the client's working directory.
- Only one open-ended recording (`start_recording`) may be active at a time.
