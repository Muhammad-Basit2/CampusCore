/**
 * Pure-JavaScript PNG generator for the CampusCore app icon.
 * No native/extra dependencies - uses only node:zlib and Buffer.
 *
 * Usage: npm run icon
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* Minimal PNG encoder                                                */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Logo drawing (3x supersampled)                                     */
/* ------------------------------------------------------------------ */

const SIZE = 512;
const SS = 3;
const W = SIZE * SS;
const CENTER = W / 2;

function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const dx = Math.min(x, w - x);
  const dy = Math.min(y, h - y);
  if (dx >= r || dy >= r) return true;
  const cx = dx < r ? r : dx;
  const cy = dy < r ? r : dy;
  return (cx - r) ** 2 + (cy - r) ** 2 <= r * r;
}

/** Returns [r,g,b,a] for a sample point in 0..W space, or null for transparent. */
function sample(x, y) {
  if (!insideRoundedRect(x, y, W, W, W * 0.2)) return null;

  // Vertical gradient background
  const t = y / W;
  let r = Math.round(37 + (12 - 37) * t);
  let g = Math.round(99 + (58 - 99) * t);
  let b = Math.round(235 + (191 - 235) * t);

  const dx = x - CENTER;
  const dy = y - CENTER * 0.94;
  const dist = Math.hypot(dx, dy);
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = right
  if (ang < 0) ang += 360;

  const outer = W * 0.30;
  const inner = W * 0.205;

  // The "C" ring with a gap facing right
  const inRing = dist <= outer && dist >= inner;
  const gapStart = 320;
  const gapEnd = 40; // gap spans 320deg -> 40deg (wraps past 0)
  const inGap = ang >= gapStart || ang <= gapEnd;
  if (inRing && !inGap) return [255, 255, 255, 255];

  // Accent bar bottom-right
  const bx = W * 0.66;
  const by = W * 0.7;
  if (Math.abs(x - bx) < W * 0.055 && Math.abs(y - by) < W * 0.2) {
    return [250, 204, 21, 255];
  }

  // Accent dot top-right
  if (Math.hypot(x - W * 0.79, y - W * 0.22) < W * 0.045) {
    return [250, 204, 21, 255];
  }

  return [r, g, b, 255];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const s = sample(px * SS + sx + 0.5, py * SS + sy + 0.5);
          if (s) {
            r += s[0];
            g += s[1];
            b += s[2];
            a += s[3];
          }
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (py * SIZE + px) * 4;
      // premultiplied average to avoid dark halos on edges
      rgba[idx] = alpha ? Math.round(r / (a / 255)) : 0;
      rgba[idx + 1] = alpha ? Math.round(g / (a / 255)) : 0;
      rgba[idx + 2] = alpha ? Math.round(b / (a / 255)) : 0;
      rgba[idx + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ */
/* ICO encoder                                                         */
/*                                                                     */
/* NSIS (and Windows itself) refuse a bare PNG named .png/.ico, so the  */
/* installer icon has to be a real multi-resolution .ico container.    */
/* ------------------------------------------------------------------ */

/** Box-filters the RGBA buffer from `size` down to `target`. */
function resizeRgba(src, size, target) {
  const dst = Buffer.alloc(target * target * 4);
  const ratio = size / target;
  for (let y = 0; y < target; y += 1) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio));
    for (let x = 0; x < target; x += 1) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < size; sy += 1) {
        for (let sx = x0; sx < x1 && sx < size; sx += 1) {
          const i = (sy * size + sx) * 4;
          // Weight colour by alpha so transparent edges do not bleed dark.
          r += src[i] * src[i + 3];
          g += src[i + 1] * src[i + 3];
          b += src[i + 2] * src[i + 3];
          a += src[i + 3];
          n += 1;
        }
      }
      const o = (y * target + x) * 4;
      const alpha = n ? a / n : 0;
      dst[o] = a ? Math.round(r / a) : 0;
      dst[o + 1] = a ? Math.round(g / a) : 0;
      dst[o + 2] = a ? Math.round(b / a) : 0;
      dst[o + 3] = Math.round(alpha);
    }
  }
  return dst;
}

/** Wraps PNG frames into a classic ICONDIR / ICONDIRENTRY container. */
function encodeIco(sizes, frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const dir = [];
  for (let i = 0; i < sizes.length; i += 1) {
    const entry = Buffer.alloc(16);
    entry[0] = sizes[i] >= 256 ? 0 : sizes[i]; // 0 means 256
    entry[1] = sizes[i] >= 256 ? 0 : sizes[i];
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frames[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += frames[i].length;
    dir.push(entry);
  }
  return Buffer.concat([header, ...dir, ...frames]);
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const master = render();
const pngFile = path.join(outDir, 'icon.png');
fs.writeFileSync(pngFile, encodePng(SIZE, SIZE, master));
console.log(`[icon] wrote ${pngFile} (${SIZE}x${SIZE})`);

// Windows picks the best fit per context, so ship the common sizes.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const frames = ICO_SIZES.map((s) => {
  const rgba = s === SIZE ? master : resizeRgba(master, SIZE, s);
  return encodePng(s, s, rgba);
});
const icoFile = path.join(outDir, 'icon.ico');
fs.writeFileSync(icoFile, encodeIco(ICO_SIZES, frames));
console.log(`[icon] wrote ${icoFile} (${ICO_SIZES.join(', ')}px)`);
