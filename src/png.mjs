// Pure-JS PNG codec built on Node's builtin zlib.
//
// Supports the subset needed for screen capture + contact-sheet composition:
//   decode: 8-bit, non-interlaced, color types 0/2/3/4/6, filters 0-4
//   encode: 8-bit RGBA (color type 6) with adaptive per-scanline filtering
//
// No third-party dependencies.

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- CRC32 (table built once) ---------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- filter reconstruction (decode) ----------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.allocUnsafe(stride * height);
  let inPos = 0;
  let outPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[inPos++];
    for (let x = 0; x < stride; x++) {
      const raw = data[inPos++];
      const a = x >= bpp ? out[outPos + x - bpp] : 0; // left
      const b = y > 0 ? out[outPos + x - stride] : 0; // up
      const c = y > 0 && x >= bpp ? out[outPos + x - stride - bpp] : 0; // up-left
      let value;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: value = raw + paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type ${filter}`);
      }
      out[outPos + x] = value & 0xff;
    }
    outPos += stride;
  }
  return out;
}

// --- decode ----------------------------------------------------------------

// Returns { width, height, data } where data is RGBA (4 bytes/pixel).
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG (bad signature)');
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = buffer.subarray(dataStart, dataStart + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    pos = dataStart + length + 4; // skip data + CRC
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 is supported)`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNGs are not supported');
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = unfilter(inflated, width, height, channels);

  const rgba = Buffer.allocUnsafe(width * height * 4);
  const px = width * height;
  for (let i = 0; i < px; i++) {
    const s = i * channels;
    const d = i * 4;
    let r, g, b, a;
    switch (colorType) {
      case 0: // grayscale
        r = g = b = raw[s];
        a = 255;
        break;
      case 2: // RGB
        r = raw[s]; g = raw[s + 1]; b = raw[s + 2];
        a = 255;
        break;
      case 3: { // palette
        const idx = raw[s];
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        a = transparency && idx < transparency.length ? transparency[idx] : 255;
        break;
      }
      case 4: // grayscale + alpha
        r = g = b = raw[s];
        a = raw[s + 1];
        break;
      case 6: // RGBA
        r = raw[s]; g = raw[s + 1]; b = raw[s + 2]; a = raw[s + 3];
        break;
    }
    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
  }

  return { width, height, data: rgba };
}

// --- encode ----------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// Adaptive filtering: for each scanline pick the filter whose output has the
// smallest sum of absolute (signed) values — the standard "minimum sum of
// absolute differences" heuristic. Keeps deflate input compact without a
// dependency on an image library.
function filterScanlines(rgba, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.allocUnsafe((stride + 1) * height);
  let outPos = 0;
  const candidates = [
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
  ];

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const cur = rgba[rowStart + x];
      const a = x >= bpp ? rgba[rowStart + x - bpp] : 0;
      const b = y > 0 ? rgba[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? rgba[prevStart + x - bpp] : 0;
      candidates[0][x] = cur;
      candidates[1][x] = (cur - a) & 0xff;
      candidates[2][x] = (cur - b) & 0xff;
      candidates[3][x] = (cur - ((a + b) >> 1)) & 0xff;
      candidates[4][x] = (cur - paeth(a, b, c)) & 0xff;
    }

    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      const cand = candidates[f];
      for (let x = 0; x < stride; x++) {
        const v = cand[x];
        score += v < 128 ? v : 256 - v; // treat as signed magnitude
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }

    out[outPos++] = best;
    candidates[best].copy(out, outPos);
    outPos += stride;
  }
  return out;
}

// data: RGBA buffer (4 bytes/pixel). Returns a PNG buffer.
export function encodePng(width, height, data) {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const filtered = filterScanlines(data, width, height);
  const compressed = zlib.deflateSync(filtered, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
