// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Every change this app makes to a PDF is an incremental update: the original
   bytes are kept verbatim and the changed objects are appended after them,
   with a new cross-reference section pointing back at the old one. That is
   the only way a second signature can be added without breaking the first —
   a signature covers a byte range, and rewriting the file moves every byte.

   pdf-lib does the parsing and the object model, but it can only save a whole
   new file. So instead of tracking by hand which objects an edit touched, the
   document is serialised before and after the edit, and whatever differs is
   what gets appended. */

import { PDFDocument, PDFCrossRefStream, PDFNumber } from 'pdf-lib';

const enc = new TextEncoder();

/** The bytes pdf-lib would write for one object. */
const serialise = obj => {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
};

const same = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);

const snapshot = context => new Map(
  context.enumerateIndirectObjects().map(([ref, obj]) => [ref.tag, serialise(obj)]));

/** Where the last cross-reference section starts, whether it is a stream,
    and the /Size it declares. */
function lastXref(bytes) {
  const latin1 = from => new TextDecoder('latin1').decode(bytes.subarray(from));
  const match = [...latin1(-1024).matchAll(/startxref\s+(\d+)/g)].pop();
  if (!match) throw new Error('This PDF has no cross-reference table.');
  const offset = Number(match[1]);
  const section = latin1(offset);
  return { offset, stream: !section.startsWith('xref'), size: Number(section.match(/\/Size\s+(\d+)/)?.[1] ?? 0) };
}

/**
 * Loads `bytes`, lets `edit(doc)` change the document, and returns the
 * original bytes with those changes appended as a new revision.
 */
export async function update(bytes, edit) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { context } = doc;
  const prev = lastXref(bytes);
  /* pdf-lib does not register cross-reference streams as objects, so their
     numbers look free to it. The trailer's /Size says what is really taken. */
  context.largestObjectNumber = Math.max(context.largestObjectNumber, prev.size - 1);
  const before = snapshot(context);

  const result = await edit(doc);
  await doc.flush();                                  // embed fonts and images

  const changed = context.enumerateIndirectObjects()
    .map(([ref, obj]) => [ref, serialise(obj)])
    .filter(([ref, data]) => !same(before.get(ref.tag), data));

  const parts = [bytes];
  let length = bytes.length;
  const push = data => { parts.push(data); length += data.length; };
  const pushObject = (ref, data) => {
    push(enc.encode(`\n${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(data);
    push(enc.encode('\nendobj'));
  };

  const offsets = [];
  for (const [ref, data] of changed) {
    offsets.push([ref, length + 1]);                  // +1: the leading newline
    pushObject(ref, data);
  }

  const { Root, Info, ID } = context.trailerInfo;
  const trailer = { Root, Info, ID, Prev: PDFNumber.of(prev.offset) };

  /* The new section matches the kind the file already uses: a reader that
     follows /Prev from a classic table into a stream (or back) is within the
     spec, but not every validator agrees. */
  if (prev.stream) {
    const xrefRef = context.nextRef();
    const xref = PDFCrossRefStream.create(context.obj({ ...trailer, Size: context.largestObjectNumber + 1 }));
    for (const [ref, offset] of offsets) xref.addUncompressedEntry(ref, offset);
    const start = length + 1;
    xref.addUncompressedEntry(xrefRef, start);
    pushObject(xrefRef, serialise(xref));
    push(enc.encode(`\nstartxref\n${start}\n%%EOF\n`));
  } else {
    const start = length + 1;
    let table = '\nxref\n';
    const sorted = offsets.sort(([a], [b]) => a.objectNumber - b.objectNumber);
    for (let i = 0; i < sorted.length;) {                // contiguous runs
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0].objectNumber === sorted[j][0].objectNumber + 1) j++;
      table += `${sorted[i][0].objectNumber} ${j - i + 1}\n`;
      for (const [ref, offset] of sorted.slice(i, j + 1)) {
        table += `${String(offset).padStart(10, '0')} ${String(ref.generationNumber).padStart(5, '0')} n\r\n`;
      }
      i = j + 1;
    }
    const dict = context.obj({ ...trailer, Size: context.largestObjectNumber + 1 });
    push(enc.encode(`${table}trailer\n`));
    push(serialise(dict));
    push(enc.encode(`\nstartxref\n${start}\n%%EOF\n`));
  }

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return { bytes: out, start: bytes.length, result };
}

