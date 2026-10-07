// Screen capture backends. Each backend shells out to a tool already present
// on the host (PowerShell on Windows; scrot / ImageMagick / grim / ffmpeg on
// Linux; screencapture on macOS) and returns PNG bytes. No npm dependency.
//
// Capture functions return the ORIGINAL encoded PNG bytes (a Buffer). The
// recorder writes those bytes straight to disk — it never decodes and
// re-encodes a full-resolution frame just to save it again. Decoding happens
// once, lazily, only when a thumbnail is needed for the contact sheet.
//
// Streams deliver each frame as { png, timeMs } where timeMs is the backend's
// acquisition time in milliseconds relative to the start of the capture loop.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { decodePng, pngDimensions } from './png.mjs';

const execFileAsync = promisify(execFile);

// --- helpers ---------------------------------------------------------------

function which(cmd) {
  // Resolve a command on PATH without a dependency. Uses the platform's own
  // lookup tool. Returns the resolved path or null.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return execFileAsync(finder, [cmd])
    .then((r) => r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null)
    .catch(() => null);
}

// Run a command and collect stdout as a Buffer (for backends that emit PNG
// bytes to stdout).
function runCapture(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// Error thrown when a requested target cannot be honoured on this backend.
// The recorder surfaces this verbatim rather than silently broadening scope.
export class TargetUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetUnavailableError';
  }
}

// --- Windows backend (PowerShell + System.Drawing) -------------------------

// Shared PowerShell helpers for capture. Window capture uses PrintWindow with
// PW_RENDERFULLCONTENT, which asks the window to render its OWN surface into an
// off-screen bitmap — so it is occlusion-proof (works even when another window
// is on top) and captures DWM/GPU-composited apps (Chrome, Electron). This is a
// true window grab, not a crop of the screen rectangle where the window sits.
//
// A minimized or cloaked (another virtual desktop / suspended UWP) window has no
// renderable surface, so we detect that and throw a MAREY_TARGET: sentinel error
// rather than returning a tiny garbage frame. The window is rendered into a
// 24bpp RGB bitmap on purpose: a 32bpp PrintWindow surface comes back with a
// zero alpha channel and would save as an all-transparent PNG.
function psCaptureCommon(className) {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class ${className} {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
}
"@

function Find-TargetWindow {
  param($title)
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $proc) { throw "MAREY_TARGET:No window with a title matching '$title'" }
  return $proc.MainWindowHandle
}

# A window is uncapturable when minimized (IsIconic) or cloaked by DWM
# (DWMWA_CLOAKED = 14 → on another virtual desktop or a suspended UWP app).
function Test-WindowHidden {
  param($hwnd)
  if ([${className}]::IsIconic($hwnd)) { return $true }
  $cloaked = 0
  try { [void][${className}]::DwmGetWindowAttribute($hwnd, 14, [ref]$cloaked, 4) } catch {}
  return ($cloaked -ne 0)
}

function Assert-Capturable {
  param($hwnd, $title)
  if (Test-WindowHidden $hwnd) {
    throw "MAREY_TARGET:Window '$title' is minimized or hidden; restore it on screen to capture it"
  }
}

function New-WindowBitmap {
  param($hwnd)
  $rect = New-Object RECT
  [void][${className}]::GetWindowRect($hwnd, [ref]$rect)
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw "MAREY_TARGET:Window '$hwnd' reports no on-screen area to capture" }
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $gfx.GetHdc()
  # PW_RENDERFULLCONTENT = 2 → render DWM/GPU-composited content, not a black box.
  $ok = [${className}]::PrintWindow($hwnd, $hdc, 2)
  $gfx.ReleaseHdc($hdc)
  $gfx.Dispose()
  if (-not $ok) { $bmp.Dispose(); throw "MAREY_TARGET:PrintWindow could not render the target window" }
  return $bmp
}

