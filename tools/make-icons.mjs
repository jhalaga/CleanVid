/**
 * Generate CleanVid's PNG icons with zero dependencies.
 * Usage: node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'icons');
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a + (b - a) * clamp01(t);

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.max(left + radius, Math.min(right - radius, x));
  const cy = Math.max(top + radius, Math.min(bottom - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / lengthSq);
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return Math.hypot(px - x, py - y);
}

function drawIcon(size) {
  const scale = size / 128;
  const width = size;
  const height = size;
  const samples = SUPERSAMPLE;
  const out = Buffer.alloc(width * height * 4);

  const shield = [
    [0.5, 0.13],
    [0.79, 0.235],
    [0.79, 0.515],
    [0.725, 0.63],
    [0.5, 0.87],
    [0.275, 0.63],
    [0.21, 0.515],
    [0.21, 0.235],
  ].map(([x, y]) => [x * 128, y * 128]);

  const checkA = [0.335 * 128, 0.49 * 128];
  const checkB = [0.455 * 128, 0.605 * 128];
  const checkC = [0.675 * 128, 0.365 * 128];
  const checkWidth = 5.4;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / scale;
          const py = (y + (sy + 0.5) / samples) / scale;

          if (!roundedRectContains(px, py, 4, 4, 124, 124, 27)) continue;

          let cr = 10;
          let cg = 17;
          let cb = 24;

          const veil = clamp01((px + py) / 256);
          cr = mix(cr, 17, veil * 0.5);
          cg = mix(cg, 30, veil * 0.5);
          cb = mix(cb, 39, veil * 0.5);

          const glowDistance = Math.hypot(px - 100, py - 22);
          const glow = clamp01(1 - glowDistance / 90) ** 2 * 0.45;
          cr = mix(cr, 52, glow * 0.45);
          cg = mix(cg, 116, glow);
          cb = mix(cb, 94, glow * 0.8);

          if (pointInPolygon(px, py, shield)) {
            const t = clamp01((py - 20) / 95);
            cr = mix(96, 31, t);
            cg = mix(243, 202, t);
            cb = mix(190, 153, t);

            const edge =
              Math.min(
                distanceToSegment(px, py, shield[0][0], shield[0][1], shield[1][0], shield[1][1]),
                distanceToSegment(px, py, shield[7][0], shield[7][1], shield[0][0], shield[0][1])
              ) < 2.4;
            if (edge) {
              cr = mix(cr, 255, 0.22);
              cg = mix(cg, 255, 0.22);
              cb = mix(cb, 255, 0.22);
            }

            const check =
              distanceToSegment(px, py, checkA[0], checkA[1], checkB[0], checkB[1]) <= checkWidth ||
              distanceToSegment(px, py, checkB[0], checkB[1], checkC[0], checkC[1]) <= checkWidth;
            if (check) {
              cr = 5;
              cg = 22;
              cb = 19;
            }
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const total = samples * samples;
      const alpha = a / total;
      const index = (y * width + x) * 4;
      if (alpha > 0) {
        const count = a / 255;
        out[index] = Math.round(r / count);
        out[index + 1] = Math.round(g / count);
        out[index + 2] = Math.round(b / count);
        out[index + 3] = Math.round(alpha);
      }
    }
  }

  return encodePng(width, height, out);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#111d27"/>
      <stop offset="1" stop-color="#080e14"/>
    </linearGradient>
    <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#63f2c5"/>
      <stop offset="1" stop-color="#1fca99"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="27" fill="url(#bg)"/>
  <circle cx="100" cy="22" r="46" fill="#4fe3b3" opacity=".13"/>
  <path d="M64 17l37 13v36c0 20-13 39-37 49-24-10-37-29-37-49V30l37-13z" fill="url(#shield)"/>
  <path d="M46 64l14 15 24-29" fill="none" stroke="#061713" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = drawIcon(size);
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
}
fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), SVG);
console.log('wrote icons/icon.svg');
