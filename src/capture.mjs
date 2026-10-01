// Screen capture backends. Each backend shells out to a tool already present
// on the host (PowerShell on Windows; scrot / ImageMagick / grim / ffmpeg on
// Linux) and returns a decoded RGBA image. No npm dependency is involved.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { decodePng } from './png.mjs';

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

// --- Windows backend (PowerShell + System.Drawing) -------------------------

// PowerShell script that captures a region and writes PNG bytes to stdout as
// base64 (keeps the binary pipe clean across the PS host boundary).
function windowsCaptureScript(region, title) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Get-TargetBounds {
  param($region, $title)
  if ($region -eq 'virtual') {
    return [System.Windows.Forms.SystemInformation]::VirtualScreen
  }
  if ($region -eq 'window') {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -eq $proc) { throw "No window matching '$title'" }
    $rect = New-Object RECT
    [void][Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
    return New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
  }
  return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

$bounds = Get-TargetBounds -region '${region}' -title '${(title || '').replace(/'/g, "''")}'
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
}

async function captureWindows({ region, title }) {
  const script = windowsCaptureScript(region, title);
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  const png = Buffer.from(stdout.trim(), 'base64');
  return decodePng(png);
}

// Burst capture: grab `frames` frames at `intervalMs` spacing inside a SINGLE
// PowerShell process. Spawning PowerShell costs ~2s, so a per-frame spawn can
// never hit a real frame rate; computing bounds once and looping with a
// stopwatch does. Each frame is streamed to stdout as one line:
//   "FRAME <elapsedMs> <base64Png>"
// which this function parses incrementally. Returns [{ image, timeMs }].
function windowsBurstScript(region, title, frames, intervalMs) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Get-TargetBounds {
  param($region, $title)
  if ($region -eq 'virtual') {
    return [System.Windows.Forms.SystemInformation]::VirtualScreen
  }
  if ($region -eq 'window') {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32Burst {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -eq $proc) { throw "No window matching '$title'" }
    $rect = New-Object RECT
    [void][Win32Burst]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
    return New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
  }
  return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

$bounds = Get-TargetBounds -region '${region}' -title '${(title || '').replace(/'/g, "''")}'
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$stdout = [Console]::Out
$sw = [System.Diagnostics.Stopwatch]::StartNew()

for ($i = 0; $i -lt ${frames}; $i++) {
  $target = $i * ${intervalMs}
  $wait = $target - $sw.Elapsed.TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }

  $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $elapsed = [int]$sw.Elapsed.TotalMilliseconds
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $stdout.WriteLine("FRAME $elapsed " + [Convert]::ToBase64String($ms.ToArray()))
  $ms.Dispose()
}

$gfx.Dispose(); $bmp.Dispose()
`;
}

function captureBurstWindows({ region, title, frames, intervalMs }, onFrame) {
  return new Promise((resolve, reject) => {
    const script = windowsBurstScript(region, title, frames, intervalMs);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );

    const collected = [];
    let buffer = '';
    const errChunks = [];

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
        const b64 = line.slice(sp + 1);
        const image = decodePng(Buffer.from(b64, 'base64'));
        const frame = { image, timeMs };
        collected.push(frame);
        if (onFrame) onFrame(frame, collected.length);
      }
    });
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`powershell burst exited ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
        return;
      }
      resolve(collected);
    });
  });
}

