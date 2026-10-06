// Compose a sequence of frames into a single labeled contact sheet.
// Pure JS: lays out thumbnails in a grid, draws a caption bar on each with the
// frame number and timestamp, and returns an RGBA image ready to encode.

import { createImage, resize, blit, fillRect, drawText, measureText, GLYPH_HEIGHT } from './image.mjs';

const BG = [24, 24, 27, 255];          // near-black backdrop
const CAPTION_BG = [0, 0, 0, 180];     // translucent label strip
const CAPTION_FG = [240, 240, 245];    // light text
const GUTTER = 8;                      // spacing between thumbnails
const PADDING = 16;                    // outer margin
const LABEL_SCALE = 2;

// Caption strip height, exported so callers can estimate sheet dimensions
// (and thus the output-pixel budget) without composing first.
export const CAPTION_HEIGHT = GLYPH_HEIGHT * LABEL_SCALE + 8;

// Predict the composed sheet's pixel dimensions for a given layout, matching
// composeContactSheet's math exactly. `aspect` is thumbHeight/thumbWidth.
export function sheetDimensions({ count, cols, thumbWidth, aspect }) {
  const c = Math.max(1, cols);
  const tw = Math.max(64, thumbWidth);
  const thumbHeight = Math.round(tw * aspect);
  const cellHeight = thumbHeight + CAPTION_HEIGHT;
  const rows = Math.ceil(count / c);
  return {
    width: PADDING * 2 + c * tw + (c - 1) * GUTTER,
    height: PADDING * 2 + rows * cellHeight + (rows - 1) * GUTTER,
  };
}

// frames: [{ image, index, timeMs }]
// opts: { cols, thumbWidth }
export function composeContactSheet(frames, opts = {}) {
  if (frames.length === 0) {
    throw new Error('Cannot compose a contact sheet from zero frames');
  }

  const cols = Math.max(1, opts.cols || 4);
  const thumbWidth = Math.max(64, opts.thumbWidth || 480);

  // Derive thumbnail height from the first frame's aspect ratio so every cell
  // is uniform (frames from one recording share dimensions).
  const first = frames[0].image;
  const aspect = first.height / first.width;
  const thumbHeight = Math.round(thumbWidth * aspect);

  const captionHeight = CAPTION_HEIGHT;
  const cellWidth = thumbWidth;
  const cellHeight = thumbHeight + captionHeight;

  const rows = Math.ceil(frames.length / cols);
  const sheetWidth = PADDING * 2 + cols * cellWidth + (cols - 1) * GUTTER;
  const sheetHeight = PADDING * 2 + rows * cellHeight + (rows - 1) * GUTTER;

  const sheet = createImage(sheetWidth, sheetHeight, BG);

  frames.forEach((frame, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PADDING + col * (cellWidth + GUTTER);
    const y = PADDING + row * (cellHeight + GUTTER);

    const thumb = resize(frame.image, thumbWidth, thumbHeight);
    blit(sheet, thumb, x, y);

    // Caption strip across the bottom of the thumbnail.
    const capY = y + thumbHeight - captionHeight;
    fillRect(sheet, x, capY, thumbWidth, captionHeight, CAPTION_BG);

    const label = `${formatIndex(frame.index)}  ${formatTime(frame.timeMs)}`;
    const textY = capY + 4;
    drawText(sheet, label, x + 6, textY, LABEL_SCALE, CAPTION_FG);
  });

  return sheet;
}

