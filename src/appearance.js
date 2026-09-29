// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The visible part of a signature. Typed, drawn or uploaded, it always ends
   up as a PNG — one path into the PDF, whatever the source. */

export const FONT = 'Dancing Script';
const INK = '#1a2b6d';

const toPng = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  .then(blob => blob.arrayBuffer())
  .then(buffer => new Uint8Array(buffer));

/** A copy of `canvas` cropped to what is drawn on it, or null if nothing is. */
function trim(canvas, pad = 8) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1 + pad * 2;
  out.height = y2 - y1 + 1 + pad * 2;
  out.getContext('2d').drawImage(canvas, x1, y1, x2 - x1 + 1, y2 - y1 + 1, pad, pad, x2 - x1 + 1, y2 - y1 + 1);
  return out;
}

/** A name set in the signature font. */
export async function typed(text) {
  if (!text.trim()) throw new Error('Type your name first.');
  const font = `96px "${FONT}"`;
  await document.fonts.load(font);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 80;
  canvas.height = 200;
  ctx.font = font;                                   // resizing reset it
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 40, 100);
  return toPng(trim(canvas));
}

/** Whatever is on the drawing pad. */
export function drawn(canvas) {
  const cropped = trim(canvas);
  if (!cropped) throw new Error('Draw your signature first.');
  return toPng(cropped);
}

/** An uploaded image, re-encoded as PNG and kept to a sensible size. */
export async function uploaded(file) {
  if (!file) throw new Error('Choose an image first.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return toPng(canvas);
}

/** Turns `canvas` into a pad you can sign on with a mouse, pen or finger. */
export function pad(canvas) {
  const ctx = canvas.getContext('2d');
  let last = null;

  const point = e => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
  };

  canvas.addEventListener('pointerdown', e => {
    last = point(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!last) return;
    const next = point(e);
    ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1) * (e.pressure ? 0.6 + e.pressure * 0.8 : 1);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(...last);
    ctx.lineTo(...next);
    ctx.stroke();
    last = next;
  });
  for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => { last = null; });

  return {
    /** Fits the backing store to the element when its size changed (which
        clears it), or clears it anyway when asked to. Hidden, it waits. */
    reset(clear = false) {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (!width || (!clear && canvas.width === width && canvas.height === height)) return;
      canvas.width = width;
      canvas.height = height;
    },
  };
}
