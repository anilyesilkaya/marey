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

  const captionHeight = GLYPH_HEIGHT * LABEL_SCALE + 8;
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

function formatIndex(index) {
  return `#${String(index).padStart(3, '0')}`;
}

function formatTime(ms) {
  const s = (ms / 1000).toFixed(2);
  return `${s}S`;
}

export { measureText };