function New-ScreenBitmap {
  param($region)
  if ($region -eq 'virtual') {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  } else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  }
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $gfx.Dispose()
  return $bmp
}`;
}

// Escape a string for safe single-quoted interpolation into a PowerShell
// literal: double every embedded single quote. Prevents a window title from
// terminating the quote and injecting script.
function psQuote(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function windowsCaptureScript(region, title) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
${psCaptureCommon('Win32Single')}
if ('${psQuote(region)}' -eq 'window') {
  $hwnd = Find-TargetWindow -title '${psQuote(title)}'
  Assert-Capturable $hwnd '${psQuote(title)}'
  $bmp = New-WindowBitmap $hwnd
} else {
  $bmp = New-ScreenBitmap -region '${psQuote(region)}'
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
}

async function grabWindows({ region, title }) {
  const script = windowsCaptureScript(region, title);
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 256 * 1024 * 1024 }
    );
    return Buffer.from(stdout.trim(), 'base64');
  } catch (err) {
    throw mapTargetError(err, region);
  }
}

// Translate a PowerShell failure into a TargetUnavailableError when it carries
// our MAREY_TARGET: sentinel (window not found / minimized / cloaked / no
// surface). Everything else propagates unchanged.
function mapTargetError(err, region) {
  const msg = (err.stderr || err.message || '').toString();
  const m = msg.match(/MAREY_TARGET:(.+)/);
  if (m) return new TargetUnavailableError(m[1].trim());
  return err;
}

// Open-ended streaming capture: grab frames at `intervalMs` spacing in an
// unbounded loop until the process is killed. Each frame is one stdout line:
//   "FRAME <elapsedMs> <base64Png>"
// Scheduling targets intended capture times and SKIPS missed slots when the
// backend falls behind (rather than firing a burst of catch-up frames), so a
// slow host yields fewer, wider-spaced frames with truthful timestamps.
function windowsStreamScript(region, title, intervalMs) {
  const isWindow = region === 'window';
  // Window streams render the window's own surface fresh each frame (its size or
  // content can change). Screen streams reuse one bitmap + CopyFromScreen, which
  // is cheaper. Startup resolves + validates the target up front so an open
  // stream fails fast (readiness error) instead of looping on a bad target.
  const setup = isWindow
    ? `
$hwnd = Find-TargetWindow -title '${psQuote(title)}'
Assert-Capturable $hwnd '${psQuote(title)}'`
    : `
$bounds = if ('${psQuote(region)}' -eq 'virtual') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)`;
  // Per-frame grab. For a window: skip the frame if it is transiently minimized
  // (gap in the timeline is honest; we never fall back to the desktop). For a
  // screen: blit into the reused bitmap.
  const grabFrame = isWindow
    ? `
  if (Test-WindowHidden $hwnd) { if ($interval -gt 0) { $i = [math]::Floor($sw.Elapsed.TotalMilliseconds / $interval) + 1 } else { $i++ }; continue }
  try { $frame = New-WindowBitmap $hwnd } catch { if ($interval -gt 0) { $i = [math]::Floor($sw.Elapsed.TotalMilliseconds / $interval) + 1 } else { $i++ }; continue }`
    : `
  $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $frame = $bmp`;
  const disposeFrame = isWindow ? '$frame.Dispose()' : '';
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
${psCaptureCommon('Win32Stream')}
${setup}
$stdout = [Console]::Out
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$interval = [double]${intervalMs}
$i = 0
while ($true) {
  $target = $i * $interval
  $wait = $target - $sw.Elapsed.TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
${grabFrame}
  $elapsed = $sw.Elapsed.TotalMilliseconds
  $ms = New-Object System.IO.MemoryStream
  $frame.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $stdout.WriteLine("FRAME " + [int]$elapsed + " " + [Convert]::ToBase64String($ms.ToArray()))
  $ms.Dispose()
  ${disposeFrame}
  # Skip any slots we already missed so we never accumulate a backlog.
  if ($interval -gt 0) { $i = [math]::Floor($elapsed / $interval) + 1 } else { $i++ }
}
`;
}

function startStreamWindows({ region, title, intervalMs }, onFrame) {
  const script = windowsStreamScript(region, title, intervalMs);
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true }
  );

  let count = 0;
  let buffer = '';
  const errChunks = [];
  let exited = false;
  let spawnError = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('FRAME ')) continue;
      const sp = line.indexOf(' ', 6);
      const timeMs = parseInt(line.slice(6, sp), 10);
      const png = Buffer.from(line.slice(sp + 1), 'base64');
      count++;
      if (onFrame) onFrame({ png, timeMs }, count);
    }
  });
  child.stderr.on('data', (d) => errChunks.push(d));
  child.on('error', (e) => { spawnError = e; exited = true; });
  const closed = new Promise((resolve) => child.on('close', () => { exited = true; resolve(); }));

  return {
    stop() {
      child.kill();
      return closed;
    },
    whenClosed() { return closed; },
    get exited() { return exited; },
    get framesSeen() { return count; },
    get error() {
      if (spawnError) return spawnError.message;
      const text = errChunks.length ? Buffer.concat(errChunks).toString('utf8').trim() : '';
      if (!text) return null;
      // Surface our own target sentinel as a clean message rather than the raw
      // PowerShell stack trace (e.g. a minimized/missing window target).
      const m = text.match(/MAREY_TARGET:(.+)/);
      return m ? m[1].trim() : text;
    },
  };
}

