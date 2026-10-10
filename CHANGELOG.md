# Changelog

All notable changes to Marey are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Persistent FFmpeg X11/macOS capture with acquisition timestamps, low-latency
  output, and recording-time `rect` selection. Native-command fallback timing
  skips missed deadlines instead of adding capture time to every interval.
- Stable `windowId` targeting, hidden/ambiguous target rejection, and resolved
  target/bounds metadata. X11 discovery uses xdotool + xwininfo.
- MCP structured evidence for newer clients, with a quality text fallback:
  achieved FPS, acquisition gaps, partial failures, warnings, and completion reasons.
- `get_frames` / CLI `get-frames` for cropped time-range contact sheets.
- Transition-neighborhood selection and a real-pixel X11 CI regression covering
  a 100ms flash, blank screens, and native window targeting.

### Changed

- Default target recording rate increased from 2 to 15 fps. Achieved rate remains
  backend-dependent and is reported separately.
- `stop_recording` retrieves preserved evidence after automatic termination.
- ImageMagick captures use 8-bit non-interlaced RGB, including monochrome screens.
- Unsupported macOS virtual-desktop and Wayland primary/window scopes fail
  explicitly instead of silently capturing a broader screen.

## [0.1.0]

Initial release.

### Added

- **MCP server** exposing six tools: `record`, `start_recording`,
  `stop_recording`, `capture`, `get_frame`, and `list_windows`.
- **Contact sheets** — recordings are composed into a single numbered,
  timestamped grid returned to the agent as MCP image content.
- **Full-resolution frame retrieval** via `get_frame`.
- **`detail` presets** (`overview`, `high`, `max`) for the overview-vs-legibility
  trade-off.
- **Capture backends:** Windows (PowerShell + `System.Drawing`), Linux X11
  (`scrot` / ImageMagick / `ffmpeg`), Linux Wayland (`grim`), macOS
  (`screencapture`).
- **npm distribution** — installable with `npx -y @anilyesilkaya/marey`; zero runtime
  dependencies.
- **Claude Code plugin** bundling the MCP server and the Marey skill.
- **Official MCP Registry** manifest (`server.json`) under the name
  `io.github.anilyesilkaya/marey`.

[0.1.0]: https://github.com/anilyesilkaya/marey/releases/tag/v0.1.0
