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
import { captureRect, selectWindow, TargetUnavailableError } from './capture-target.mjs';
import { deferredStream, startFfmpegStream } from './capture-stream.mjs';
export { TargetUnavailableError } from './capture-target.mjs';

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
function runCapture(cmd, args, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    timer.unref?.();
    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
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
  param($title, $windowId)
  if ($windowId) {
    $handle = [IntPtr]([long]$windowId)
    if (-not [${className}]::IsWindow($handle)) { throw "MAREY_TARGET:Window ID no longer exists" }
    return $handle
  }
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
  param($region, $cropX=0, $cropY=0, $cropW=0, $cropH=0)
  if ($region -eq 'virtual') {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  } else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  }
  if ($cropW -gt 0) {
    if ($cropX + $cropW -gt $b.Width -or $cropY + $cropH -gt $b.Height) { throw "MAREY_TARGET:rect extends outside the capture target" }
    $b = New-Object System.Drawing.Rectangle(($b.X + $cropX), ($b.Y + $cropY), $cropW, $cropH)
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

function psCropBitmap(rect, variable, disposeOriginal = true) {
  if (!rect) return '';
  return `
if (${rect.x + rect.w} -gt ${variable}.Width -or ${rect.y + rect.h} -gt ${variable}.Height) { throw "MAREY_TARGET:rect extends outside the capture target" }
$cropRect = New-Object System.Drawing.Rectangle(${rect.x}, ${rect.y}, ${rect.w}, ${rect.h})
$cropped = ${variable}.Clone($cropRect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
${disposeOriginal ? `${variable}.Dispose()` : ''}
${variable} = $cropped`;
}

function windowsCaptureScript(region, title, windowId, rect) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
${psCaptureCommon('Win32Single')}
if ('${psQuote(region)}' -eq 'window') {
  $hwnd = Find-TargetWindow -title '${psQuote(title)}' -windowId '${psQuote(windowId)}'
  Assert-Capturable $hwnd '${psQuote(title)}'
  $bmp = New-WindowBitmap $hwnd
} else {
  $bmp = New-ScreenBitmap -region '${psQuote(region)}' ${rect ? `-cropX ${rect.x} -cropY ${rect.y} -cropW ${rect.w} -cropH ${rect.h}` : ''}
}
${psCropBitmap(region === 'window' ? rect : null, '$bmp')}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
}