async function listWindowsWindows() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32List {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
}
"@
$procs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 }
$list = foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  $rect = New-Object RECT
  [void][Win32List]::GetWindowRect($h, [ref]$rect)
  # A window is uncapturable when minimized (IsIconic) or cloaked by DWM
  # (DWMWA_CLOAKED = 14 → another virtual desktop / suspended UWP app).
  $cloaked = 0
  try { [void][Win32List]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) } catch {}
  $hidden = [Win32List]::IsIconic($h) -or ($cloaked -ne 0)
  [PSCustomObject]@{
    title  = $p.MainWindowTitle
    process = $p.ProcessName
    x = $rect.Left; y = $rect.Top
    width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top)
    hidden = [bool]$hidden
  }
}
$list | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// --- Linux backends --------------------------------------------------------

async function grabLinux({ region, title }) {
  const isWayland = !!process.env.WAYLAND_DISPLAY;

  if (region === 'window') {
    // Honour the window target explicitly, or fail — never silently broaden to
    // the whole desktop. Window capture needs ffmpeg + xdotool geometry.
    const [ffmpeg, xdotool] = await Promise.all([which('ffmpeg'), which('xdotool')]);
    if (!ffmpeg || !xdotool) {
      throw new TargetUnavailableError(
        'Window capture on Linux requires both ffmpeg and xdotool on PATH.'
      );
    }
    const { stdout } = await execFileAsync('xdotool', [
      'search', '--name', title || '', 'getwindowgeometry', '--shell',
    ]).catch(() => ({ stdout: '' }));
    const geo = Object.fromEntries(
      stdout.split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length === 2)
    );
    if (!geo.WIDTH || !geo.HEIGHT) {
      throw new TargetUnavailableError(`Window capture target not found: "${title}"`);
    }
    return runCapture('ffmpeg', [
      '-y', '-f', 'x11grab',
      '-video_size', `${geo.WIDTH}x${geo.HEIGHT}`,
      '-i', `${process.env.DISPLAY || ':0'}+${geo.X || 0},${geo.Y || 0}`,
      '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1',
    ]);
  }

  if (isWayland && (await which('grim'))) {
    return runCapture('grim', ['-']);
  }
  if (await which('scrot')) {
    return runCapture('scrot', ['-o', '/dev/stdout']);
  }
  if (await which('import')) {
    return runCapture('import', ['-window', 'root', 'png:-']);
  }
  if (await which('ffmpeg')) {
    return runCapture('ffmpeg', [
      '-y', '-f', 'x11grab', '-i', process.env.DISPLAY || ':0',
      '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1',
    ]);
  }
  throw new Error('No Linux capture backend found (tried grim, scrot, import, ffmpeg)');
}

async function listWindowsLinux() {
  const wmctrl = await which('wmctrl');
  if (wmctrl) {
    const { stdout } = await execFileAsync('wmctrl', ['-lG']).catch(() => ({ stdout: '' }));
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const [, , x, y, w, h] = parts;
        const title = parts.slice(7).join(' ');
        return { title, x: +x, y: +y, width: +w, height: +h };
      });
  }
  const xdotool = await which('xdotool');
  if (xdotool) {
    const { stdout } = await execFileAsync('xdotool', ['search', '--name', '']).catch(() => ({ stdout: '' }));
    const ids = stdout.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const id of ids.slice(0, 100)) {
      const { stdout: name } = await execFileAsync('xdotool', ['getwindowname', id]).catch(() => ({ stdout: '' }));
      if (name.trim()) out.push({ title: name.trim(), id });
    }
    return out;
  }
  return [];
}

// --- macOS backend ---------------------------------------------------------

async function grabDarwin({ region, title }) {
  if (region === 'window') {
    // The bundled screencapture path captures a display, not an arbitrary
    // window surface, so window scope cannot be honoured here. Fail loudly
    // rather than returning the whole screen while reporting "window".
    throw new TargetUnavailableError('Window capture is not supported on the macOS backend yet.');
  }
  if (await which('screencapture')) {
    const tmp = `${os.tmpdir()}/marey-${process.pid}-${process.hrtime.bigint()}.png`;
    await execFileAsync('screencapture', ['-x', '-t', 'png', tmp]);
    const { readFile, unlink } = await import('node:fs/promises');
    const buf = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    return buf;
  }
  throw new Error('macOS capture requires the `screencapture` tool');
}

// --- portable streaming (non-Windows) --------------------------------------

