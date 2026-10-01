# Changelog

All notable changes to Marey are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