async function listWindowsWindows() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@
$procs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 }
$list = foreach ($p in $procs) {
  $rect = New-Object RECT
  [void][Win32]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
  [PSCustomObject]@{
    title  = $p.MainWindowTitle
    process = $p.ProcessName
    x = $rect.Left; y = $rect.Top
    width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top)
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

async function captureLinux({ region, title }) {
  const isWayland = !!process.env.WAYLAND_DISPLAY;

  if (region === 'window' && (await which('ffmpeg'))) {
    // Window capture via ffmpeg x11grab is backend-dependent; attempt a
    // best-effort grab of the focused window geometry when xdotool exists.
    const xdotool = await which('xdotool');
    if (xdotool) {
      const { stdout } = await execFileAsync('xdotool', [
        'search', '--name', title || '', 'getwindowgeometry', '--shell',
      ]).catch(() => ({ stdout: '' }));
      const geo = Object.fromEntries(
        stdout.split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length === 2)
      );
      if (geo.WIDTH && geo.HEIGHT) {
        const png = await runCapture('ffmpeg', [
          '-y', '-f', 'x11grab',
          '-video_size', `${geo.WIDTH}x${geo.HEIGHT}`,
          '-i', `${process.env.DISPLAY || ':0'}+${geo.X || 0},${geo.Y || 0}`,
          '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1',
        ]);
        return decodePng(png);
      }
    }
  }

  if (isWayland && (await which('grim'))) {
    const png = await runCapture('grim', ['-']);
    return decodePng(png);
  }
  if (await which('scrot')) {
    const png = await runCapture('scrot', ['-o', '/dev/stdout']);
    return decodePng(png);
  }
  if (await which('import')) {
    const png = await runCapture('import', ['-window', 'root', 'png:-']);
    return decodePng(png);
  }
  if (await which('ffmpeg')) {
    const png = await runCapture('ffmpeg', [
      '-y', '-f', 'x11grab', '-i', process.env.DISPLAY || ':0',
      '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1',
    ]);
    return decodePng(png);
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

// --- public API ------------------------------------------------------------

// Capture a single frame. opts: { region: 'primary'|'virtual'|'window', title }
export async function captureFrame(opts = {}) {
  const region = opts.region || 'primary';
  const title = opts.title;
  switch (process.platform) {
    case 'win32':
      return captureWindows({ region, title });
    case 'linux':
      return captureLinux({ region, title });
    case 'darwin':
      // Best effort via screencapture if present, else ffmpeg avfoundation.
      if (await which('screencapture')) {
        const tmp = `${os.tmpdir()}/marey-${process.pid}-${Date.now()}.png`;
        await execFileAsync('screencapture', ['-x', '-t', 'png', tmp]);
        const { readFile, unlink } = await import('node:fs/promises');
        const buf = await readFile(tmp);
        await unlink(tmp).catch(() => {});
        return decodePng(buf);
      }
      throw new Error('macOS capture requires the `screencapture` tool');
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// Capture a burst of frames at a target frame rate.
//
// opts: { region, title, frames, intervalMs }
// onFrame(frame, count): optional callback invoked as each frame arrives.
//
// Returns [{ image, timeMs }] where timeMs is measured from the start of the
// burst. On Windows this runs inside a single PowerShell process so the frame
// rate is real; elsewhere it falls back to a timed per-frame capture loop.
export async function captureBurst(opts = {}, onFrame) {
  const region = opts.region || 'primary';
  const title = opts.title;
  const frames = Math.max(1, Math.round(opts.frames || 1));
  const intervalMs = Math.max(0, opts.intervalMs || 0);

  if (process.platform === 'win32') {
    return captureBurstWindows({ region, title, frames, intervalMs }, onFrame);
  }

  // Portable fallback: timed loop of single captures.
  const collected = [];
  const start = Date.now();
  for (let i = 0; i < frames; i++) {
    const target = start + i * intervalMs;
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const image = await captureFrame({ region, title });
    const frame = { image, timeMs: Date.now() - start };
    collected.push(frame);
    if (onFrame) onFrame(frame, collected.length);
  }
  return collected;
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

// Report which backend will be used, for diagnostics.
export async function detectBackend() {
  if (process.platform === 'win32') return 'windows:System.Drawing';
  if (process.platform === 'darwin') return 'darwin:screencapture';
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY && (await which('grim'))) return 'linux:grim';
    if (await which('scrot')) return 'linux:scrot';
    if (await which('import')) return 'linux:import';
    if (await which('ffmpeg')) return 'linux:ffmpeg';
    return 'linux:none';
  }
  return 'unknown';
}
