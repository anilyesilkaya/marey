// Tests for Marey's pure-JS core: PNG codec round-trip, resize, font metrics,
// and contact-sheet composition. These run without any screen capture, so
// they verify the dependency-free image pipeline in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePng, decodePng } from '../src/png.mjs';
import { createImage, resize, blit, fillRect, drawText } from '../src/image.mjs';
import { measureText } from '../src/font.mjs';
import { composeContactSheet } from '../src/contactsheet.mjs';

function makeGradient(w, h) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      img.data[p] = (x * 255 / w) | 0;
      img.data[p + 1] = (y * 255 / h) | 0;
      img.data[p + 2] = ((x + y) * 255 / (w + h)) | 0;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

test('PNG encode/decode round-trips RGBA pixels exactly', () => {
  const w = 37, h = 19; // deliberately non-power-of-two
  const src = makeGradient(w, h);
  const png = encodePng(w, h, src.data);
  const decoded = decodePng(png);

  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.ok(decoded.data.equals(src.data), 'decoded pixels should match source');
});

test('PNG has a valid signature', () => {
  const img = makeGradient(4, 4);
  const png = encodePng(4, 4, img.data);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('all five scanline filters round-trip', () => {
  // A noisy image exercises adaptive filter selection across many rows.
  const w = 64, h = 64;
  const img = createImage(w, h);
  let seed = 12345;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
  }
  const decoded = decodePng(encodePng(w, h, img.data));
  assert.ok(decoded.data.equals(img.data));
});

test('resize produces exact target dimensions', () => {
  const src = makeGradient(100, 50);
  const out = resize(src, 20, 10);
  assert.equal(out.width, 20);
  assert.equal(out.height, 10);
  assert.equal(out.data.length, 20 * 10 * 4);
});

test('resize of a solid color preserves that color', () => {
  const src = createImage(40, 40, [10, 120, 200, 255]);
  const out = resize(src, 7, 13);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i], 10);
    assert.equal(out.data[i + 1], 120);
    assert.equal(out.data[i + 2], 200);
  }
});

test('blit copies a region without touching clipped pixels', () => {
  const dst = createImage(10, 10, [0, 0, 0, 255]);
  const src = createImage(4, 4, [255, 0, 0, 255]);
  blit(dst, src, 8, 8); // partially off the right/bottom edge
  // Pixel (9,9) should be red; (0,0) should remain black.
  const at = (x, y) => dst.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 3);
  assert.deepEqual([...at(9, 9)], [255, 0, 0]);
  assert.deepEqual([...at(0, 0)], [0, 0, 0]);
});

test('fillRect with alpha blends toward the fill color', () => {
  const img = createImage(4, 4, [0, 0, 0, 255]);
  fillRect(img, 0, 0, 4, 4, [255, 255, 255, 128]);
  // ~50% blend of white over black.
  assert.ok(img.data[0] > 100 && img.data[0] < 160);
});

test('drawText reports a positive advance and marks pixels', () => {
  const img = createImage(200, 20, [0, 0, 0, 255]);
  const advance = drawText(img, 'FRAME #001', 2, 2, 2, [255, 255, 255]);
  assert.ok(advance > 0);
  assert.equal(advance, measureText('FRAME #001', 2));
  const lit = [...img.data].some((v, i) => i % 4 !== 3 && v > 0);
  assert.ok(lit, 'some text pixels should be non-black');
});

test('composeContactSheet lays out a grid with captions', () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({
    image: makeGradient(160, 90),
    index: i + 1,
    timeMs: i * 500,
  }));
  const sheet = composeContactSheet(frames, { cols: 3, thumbWidth: 120 });

  // 3 columns, 2 rows of 120px-wide thumbs → predictable minimum size.
  assert.ok(sheet.width >= 3 * 120);
  assert.ok(sheet.height > 0);
  // Sheet must survive an encode/decode round-trip.
  const decoded = decodePng(encodePng(sheet.width, sheet.height, sheet.data));
  assert.equal(decoded.width, sheet.width);
});

test('composeContactSheet rejects an empty frame list', () => {
  assert.throws(() => composeContactSheet([], {}), /zero frames/);
});