// Timed loop of single captures until stopped. The FIRST capture is treated as
// readiness: if it fails, the stream errors and exits immediately so the
// recorder reports a real startup failure instead of an endless empty session.
// Later transient failures are counted but do not kill the stream.
function startStreamPortable({ region, title, intervalMs }, onFrame, deps) {
  const grab = deps.grabPng;
  const clock = deps.clock;
  let stopped = false;
  let exited = false;
  let timer = null;
  let count = 0;
  let firstError = null;
  let transientErrors = 0;
  const start = clock.now();

  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const finish = () => { if (!exited) { exited = true; resolveClosed(); } };

  const tick = async () => {
    if (stopped) return;
    try {
      const png = await grab({ region, title });
      if (stopped) return;
      count++;
      if (onFrame) onFrame({ png, timeMs: Math.round(clock.now() - start) }, count);
    } catch (err) {
      if (count === 0) {
        // First frame failed → fatal startup/target error.
        firstError = err;
        finish();
        return;
      }
      transientErrors++;
    }
    if (!stopped) timer = clock.setTimeout(tick, intervalMs);
  };
  timer = clock.setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clock.clearTimeout(timer);
      finish();
      return closed;
    },
    whenClosed() { return closed; },
    get exited() { return exited; },
    get framesSeen() { return count; },
    get error() {
      if (firstError) return firstError.message;
      if (transientErrors) return `${transientErrors} transient capture error(s)`;
      return null;
    },
  };
}

// --- public API ------------------------------------------------------------

// Grab a single frame as raw PNG bytes (Buffer). region: 'primary' | 'virtual'
// | 'window'. Throws TargetUnavailableError when a window target cannot be
// honoured on this backend.
export async function grabPng(opts = {}) {
  const region = opts.region || 'primary';
  const title = opts.title;
  switch (process.platform) {
    case 'win32': return grabWindows({ region, title });
    case 'linux': return grabLinux({ region, title });
    case 'darwin': return grabDarwin({ region, title });
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// Capture a single frame and return a decoded RGBA image: { width, height, data }.
// Thin wrapper over grabPng for the single-shot `capture` tool.
export async function captureFrame(opts = {}) {
  return decodePng(await grabPng(opts));
}

// The default capture backend used by the session controller. Streams raw PNG
// frames. On Windows a single PowerShell process does the whole stream (so the
// frame rate is real); elsewhere a timed per-frame loop is used.
//
// startStream({ region, title, intervalMs }, onFrame) -> handle where
//   onFrame({ png, timeMs }, count) fires per frame,
//   handle = { stop(): Promise<void>, get exited, get framesSeen, get error }.
export function createDefaultBackend(clock) {
  return {
    name: 'default',
    startStream(opts, onFrame) {
      if (process.platform === 'win32') return startStreamWindows(opts, onFrame);
      return startStreamPortable(opts, onFrame, { grabPng, clock });
    },
  };
}

// List candidate windows for targeting.
export async function listWindows() {
  switch (process.platform) {
    case 'win32':
      return listWindowsWindows();
    case 'linux':
      return listWindowsLinux();
    default:
      return [];
  }
}

// Report capture capabilities for diagnostics (marey doctor / list_windows):
// which backend will be used and whether window capture is honoured.
export async function captureCapabilities() {
  const backend = await detectBackend();
  let windowCapture = false;
  if (process.platform === 'win32') {
    windowCapture = true;
  } else if (process.platform === 'linux') {
    const [ffmpeg, xdotool] = await Promise.all([which('ffmpeg'), which('xdotool')]);
    windowCapture = !!(ffmpeg && xdotool);
  } else if (process.platform === 'darwin') {
    windowCapture = false; // display-only via screencapture
  }
  return {
    platform: process.platform,
    backend,
    regions: windowCapture ? ['primary', 'virtual', 'window'] : ['primary', 'virtual'],
    windowCapture,
  };
}

// Report which backend will be used, for diagnostics. Detects the executable;
// it does NOT prove a successful capture (that is a separate probe).
export async function detectBackend() {
  if (process.platform === 'win32') return 'windows:System.Drawing';
  if (process.platform === 'darwin') {
    return (await which('screencapture')) ? 'darwin:screencapture' : 'darwin:none';
  }
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY && (await which('grim'))) return 'linux:grim';
    if (await which('scrot')) return 'linux:scrot';
    if (await which('import')) return 'linux:import';
    if (await which('ffmpeg')) return 'linux:ffmpeg';
    return 'linux:none';
  }
  return 'unknown';
}

export { pngDimensions };
