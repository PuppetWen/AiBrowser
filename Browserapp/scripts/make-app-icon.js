#!/usr/bin/env node
'use strict';

/**
 * Generate the AiBrowser app mark: PNGs + a multi-resolution .ico.
 *
 *   node scripts/make-app-icon.js
 *
 * The mark is a rounded app tile carrying a browser chrome band and an AI
 * sparkle. Detail is progressive on purpose — the traffic-light dots only
 * appear at >=48px, because at 16px they collapse into mud and cost legibility.
 * Everything is rendered at 4x and box-filtered down, so edges stay clean
 * without pulling in an image dependency.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersample factor

// Teal-to-cyan, the family the app's own accents already live in.
const GRAD_TOP = [14, 59, 87];    // #0E3B57
const GRAD_BOT = [47, 216, 195];  // #2FD8C3

// ---------- tiny PNG encoder (same shape as automation/env-icon.js) ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([name, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(payload), 8 + data.length);
  return out;
}

function encodePng(size, pixels) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND'),
  ]);
}

// ---------- geometry ----------

/** Rounded rectangle in normalised 0..1 space. */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Four-point sparkle. |dx|^k + |dy|^k <= 1 with k < 1 gives concave sides —
 * the astroid family, which is exactly the modern "AI" sparkle silhouette.
 */
function inSparkle(x, y, cx, cy, r, k = 0.5) {
  const dx = Math.abs(x - cx) / r;
  const dy = Math.abs(y - cy) / r;
  if (dx > 1 || dy > 1) return false;
  return Math.pow(dx, k) + Math.pow(dy, k) <= 1;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Detail tier for a target size.
 *
 * Progressive detail is not just "hide things when small" — the mark also has
 * to get *bolder*. At 16px a 0.275-radius sparkle collapses into a dot, so the
 * small tier drops the secondary sparkle and grows the primary one instead.
 */
function tierFor(size) {
  if (size >= 48) {
    return { band: 0.275, dots: true, primary: { x: 0.455, y: 0.630, r: 0.275 }, secondary: { x: 0.745, y: 0.470, r: 0.115 } };
  }
  if (size >= 32) {
    return { band: 0.260, dots: false, primary: { x: 0.470, y: 0.625, r: 0.320 }, secondary: { x: 0.760, y: 0.455, r: 0.105 } };
  }
  return { band: 0.235, dots: false, primary: { x: 0.500, y: 0.615, r: 0.400 }, secondary: null };
}

/** Sample one supersampled pixel; returns [r,g,b,a] with a in 0..255. */
function sample(u, v, tier) {
  const TILE = { l: 0.045, t: 0.045, r: 0.955, b: 0.955, radius: 0.225 };
  if (!inRoundedRect(u, v, TILE.l, TILE.t, TILE.r, TILE.b, TILE.radius)) {
    return [0, 0, 0, 0];
  }

  // Diagonal gradient reads better than vertical on a rounded tile.
  const t = Math.min(1, Math.max(0, (u * 0.45 + v * 0.75)));
  let [r, g, b] = mix(GRAD_TOP, GRAD_BOT, t);

  // Browser chrome band across the top.
  if (v < tier.band) {
    r = Math.round(r * 0.62);
    g = Math.round(g * 0.62);
    b = Math.round(b * 0.66);
  }

  // Traffic lights — only once there are pixels to spend on them.
  if (tier.dots && v < tier.band) {
    const dotY = 0.163;
    const dotR = 0.030;
    for (const dx of [0.150, 0.245, 0.340]) {
      const ddx = u - dx;
      const ddy = v - dotY;
      if (ddx * ddx + ddy * ddy <= dotR * dotR) return [255, 255, 255, 235];
    }
  }

  if (tier.secondary && inSparkle(u, v, tier.secondary.x, tier.secondary.y, tier.secondary.r)) {
    return [255, 255, 255, 225];
  }
  if (inSparkle(u, v, tier.primary.x, tier.primary.y, tier.primary.r)) {
    return [255, 255, 255, 255];
  }

  return [r, g, b, 255];
}

function render(size) {
  const big = size * SS;
  const acc = Buffer.alloc(size * size * 4);
  const tier = tierFor(size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x * SS + sx + 0.5) / big;
          const v = (y * SS + sy + 0.5) / big;
          const [r, g, b, a] = sample(u, v, tier);
          // premultiply so transparent edges do not darken toward black
          rs += r * a;
          gs += g * a;
          bs += b * a;
          as += a;
        }
      }
      const i = (y * size + x) * 4;
      if (as === 0) {
        acc[i] = acc[i + 1] = acc[i + 2] = acc[i + 3] = 0;
      } else {
        acc[i] = Math.round(rs / as);
        acc[i + 1] = Math.round(gs / as);
        acc[i + 2] = Math.round(bs / as);
        acc[i + 3] = Math.round(as / (SS * SS));
      }
    }
  }
  return acc;
}

// ---------- ICO container ----------

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size;      // 0 encodes 256
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0; // palette
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4);   // colour planes
    dir.writeUInt16LE(32, at + 6);  // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'logo.ico'), ico);

  for (const size of [256, 512]) {
    const png = encodePng(size, render(size));
    fs.writeFileSync(path.join(OUT_DIR, size === 512 ? 'logo-512.png' : 'logo.png'), png);
  }
  // Sidebar brand image referenced by index.html.
  fs.writeFileSync(path.join(OUT_DIR, 'logo-pixel.png'), encodePng(128, render(128)));
  fs.writeFileSync(path.join(OUT_DIR, 'logo-native.png'), encodePng(128, render(128)));

  console.log('logo.ico       ' + ico.length + ' bytes (' + SIZES.join('/') + ')');
  console.log('logo.png       256px');
  console.log('logo-512.png   512px');
  console.log('logo-pixel.png 128px');
  console.log('logo-native.png 128px');
}

main();
