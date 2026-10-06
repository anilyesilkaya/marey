// Tests for Marey's pure-JS core: PNG codec round-trip, resize, font metrics,
// and contact-sheet composition. These run without any screen capture, so
// they verify the dependency-free image pipeline in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodePng, decodePng } from '../src/png.mjs';
import { createImage, resize, blit, fillRect, drawText, crop, grayscaleSignature, signatureDiff } from '../src/image.mjs';
import { measureText } from '../src/font.mjs';
import { composeContactSheet, composeWithinBudget, sheetDimensions } from '../src/contactsheet.mjs';
import { selectByChange, evenSample } from '../src/session.mjs';
import { getFrame } from '../src/recorder.mjs';

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

test('getFrame returns full-resolution bytes by dir + index and by path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-test-'));
  try {
    // Lay out a recording-like directory with two distinct frames.
    const f1 = makeGradient(120, 80);
    const f2 = makeGradient(64, 48);
    const p1 = path.join(dir, 'frame_001_00000ms.png');
    const p2 = path.join(dir, 'frame_002_00500ms.png');
    await writeFile(p1, encodePng(f1.width, f1.height, f1.data));
    await writeFile(p2, encodePng(f2.width, f2.height, f2.data));

    // By dir + index: dimensions match the on-disk frame, not a thumbnail.
    const byIndex = await getFrame({ dir, index: 2 });
    assert.equal(byIndex.width, 64);
    assert.equal(byIndex.height, 48);
    assert.equal(byIndex.path, p2);
    // Returned bytes decode back to the original pixels.
    assert.ok(decodePng(byIndex.buffer).data.equals(f2.data));

    // By direct path.
    const byPath = await getFrame({ path: p1 });
    assert.equal(byPath.width, 120);
    assert.equal(byPath.height, 80);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getFrame reports a helpful error for a missing frame index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-test-'));
  try {
    const f = makeGradient(32, 32);
    await writeFile(path.join(dir, 'frame_001_00000ms.png'), encodePng(f.width, f.height, f.data));
    await assert.rejects(() => getFrame({ dir, index: 9 }), /No frame #9.*1 frames/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getFrame requires dir+index or path', async () => {
  await assert.rejects(() => getFrame({}), /requires either .path., or .dir./);
});

// --- Phase 3: progressive inspection (crop) --------------------------------

test('crop extracts an exact sub-rectangle at full resolution', () => {
  // A 4×4 image where each pixel's red channel encodes y*4+x, so a crop's
  // contents are unambiguous.
  const img = createImage(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      img.data[(y * 4 + x) * 4] = y * 4 + x;
    }
  }
  const c = crop(img, 1, 1, 2, 2);
  assert.equal(c.width, 2);
  assert.equal(c.height, 2);
  // Expect pixels (1,1)=5 (2,1)=6 (1,2)=9 (2,2)=10.
  assert.deepEqual([c.data[0], c.data[4], c.data[8], c.data[12]], [5, 6, 9, 10]);
});

test('crop clips an out-of-bounds rectangle to the frame', () => {
  const img = createImage(10, 10);
  const c = crop(img, 8, 8, 100, 100); // runs past the edge
  assert.equal(c.width, 2);  // only 2px remain from x=8
  assert.equal(c.height, 2);
});

