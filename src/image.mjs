// Pure-JS image buffer operations: a mutable RGBA canvas, box-filter
// downsampling for thumbnails, blitting, solid fills, and text drawing using
// the bundled bitmap font. No image-library dependency.

import { GLYPH_WIDTH, GLYPH_HEIGHT, measureText, glyphFor } from './font.mjs';

// A simple RGBA image: { width, height, data } where data is a Buffer with
// 4 bytes per pixel.
export function createImage(width, height, fill = [0, 0, 0, 255]) {
  const data = Buffer.allocUnsafe(width * height * 4);
  const [r, g, b, a] = fill;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width, height, data };
}

// Box-filter downscale/upscale to an exact target size. Averages the source
// pixels covered by each destination pixel — cheap and good enough for
// thumbnails, with no dependency on a resampling library.
export function resize(img, targetWidth, targetHeight) {
  const { width: sw, height: sh, data: src } = img;
  const dst = Buffer.allocUnsafe(targetWidth * targetHeight * 4);
  const xRatio = sw / targetWidth;
  const yRatio = sh / targetHeight;

  for (let dy = 0; dy < targetHeight; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio)));
    for (let dx = 0; dx < targetWidth; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let sp = (sy * sw + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[sp]; g += src[sp + 1]; b += src[sp + 2]; a += src[sp + 3];
          sp += 4;
          count++;
        }
      }
      const dp = (dy * targetWidth + dx) * 4;
      dst[dp] = (r / count) | 0;
      dst[dp + 1] = (g / count) | 0;
      dst[dp + 2] = (b / count) | 0;
      dst[dp + 3] = (a / count) | 0;
    }
  }

  return { width: targetWidth, height: targetHeight, data: dst };
}

// Extract a sub-rectangle at full resolution. Clips the rectangle to the source
// bounds (never reads out of range) and copies each row in one shot, since a
// crop row is contiguous in the source buffer. Returns a fresh RGBA image.
export function crop(img, x, y, w, h) {
  const { width: sw, height: sh, data: src } = img;
  const cx = Math.max(0, Math.min(x | 0, sw - 1));
  const cy = Math.max(0, Math.min(y | 0, sh - 1));
  const cw = Math.max(1, Math.min(w | 0, sw - cx));
  const ch = Math.max(1, Math.min(h | 0, sh - cy));
  const out = Buffer.allocUnsafe(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((cy + row) * sw + cx) * 4;
    src.copy(out, row * cw * 4, srcStart, srcStart + cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

// Downscale to a tiny grayscale signature for cheap frame-to-frame change
// detection. Returns a Uint8Array of length sigW*sigH (row-major Rec.601 luma,
// 0..255). Aspect is preserved so motion is weighted uniformly across the frame.
export function grayscaleSignature(img, sigW = 32) {
  const sigH = Math.max(1, Math.round(sigW * (img.height / img.width)));
  const small = resize(img, sigW, sigH);
  const out = new Uint8Array(sigW * sigH);
  const { data } = small;
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return out;
}

// Mean absolute per-pixel difference between two equal-length signatures (0..255).
// 0 = identical; larger = more visual change. Mismatched lengths score 0.
export function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Copy `src` onto `dst` at (ox, oy). Source is drawn opaque (no alpha blend);
// pixels outside the destination are clipped.
export function blit(dst, src, ox, oy) {
  const { width: sw, height: sh, data: sData } = src;
  const { width: dw, height: dh, data: dData } = dst;
  for (let y = 0; y < sh; y++) {
    const dyr = oy + y;
    if (dyr < 0 || dyr >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const dxr = ox + x;
      if (dxr < 0 || dxr >= dw) continue;
      const sp = (y * sw + x) * 4;
      const dp = (dyr * dw + dxr) * 4;
      dData[dp] = sData[sp];
      dData[dp + 1] = sData[sp + 1];
      dData[dp + 2] = sData[sp + 2];
      dData[dp + 3] = sData[sp + 3];
    }
  }
}

// Fill a rectangle with a solid (optionally translucent) color.
export function fillRect(img, x, y, w, h, color) {
  const { width: iw, height: ih, data } = img;
  const [r, g, b, a = 255] = color;
  const alpha = a / 255;
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= ih) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= iw) continue;
      const p = (yy * iw + xx) * 4;
      if (a >= 255) {
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      } else {
        data[p] = (r * alpha + data[p] * (1 - alpha)) | 0;
        data[p + 1] = (g * alpha + data[p + 1] * (1 - alpha)) | 0;
        data[p + 2] = (b * alpha + data[p + 2] * (1 - alpha)) | 0;
        data[p + 3] = 255;
      }
    }
  }
}

// Draw a single character at (x, y) using the bitmap font at integer `scale`.
function drawChar(img, ch, x, y, scale, color) {
  const matrix = glyphFor(ch);
  const [r, g, b] = color;
  const { width: iw, height: ih, data } = img;
  for (let row = 0; row < GLYPH_HEIGHT; row++) {
    const bits = matrix[row];
    for (let col = 0; col < GLYPH_WIDTH; col++) {
      if (!(bits & (1 << (GLYPH_WIDTH - 1 - col)))) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = x + col * scale + sx;
          const py = y + row * scale + sy;
          if (px < 0 || px >= iw || py < 0 || py >= ih) continue;
          const p = (py * iw + px) * 4;
          data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
        }
      }
    }
  }
}

// Draw a text string. Returns the width consumed.
export function drawText(img, text, x, y, scale, color) {
  let cx = x;
  const glyph = GLYPH_WIDTH * scale;
  const gap = scale;
  for (const ch of text) {
    drawChar(img, ch, cx, y, scale, color);
    cx += glyph + gap;
  }
  return cx - x - gap;
}

export { measureText, GLYPH_HEIGHT, GLYPH_WIDTH };