// Compose a contact sheet that fits within an output budget, degrading the
// layout until it does. A returned image has a hard size ceiling in most MCP
// clients (they drop or refuse an oversized inline image), so an unbounded
// sheet is worse than useless — the agent sees nothing. We bound two things:
//
//   - output PIXELS (maxPixels): guards memory/encode cost up front; and
//   - encoded BYTES (maxBytes): the real transport limit, measured by actually
//     encoding (PNG size depends on content, so a pixel estimate is not enough).
//
// Degradation order, cheapest-information-loss first:
//   1. shrink thumbWidth (every cell smaller, all frames kept) until a floor;
//   2. then drop frames (subsample, keeping first + last and temporal order),
//      which is what actually reduces bytes once thumbnails hit the floor.
//
// `encode(image) -> Buffer|{length}` is injected so the fit loop is pure and
// deterministically testable without the real PNG entropy. Returns
// { image, buffer, cols, thumbWidth, frameCount, droppedForBudget, warning }.
export function composeWithinBudget(frames, opts = {}) {
  if (frames.length === 0) {
    throw new Error('Cannot compose a contact sheet from zero frames');
  }
  const encode = opts.encode || ((img) => encodePngFallback(img));
  const maxPixels = opts.maxPixels || Infinity;
  const maxBytes = opts.maxBytes || Infinity;
  const minThumbWidth = Math.max(64, opts.minThumbWidth || 96);
  const cols = Math.max(1, opts.cols || 4);

  const first = frames[0].image;
  const aspect = first.height / first.width;

  // Current candidate layout, narrowed on each loop.
  let selected = frames;
  let thumbWidth = Math.max(minThumbWidth, opts.thumbWidth || 480);
  let shrankThumb = false;
  let droppedForBudget = 0;

  // Shrink thumbWidth until the PIXEL budget is satisfied (bytes are checked
  // after a real encode below). Pixel math is exact via sheetDimensions.
  const overPixels = (tw, count) => {
    const d = sheetDimensions({ count, cols, thumbWidth: tw, aspect });
    return d.width * d.height > maxPixels;
  };
  while (thumbWidth > minThumbWidth && overPixels(thumbWidth, selected.length)) {
    thumbWidth = Math.max(minThumbWidth, Math.round(thumbWidth * 0.85));
    shrankThumb = true;
  }
  // If even the smallest thumbnails blow the pixel budget, drop frames to fit.
  while (selected.length > 2 && overPixels(minThumbWidth, selected.length)) {
    selected = subsampleKeepingEnds(selected, selected.length - 1);
    thumbWidth = minThumbWidth;
    droppedForBudget++;
  }

  // Now satisfy the BYTE budget, which only a real encode can measure. Shrink
  // thumbWidth first; once at the floor, drop frames. Bounded iterations.
  let image = composeContactSheet(selected, { cols, thumbWidth });
  let buffer = encode(image);
  let guard = 0;
  while (buffer.length > maxBytes && guard++ < 64) {
    if (thumbWidth > minThumbWidth) {
      thumbWidth = Math.max(minThumbWidth, Math.round(thumbWidth * 0.85));
      shrankThumb = true;
    } else if (selected.length > 2) {
      selected = subsampleKeepingEnds(selected, selected.length - 1);
      droppedForBudget++;
    } else {
      break; // 2 frames at the floor: nothing more to give.
    }
    image = composeContactSheet(selected, { cols, thumbWidth });
    buffer = encode(image);
  }

  let warning = null;
  if (droppedForBudget > 0) {
    warning =
      `Contact sheet reduced to ${selected.length} of ${frames.length} selected ` +
      `frames to fit the output budget; all frames remain on disk (use get_frame).`;
  } else if (shrankThumb) {
    warning = `Contact sheet thumbnails scaled to ${thumbWidth}px to fit the output budget.`;
  }

  return {
    image, buffer, cols, thumbWidth,
    frameCount: selected.length,
    selected,
    droppedForBudget,
    warning,
  };
}

// Subsample `arr` down to `count` items, always keeping the first and last and
// preserving order. Used to shed frames when a sheet will not fit the budget.
function subsampleKeepingEnds(arr, count) {
  if (arr.length <= count || count < 2) return arr.slice();
  const out = [];
  const step = (arr.length - 1) / (count - 1);
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) { seen.add(idx); out.push(arr[idx]); }
  }
  return out;
}

// The byte budget can only be enforced by measuring a real encode, so the
// encoder is injected (keeping this module free of a png.mjs import and the fit
// loop pure/testable). Real callers always pass `encode`; this guards misuse.
function encodePngFallback() {
  throw new Error('composeWithinBudget requires an injected `encode` function');
}

function formatIndex(index) {
  return `#${String(index).padStart(3, '0')}`;
}

function formatTime(ms) {
  const s = (ms / 1000).toFixed(2);
  return `${s}S`;
}

export { measureText };