test('getFrame returns a normalized crop at full resolution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-test-'));
  try {
    const f = makeGradient(200, 100);
    await writeFile(path.join(dir, 'frame_001_00000ms.png'), encodePng(f.width, f.height, f.data));

    // Top-right quadrant via normalized fractions.
    const r = await getFrame({ dir, index: 1, crop: { normalized: true, x: 0.5, y: 0, w: 0.5, h: 0.5 } });
    assert.equal(r.width, 100);
    assert.equal(r.height, 50);
    assert.deepEqual(r.source, { width: 200, height: 100 });
    assert.equal(r.crop.x, 100);
    assert.equal(r.crop.y, 0);
    // The returned bytes are a valid PNG of the cropped size.
    assert.equal(decodePng(r.buffer).width, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getFrame with a pixel crop clips to the frame and reports the rect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-test-'));
  try {
    const f = makeGradient(120, 80);
    await writeFile(path.join(dir, 'frame_001_00000ms.png'), encodePng(f.width, f.height, f.data));
    const r = await getFrame({ dir, index: 1, crop: { x: 100, y: 60, w: 999, h: 999 } });
    assert.equal(r.width, 20);  // 120 - 100
    assert.equal(r.height, 20); // 80 - 60
    assert.equal(r.crop.w, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getFrame without a crop returns the original bytes untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marey-test-'));
  try {
    const f = makeGradient(64, 48);
    const bytes = encodePng(f.width, f.height, f.data);
    await writeFile(path.join(dir, 'frame_001_00000ms.png'), bytes);
    const r = await getFrame({ dir, index: 1 });
    assert.ok(r.buffer.equals(bytes), 'uncropped fetch is byte-identical');
    assert.equal(r.crop, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Phase 3: content-aware frame selection --------------------------------

test('selectByChange keeps first + last and the highest-change interior frames', () => {
  // 6 frames; frames 2 and 4 (0-based) differ sharply from their predecessor,
  // the rest are near-static. Signatures are 1-pixel grayscale for clarity.
  const entries = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, timeMs: i * 100 }));
  const sigs = [
    Uint8Array.of(0),
    Uint8Array.of(1),   // tiny change
    Uint8Array.of(200), // big change (frame idx 2)
    Uint8Array.of(201), // tiny change
    Uint8Array.of(10),  // big change (frame idx 4)
    Uint8Array.of(11),  // tiny change
  ];
  const picked = selectByChange(entries, sigs, 4);
  const idxs = picked.map((e) => e.index);
  // First (1) and last (6) always kept; the two biggest changes are #3 and #5.
  assert.deepEqual(idxs, [1, 3, 5, 6]);
  // Temporal order preserved.
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
});

test('selectByChange falls back to even sampling when nothing changes', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, timeMs: i }));
  const sigs = entries.map(() => Uint8Array.of(128)); // identical → zero change
  const picked = selectByChange(entries, sigs, 4);
  assert.deepEqual(picked, evenSample(entries, 4));
  assert.equal(picked[0].index, 1);
  assert.equal(picked[picked.length - 1].index, 10);
});

test('grayscaleSignature + signatureDiff detect change and ignore identity', () => {
  const black = createImage(40, 30, [0, 0, 0, 255]);
  const white = createImage(40, 30, [255, 255, 255, 255]);
  const sBlack = grayscaleSignature(black);
  const sWhite = grayscaleSignature(white);
  assert.equal(signatureDiff(sBlack, sBlack), 0);
  assert.ok(signatureDiff(sBlack, sWhite) > 200, 'black→white is a large diff');
});

// --- Phase 3: output budget -------------------------------------------------

test('composeWithinBudget shrinks thumbnails to fit a byte budget', () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({
    image: makeGradient(160, 90), index: i + 1, timeMs: i * 100,
  }));
  // Fake encoder: byte size scales with pixel count, so the fit loop is
  // deterministic regardless of PNG entropy.
  const encode = (img) => ({ length: img.width * img.height });
  const big = composeWithinBudget(frames, { cols: 3, thumbWidth: 480, encode, maxBytes: Infinity });
  const fitted = composeWithinBudget(frames, { cols: 3, thumbWidth: 480, encode, maxBytes: big.buffer.length / 4 });
  assert.ok(fitted.thumbWidth < big.thumbWidth, 'thumbnails were shrunk');
  assert.ok(fitted.buffer.length <= big.buffer.length / 4, 'now within the byte budget');
  assert.equal(fitted.frameCount, 6, 'all frames still shown (shrink before drop)');
  assert.match(fitted.warning, /scaled/);
});

test('composeWithinBudget drops frames once thumbnails hit the floor', () => {
  const frames = Array.from({ length: 12 }, (_, i) => ({
    image: makeGradient(160, 90), index: i + 1, timeMs: i * 100,
  }));
  const encode = (img) => ({ length: img.width * img.height });
  // A byte budget so small that even floor-size thumbnails for 12 frames exceed
  // it, forcing frame drops.
  const fitted = composeWithinBudget(frames, {
    cols: 4, thumbWidth: 480, minThumbWidth: 96, encode, maxBytes: 120_000,
  });
  assert.ok(fitted.frameCount < 12, 'frames were dropped to fit');
  assert.ok(fitted.frameCount >= 2, 'first + last always kept');
  assert.equal(fitted.thumbWidth, 96, 'thumbnails at the floor before dropping');
  assert.ok(fitted.buffer.length <= 120_000, 'within the byte budget');
  assert.match(fitted.warning, /remain on disk/);
});

test('composeWithinBudget respects the pixel budget via exact layout math', () => {
  const frames = Array.from({ length: 4 }, (_, i) => ({
    image: makeGradient(160, 90), index: i + 1, timeMs: i,
  }));
  const encode = (img) => ({ length: 1 }); // bytes never bind; isolate pixels
  const maxPixels = 300_000;
  const fitted = composeWithinBudget(frames, { cols: 2, thumbWidth: 480, encode, maxPixels });
  const dims = sheetDimensions({
    count: fitted.frameCount, cols: fitted.cols, thumbWidth: fitted.thumbWidth,
    aspect: 90 / 160,
  });
  assert.ok(dims.width * dims.height <= maxPixels, 'composed sheet within the pixel budget');
});
