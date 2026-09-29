// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Renders every page of a PDF with PDF.js, each with an empty overlay layer
   on top for the signature fields. The new pages are built off-screen and
   swapped in whole, so re-rendering after a change neither flickers nor
   loses the scroll position. */

import { AnnotationMode, GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

let current;

/** Renders `bytes` into `container`; returns [{ layer, viewport }] per page. */
export async function render(container, bytes) {
  const task = getDocument({
    data: bytes.slice(),                              // PDF.js takes ownership of what it is given
    cMapUrl: `${ASSETS}cmaps/`,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    isEvalSupported: false,
  });
  const pdf = await task.promise;

  const width = Math.min(container.clientWidth - 32, 1000);
  const dpr = window.devicePixelRatio || 1;
  const pages = [];
  const renders = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    const layer = document.createElement('div');
    layer.className = 'layer';
    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    wrap.append(canvas, layer);

    renders.push(page.render({
      canvas, viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      annotationMode: AnnotationMode.ENABLE,           // draw widget appearances, no form inputs
    }).promise);
    pages.push({ wrap, layer, viewport });
  }

  await Promise.all(renders);
  const { scrollTop } = document.scrollingElement;
  container.replaceChildren(...pages.map(p => p.wrap));
  document.scrollingElement.scrollTop = scrollTop;

  current?.destroy();
  current = task;
  return pages;
}

/** A PDF rectangle [x1, y1, x2, y2] as CSS box { left, top, width, height }. */
export function toBox(viewport, rect) {
  const [a, b] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [c, d] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

/** Two CSS points on a page as a PDF rectangle [x1, y1, x2, y2]. */
export function toRect(viewport, [x1, y1], [x2, y2]) {
  const [a, b] = viewport.convertToPdfPoint(x1, y1);
  const [c, d] = viewport.convertToPdfPoint(x2, y2);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
