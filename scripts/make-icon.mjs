/**
 * Generates the 1024x1024 source icon used by `npm run tauri icon`.
 *
 * Written as a generator rather than a committed binary so the mark can be
 * tweaked (colors, proportions) without a design tool in the loop. Emits a
 * plain RGBA PNG with no external dependencies.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;

const px = new Uint8Array(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Source-over composite against whatever is already there.
  const sa = a / 255;
  px[i] = Math.round(px[i] * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.max(px[i + 3], a);
}

/** Signed distance to a rounded rect, used for antialiased edges. */
function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

function fillRoundedRect(cx, cy, halfW, halfH, radius, colorAt) {
  const minX = Math.floor(cx - halfW - 2);
  const maxX = Math.ceil(cx + halfW + 2);
  const minY = Math.floor(cy - halfH - 2);
  const maxY = Math.ceil(cy + halfH + 2);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = roundedRectSdf(x + 0.5, y + 0.5, cx, cy, halfW, halfH, radius);
      // 1px linear falloff across the boundary.
      const coverage = Math.min(Math.max(0.5 - d, 0), 1);
      if (coverage <= 0) continue;
      const [r, g, b, a] = colorAt(x, y);
      set(x, y, [r, g, b, Math.round(a * coverage)]);
    }
  }
}

const C = SIZE / 2;

// App tile: deep slate with a diagonal cyan lift.
fillRoundedRect(C, C, 472, 472, 210, (x, y) => {
  const t = (x + y) / (SIZE * 2);
  return [
    Math.round(8 + t * 12),
    Math.round(11 + t * 34),
    Math.round(20 + t * 58),
    255,
  ];
});

// Monitor bezel.
fillRoundedRect(C, C - 40, 300, 210, 34, () => [34, 211, 238, 255]);
// Screen well.
fillRoundedRect(C, C - 40, 268, 178, 22, () => [6, 12, 24, 255]);

// Stand.
fillRoundedRect(C, C + 214, 34, 66, 12, () => [34, 211, 238, 255]);
fillRoundedRect(C, C + 268, 150, 22, 16, () => [34, 211, 238, 255]);

// Cursor arrow inside the screen — the "remote control" half of the idea.
const tipX = C - 54;
const tipY = C - 148;
for (let i = 0; i < 208; i++) {
  const halfWidth = i * 0.42;
  for (let j = -halfWidth; j <= halfWidth; j++) {
    // Skew right so the arrow reads as a pointer rather than a triangle.
    set(Math.round(tipX + j + i * 0.30), tipY + i, [226, 250, 255, 255]);
  }
}
// Cursor tail.
fillRoundedRect(C + 34, C + 34, 22, 62, 10, () => [226, 250, 255, 255]);

// ---- PNG encoding ----

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// bytes 10-12: deflate, adaptive filtering, no interlace — all zero

// Prefix each scanline with filter type 0.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.resolve(__dirname, '../assets');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon-source.png');
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${SIZE}x${SIZE}, ${png.length} bytes)`);
