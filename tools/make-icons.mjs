// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Renders the PNG app icons from scratch — no image libraries, no binaries.
   Run with: node tools/make-icons.mjs   (only needed if the artwork changes)

   These exist so the PWA can be installed; the app itself shows a wordmark,
   not a logo. The mark is ivx/ai Chat's: "ivx" over a dimmed slash, except
   that where Chat has "ai", this has a signature. Also writes icon.svg from
   the same geometry. */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── signed distance helpers (units are fractions of the icon size) ── */

const roundedRect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
};

const mix = (a, b, t) => a + (b - a) * t;

/* The signature: one stroke, a wave that settles as it goes, as polyline
   points in icon units. Shared by the PNGs and the SVG. */
const SIGNATURE = Array.from({ length: 41 }, (_, i) => {
  const t = i / 40;
  return [0.45 + 0.28 * t, 0.66 - 0.075 * Math.sin(3 * Math.PI * t) * (1 - 0.45 * t)];
});

const segment = (px, py, ax, ay, bx, by, halfWidth) => {
  // Distance to a thick line segment: the building block of the letterform.
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.min(Math.max((wx * vx + wy * vy) / (vx * vx + vy * vy), 0), 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - halfWidth;
};

function render(size, { padding = 0 } = {}) {
  const S = 3;                                          // supersampling factor
  const out = Buffer.alloc(size * size * 4);
  const inset = padding;                                // maskable icons need a safe area
  const scale = 1 - inset * 2;

  const BG = [0x0a, 0x0a, 0x0a];                        // --n-950
  const FG = [0xfa, 0xfa, 0xfa];                        // --n-50
  const DIM = [0x8a, 0x8a, 0x8a];                       // --n-500, for the slash

  /* "ivx" over "/ai", so the whole brand fits at icon sizes: three glyphs a
     line stay legible where six on one line turn to mush. Letterforms are
     built from thick segments and one ring, the same primitives as before. */
  const W = 0.052, hw = W / 2;
  const X1T = 0.28, X1B = 0.44;                         // x-height, line one
  const X2T = 0.58, X2B = 0.74;                         // x-height, line two

  const stem = (px, py, x, t, b) => segment(px, py, x, t, x, b, hw);
  const tittle = (px, py, x, y) => Math.hypot(px - x, py - y) - hw * 1.05;
  const vee = (px, py, l, r, t, b) => Math.min(
    segment(px, py, l, t, (l + r) / 2, b, hw),
    segment(px, py, r, t, (l + r) / 2, b, hw));
  const ex = (px, py, l, r, t, b) => Math.min(
    segment(px, py, l, t, r, b, hw),
    segment(px, py, r, t, l, b, hw));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const px = (u - inset) / scale;
          const py = (v - inset) / scale;

          const plate = roundedRect(px, py, 0.5, 0.5, 0.5, 0.5, 0.22);
          const plateA = Math.min(Math.max(0.5 - plate * size * scale, 0), 1);

          let word = Math.min(
            // ivx
            stem(px, py, 0.288, X1T, X1B),
            tittle(px, py, 0.288, X1T - 0.055),
            vee(px, py, 0.368, 0.508, X1T, X1B),
            ex(px, py, 0.568, 0.708, X1T, X1B)
          );
          for (let k = 1; k < SIGNATURE.length; k++) {
            word = Math.min(word, segment(px, py, ...SIGNATURE[k - 1], ...SIGNATURE[k], hw * 0.8));
          }
          const slash = segment(px, py, 0.298, X2B + 0.02, 0.398, X2T - 0.02, hw);

          const wordA = Math.min(Math.max(0.5 - word * size * scale, 0), 1) * plateA;
          const slashA = Math.min(Math.max(0.5 - slash * size * scale, 0), 1) * plateA;

          const ink = [
            mix(mix(BG[0], DIM[0], slashA), FG[0], wordA),
            mix(mix(BG[1], DIM[1], slashA), FG[1], wordA),
            mix(mix(BG[2], DIM[2], slashA), FG[2], wordA),
          ];
          r += ink[0] * plateA;
          g += ink[1] * plateA;
          b += ink[2] * plateA;
          a += plateA;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, out);
}

const svg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="ivx/docs Sign">
  <rect width="100" height="100" rx="22" fill="#0a0a0a"/>
  <g stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <!-- ivx -->
    <g stroke="#fafafa">
      <path d="M28.8 28 V44"/>
      <circle cx="28.8" cy="22.5" r="2.6" fill="#fafafa" stroke="none"/>
      <path d="M36.8 28 L43.8 44 L50.8 28"/>
      <path d="M56.8 28 L70.8 44 M70.8 28 L56.8 44"/>
    </g>
    <!-- the slash carries the brand, so it is dimmed rather than emphasised -->
    <path d="M29.8 76 L39.8 56" stroke="#8a8a8a"/>
    <!-- the signature -->
    <polyline stroke="#fafafa" stroke-width="4.2" points="${SIGNATURE.map(([x, y]) => `${(x * 100).toFixed(1)},${(y * 100).toFixed(1)}`).join(' ')}"/>
  </g>
</svg>
`;

writeFileSync('public/icons/icon-192.png', render(192));
writeFileSync('public/icons/icon-512.png', render(512));
writeFileSync('public/icons/maskable-512.png', render(512, { padding: 0.1 }));
writeFileSync('public/icons/icon.svg', svg());
console.log('wrote public/icons/*');
