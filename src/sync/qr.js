// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* QR codes, both ways, for handing sync codes between devices (p2p.js).

   Drawing is qrcode-generator's SVG. Reading uses the browser's own
   BarcodeDetector where there is one (Chrome on Android and macOS), and
   otherwise jsQR on frames from the camera, loaded only then. Nothing leaves
   the device: the camera's picture is read here and thrown away. */

import qrcode from 'qrcode-generator';

/** An SVG element showing `text` as a QR code. */
export function qrElement(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const box = document.createElement('div');
  box.className = 'qr';
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return box;
}

/**
 * Show the camera in `video` and look for a QR code until one is found or
 * `signal` aborts. Resolves with its text, or null when stopped.
 */
export async function scan(video, signal) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } }, audio: false,
  });
  const stop = () => stream.getTracks().forEach(t => t.stop());
  signal?.addEventListener('abort', stop);
  try {
    video.srcObject = stream;
    await video.play();
    const read = await reader();
    while (!signal?.aborted) {
      const text = await read(video).catch(() => null);
      if (text) return text;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  } finally {
    stop();
    video.srcObject = null;
  }
}

async function reader() {
  if ('BarcodeDetector' in globalThis) {
    const formats = await BarcodeDetector.getSupportedFormats().catch(() => []);
    if (formats.includes('qr_code')) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      return async video => (await detector.detect(video))[0]?.rawValue || null;
    }
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async video => {
    if (!video.videoWidth) return null;
    // Small frames read faster and a code held up to a camera is large anyway.
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data || null;
  };
}