async function grabWindows({ region, title, windowId, rect }) {
  const script = windowsCaptureScript(region, title, windowId, rect);
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
function windowsStreamScript(region, title, intervalMs, windowId, rect) {
  const isWindow = region === 'window';
  // Window streams render the window's own surface fresh each frame (its size or
  // content can change). Screen streams reuse one bitmap + CopyFromScreen, which
  // is cheaper. Startup resolves + validates the target up front so an open
  // stream fails fast (readiness error) instead of looping on a bad target.
  const setup = isWindow
    ? `
$hwnd = Find-TargetWindow -title '${psQuote(title)}' -windowId '${psQuote(windowId)}'
Assert-Capturable $hwnd '${psQuote(title)}'`
    : `
$bounds = if ('${psQuote(region)}' -eq 'virtual') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
${rect ? `$bounds = New-Object System.Drawing.Rectangle(($bounds.X + ${rect.x}), ($bounds.Y + ${rect.y}), ${rect.w}, ${rect.h})` : ''}
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
  ${psCropBitmap(isWindow ? rect : null, '$frame')}
  $frame.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $stdout.WriteLine("FRAME " + [int]$elapsed + " " + [Convert]::ToBase64String($ms.ToArray()))
  $ms.Dispose()
  ${disposeFrame}
  # Skip any slots we already missed so we never accumulate a backlog.
  if ($interval -gt 0) { $i = [math]::Floor($elapsed / $interval) + 1 } else { $i++ }
}
`;
}

function startStreamWindows({ region, title, intervalMs, windowId, rect }, onFrame) {
  const script = windowsStreamScript(region, title, intervalMs, windowId, rect);
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
    id = $h.ToInt64().ToString()
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

async function linuxWindow(id) {
  const [{ stdout: geo }, { stdout: title }, { stdout: info }] = await Promise.all([
    execFileAsync('xdotool', ['getwindowgeometry', '--shell', String(id)]),
    execFileAsync('xdotool', ['getwindowname', String(id)]),
    execFileAsync('xwininfo', ['-id', String(id)]),
  ]);
  const fields = Object.fromEntries(geo.trim().split(/\r?\n/).map((l) => l.split('=')));
  return { id: String(id), title: title.trim(), x: +fields.X, y: +fields.Y,
    width: +fields.WIDTH, height: +fields.HEIGHT,
    hidden: !/Map State:\s*IsViewable/.test(info) };
}

async function listWindowsLinux() {
  if (process.env.WAYLAND_DISPLAY) return [];
  if (!(await which('xdotool')) || !(await which('xwininfo'))) return [];
  const { stdout } = await execFileAsync('xdotool', ['search', '--name', '']).catch(() => ({ stdout: '' }));
  const ids = [...new Set(stdout.trim().split(/\r?\n/).filter(Boolean))];
  const out = [];
  for (const id of ids) {
    try { const w = await linuxWindow(id); if (w.title) out.push(w); } catch { /* window closed during discovery */ }
  }
  return out;
}

async function resolveTarget(opts) {
  const region = opts.region || 'primary';
  if (!['primary', 'virtual', 'window'].includes(region)) throw new TargetUnavailableError('Unknown capture region');
  if (process.platform === 'darwin' && region === 'virtual') throw new TargetUnavailableError('macOS virtual-desktop capture is unsupported; select region:"primary" or a rect');
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY && region === 'primary' && !opts.rect) {
    throw new TargetUnavailableError('Wayland cannot resolve a primary output on this backend; select region:"virtual" or an explicit rect');
  }
  if (region !== 'window' && (opts.windowId != null || opts.title)) throw new TargetUnavailableError('windowId/title requires region:"window"');
  let window = null;
  if (region === 'window') {
    if (process.platform === 'darwin' || process.env.WAYLAND_DISPLAY) throw new TargetUnavailableError('Window capture is unsupported on this backend');
    if (process.platform === 'linux' && (!(await which('xdotool')) || !(await which('xwininfo')))) {
      throw new TargetUnavailableError('X11 window capture requires xdotool and xwininfo');
    }
    if (opts.windowId != null && !/^(?:[1-9]\d*|0x[\da-f]+)$/i.test(String(opts.windowId))) throw new TargetUnavailableError('windowId must be a positive decimal or hexadecimal native window ID');
    window = opts.windowId != null && process.platform === 'linux'
      ? selectWindow([await linuxWindow(opts.windowId).catch(() => ({ id: opts.windowId, hidden: true }))], opts)
      : selectWindow(await listWindows(), opts);
  }
  let desktop = null;
  if (!window && process.platform === 'linux' && !process.env.WAYLAND_DISPLAY && await which('xdotool')) {
    const { stdout } = await execFileAsync('xdotool', ['getdisplaygeometry']);
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    desktop = { x: 0, y: 0, width, height };
    if (region === 'primary' && await which('xrandr')) {
      const monitors = await execFileAsync('xrandr', ['--listmonitors']).catch(() => ({ stdout: '' }));
      const line = monitors.stdout.split(/\r?\n/).find((l) => /\S*\*\S*\s+\d+\//.test(l));
      const m = line?.match(/(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/);
      if (m) desktop = { x: +m[3], y: +m[4], width: +m[1], height: +m[2] };
    }
  } else if (!window && process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $b = if ('${psQuote(region)}' -eq 'virtual') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }; @{ x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height } | ConvertTo-Json -Compress`]);
    desktop = JSON.parse(stdout.trim());
  }
  const rect = captureRect(opts.rect, window || desktop);
  const bounds = window ? { x: window.x + (rect?.x || 0), y: window.y + (rect?.y || 0),
    width: rect?.w || window.width, height: rect?.h || window.height } : desktop
    ? { x: desktop.x + (rect?.x || 0), y: desktop.y + (rect?.y || 0), width: rect?.w || desktop.width, height: rect?.h || desktop.height } : null;
  return { region, windowId: window?.id || null, title: window?.title || null,
    rect, bounds, boundsAt: 'capture-start', captureMethod: region === 'window'
      ? process.platform === 'linux' ? 'screen-rectangle' : 'window-surface'
      : rect ? 'screen-rectangle' : 'display' };
}

async function x11Input(target, fps) {
  const display = process.env.DISPLAY || ':0';
  // Root bounds also validate a desktop rectangle before capture begins.
  const { stdout } = await execFileAsync('xdotool', ['getdisplaygeometry']);
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  const rect = captureRect(target.rect, target.windowId ? null : { width, height });
  const x = target.windowId ? rect?.x || 0 : target.bounds?.x || 0;
  const y = target.windowId ? rect?.y || 0 : target.bounds?.y || 0;
  const args = ['-f', 'x11grab', '-framerate', String(fps)];
  if (target.windowId) args.push('-window_id', String(target.windowId));
  const w = rect?.w || target.bounds?.width || width;
  const h = rect?.h || target.bounds?.height || height;
  args.push('-video_size', `${w}x${h}`, '-i', `${display}+${x},${y}`);
  target.bounds ||= { x, y, width: w, height: h };
  return args;
}

async function grabLinux(opts) {
  const { region, rect, target, signal } = opts;
  if (region === 'window') {
    return runCapture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
      ...await x11Input(target, 1), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-pix_fmt', 'rgb24', 'pipe:1'], { signal });
  }
  if (process.env.WAYLAND_DISPLAY) {
    if (!(await which('grim'))) throw new Error('Wayland capture requires grim');
    return runCapture('grim', [...(rect ? ['-g', `${rect.x},${rect.y} ${rect.w}x${rect.h}`] : []), '-'], { signal });
  }
  if (await which('import')) {
    const crop = target.bounds || (rect ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h } : null);
    return runCapture('import', ['-window', 'root', '-depth', '8', '-define', 'png:color-type=2', '-interlace', 'none',
      ...(crop ? ['-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage'] : []), 'png:-'], { signal });
  }
  if (await which('ffmpeg')) {
    return runCapture('ffmpeg', ['-probesize', '32', '-analyzeduration', '0', ...await x11Input(target, 1), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-pix_fmt', 'rgb24', 'pipe:1'], { signal });
  }
  if (!rect && await which('scrot')) return runCapture('scrot', ['-o', '/dev/stdout'], { signal });
  throw new Error('No Linux capture backend found for this region (tried grim, import, ffmpeg, scrot)');
}

// --- macOS backend ---------------------------------------------------------

async function grabDarwin({ region, title, rect, signal }) {
  if (region === 'window') {
    // The bundled screencapture path captures a display, not an arbitrary
    // window surface, so window scope cannot be honoured here. Fail loudly
    // rather than returning the whole screen while reporting "window".
    throw new TargetUnavailableError('Window capture is not supported on the macOS backend yet.');
  }
  if (await which('screencapture')) {
    const tmp = `${os.tmpdir()}/marey-${process.pid}-${process.hrtime.bigint()}.png`;
    await execFileAsync('screencapture', ['-x', '-t', 'png', ...(rect ? ['-R', `${rect.x},${rect.y},${rect.w},${rect.h}`] : ['-m']), tmp], { signal, timeout: 10000 });
    const { readFile, unlink } = await import('node:fs/promises');
    const buf = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    return buf;
  }
  throw new Error('macOS capture requires the `screencapture` tool');
}

async function macStreamInput(target, fps) {
  let listing = '';
  try {
    const result = await execFileAsync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    listing = result.stderr;
  } catch (err) { listing = String(err.stderr || ''); }
  const screen = listing.match(/\[(\d+)\] Capture screen 0/);
  if (!screen) throw new Error('FFmpeg could not enumerate macOS screen 0; enable Screen Recording permission or use the native screencapture fallback without FFmpeg on PATH');
  return ['-f', 'avfoundation', '-framerate', String(fps), '-pixel_format', 'bgr0', '-capture_cursor', '1', '-i', `${screen[1]}:none`];
}

// --- portable streaming (non-Windows) --------------------------------------

// Timed loop of single captures until stopped. The FIRST capture is treated as
// readiness: if it fails, the stream errors and exits immediately so the
// recorder reports a real startup failure instead of an endless empty session.
// Later transient failures are counted but do not kill the stream.
export function startStreamPortable({ region, title, windowId, rect, target, intervalMs }, onFrame, deps) {
  const grab = deps.grabPng;
  const clock = deps.clock;
  let stopped = false;
  let exited = false;
  let timer = null;
  let count = 0;
  let firstError = null;
  let transientErrors = 0;
  const abort = new AbortController();
  const start = clock.now();

  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const finish = () => { if (!exited) { exited = true; resolveClosed(); } };

  const tick = async () => {
    if (stopped) return;
    try {
      const captureTime = clock.now();
      const png = await grab({ region, title, windowId, rect, target, signal: abort.signal });
      if (stopped) return;
      count++;
      if (onFrame) onFrame({ png, timeMs: Math.round(captureTime - start), target, timingSource: 'capture-start' }, count);
    } catch (err) {
      if (stopped) return;
      if (count === 0) {
        // First frame failed → fatal startup/target error.
        firstError = err;
        finish();
        return;
      }
      transientErrors++;
    }
    if (!stopped) {
      const nextSlot = Math.floor((clock.now() - start) / intervalMs) + 1;
      timer = clock.setTimeout(tick, Math.max(0, start + nextSlot * intervalMs - clock.now()));
    }
  };
  timer = clock.setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      abort.abort();
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
  const target = opts.target || await resolveTarget(opts);
  const configured = { ...opts, ...target, target };
  switch (process.platform) {
    case 'win32': return grabWindows(configured);
    case 'linux': return grabLinux(configured);
    case 'darwin': return grabDarwin(configured);
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// Capture a single frame and return a decoded RGBA image: { width, height, data }.
// Thin wrapper over grabPng for the single-shot `capture` tool.
export async function captureImage(opts = {}) {
  const target = await resolveTarget(opts);
  const image = decodePng(await grabPng({ ...opts, target }));
  if (!target.bounds) target.bounds = { x: target.rect?.x || 0, y: target.rect?.y || 0, width: image.width, height: image.height };
  return { image, target, backend: process.platform === 'linux' && target.region === 'window' ? 'linux:ffmpeg' : await detectBackend() };
}

export async function captureFrame(opts = {}) { return (await captureImage(opts)).image; }

// The default capture backend used by the session controller. Streams raw PNG
// frames. On Windows a single PowerShell process does the whole stream (so the
// frame rate is real); X11/macOS use FFmpeg when available. Other backends
// keep a deadline-scheduled fallback loop and report that limitation.
//
// startStream({ region, title, intervalMs }, onFrame) -> handle where
//   onFrame({ png, timeMs }, count) fires per frame,
//   handle = { stop(): Promise<void>, get exited, get framesSeen, get error }.
export function createDefaultBackend(clock) {
  return {
    name: 'default',
    startStream(opts, onFrame) {
      return deferredStream(async () => {
        const target = await resolveTarget(opts);
        const configured = { ...opts, ...target, target };
        if (process.platform === 'win32') {
          return Object.assign(startStreamWindows(configured, onFrame), { target, backend: 'windows:System.Drawing', timingSource: 'capture-clock' });
        }
        if (process.platform === 'linux' && !process.env.WAYLAND_DISPLAY && await which('ffmpeg') && await which('xdotool')) {
          return startFfmpegStream(await x11Input(target, 1000 / opts.intervalMs), onFrame, { target, backend: 'linux:ffmpeg-stream' });
        }
        if (process.platform === 'darwin' && await which('ffmpeg')) {
          const input = await macStreamInput(target, 1000 / opts.intervalMs);
          return startFfmpegStream(input, onFrame, { target, backend: 'darwin:ffmpeg-stream',
            cropFilter: target.rect ? `crop=${target.rect.w}:${target.rect.h}:${target.rect.x}:${target.rect.y}` : null });
        }
        return Object.assign(startStreamPortable(configured, onFrame, { grabPng, clock }), { target, backend: await detectBackend(), timingSource: 'capture-start', warnings: ['Single-frame fallback backend: brief events may be missed; install FFmpeg for continuous X11/macOS capture.'] });
      });
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
    const [ffmpeg, xdotool, xwininfo] = await Promise.all([which('ffmpeg'), which('xdotool'), which('xwininfo')]);
    windowCapture = !process.env.WAYLAND_DISPLAY && !!(ffmpeg && xdotool && xwininfo);
  } else if (process.platform === 'darwin') {
    windowCapture = false; // display-only via screencapture
  }
  return {
    platform: process.platform,
    backend,
    regions: process.platform === 'darwin' ? ['primary']
      : process.platform === 'linux' && process.env.WAYLAND_DISPLAY ? ['virtual']
      : windowCapture ? ['primary', 'virtual', 'window'] : ['primary', 'virtual'],
    windowCapture,
    continuousCapture: process.platform === 'win32' || (process.platform === 'darwin' && !!(await which('ffmpeg')))
      || (process.platform === 'linux' && !process.env.WAYLAND_DISPLAY && !!(await which('ffmpeg')) && !!(await which('xdotool'))),
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
    if (await which('import')) return 'linux:import';
    if (await which('scrot')) return 'linux:scrot';
    if (await which('ffmpeg')) return 'linux:ffmpeg';
    return 'linux:none';
  }
  return 'unknown';
}

export { pngDimensions };
