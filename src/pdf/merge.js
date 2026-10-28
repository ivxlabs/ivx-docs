// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Merging PDFs: the chosen pages of each file, in order, copied into one new
   document. Unlike everything Sign does, this writes a fresh file — there is
   no original to keep — so any signatures the inputs carried are left
   behind as marks on the page, no longer valid. */

import { PDFDocument } from 'pdf-lib';
import { load } from './incremental.js';

/** Loads a PDF for merging, refusing what cannot be copied from. */
export const loadForMerge = (bytes, name = 'This file') =>
  load(bytes, `${name} is password-protected, so it cannot be merged here. Remove the password first.`);

/**
 * The zero-based page indices a range like "1-3, 5, 8-" picks out of
 * `count` pages. Blank means every page; "5-3" runs backwards.
 */
export function parsePages(spec, count) {
  if (!spec.trim()) return [...Array(count).keys()];
  const pages = [];
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(-?)\s*(\d*)$/);
    if (!m || (!m[1] && !m[3])) throw new Error(`“${part}” is not a page range.`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    for (const n of [from, to]) if (n < 1 || n > count) throw new Error(`There is no page ${n}; the file has ${count}.`);
    const step = from <= to ? 1 : -1;
    for (let n = from; n !== to + step; n += step) pages.push(n - 1);
  }
  return pages;
}

/** One PDF made of `parts`: [{ doc, pages }], each `pages` a list of indices. */
export async function merge(parts) {
  const out = await PDFDocument.create();
  for (const { doc, pages } of parts) {
    for (const page of await out.copyPages(doc, pages)) out.addPage(page);
  }
  return out.save();
}
