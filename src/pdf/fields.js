// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Signature fields: finding them, adding them, removing them, and drawing
   their appearance. Pages are never "normalised" the way pdf-lib's own
   addAnnot() does it — that rewrites page content streams, which a viewer
   checking an earlier signature would rightly report as a modification. */

import {
  PDFArray, PDFHexString, PDFName, PDFSignature, StandardFonts,
  degrees, drawImage, drawRectangle, drawText, rgb,
} from 'pdf-lib';

const N = PDFName.of;
const INK = rgb(0.1, 0.17, 0.43);
const GREY = rgb(0.55, 0.55, 0.55);
const upright = { rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) };

/** A widget's rectangle as [x1, y1, x2, y2], lower-left first. */
export function rectOf(widget) {
  const [a, b, c, d] = widget.dict.lookup(N('Rect'), PDFArray).asArray().map(n => n.asNumber());
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function annots(page) {
  let list = page.node.lookupMaybe(N('Annots'), PDFArray);
  if (!list) page.node.set(N('Annots'), list = page.doc.context.obj([]));
  return list;
}

/** Every visible signature widget: its field, page, rectangle, and signer. */
export function signatureFields(doc) {
  const pageOf = new Map();
  doc.getPages().forEach((page, index) => {
    for (const ref of page.node.lookupMaybe(N('Annots'), PDFArray)?.asArray() ?? []) pageOf.set(ref.toString(), index);
  });

  return doc.getForm().getFields()
    .filter(field => field instanceof PDFSignature)
    .flatMap(field => field.acroField.getWidgets().map(widget => {
      const value = field.acroField.dict.lookup(N('V'));
      return {
        name: field.getName(),
        page: pageOf.get(doc.context.getObjectRef(widget.dict)?.toString()),
        rect: rectOf(widget),
        signedBy: value ? (value.lookup(N('Name'))?.decodeText() ?? 'unknown signer') : null,
      };
    }))
    .filter(field => field.page !== undefined);
}

/**
 * A form XObject for a widget of `width` × `height`: an optional image over
 * lines of small print, or with no image, the lines centred in a dashed box.
 */
export async function appearance(doc, width, height, { image, lines, border = false }) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = Math.min(8, Math.max(3, height * 0.12));
  const lead = size * 1.25;
  const textHeight = lines.length * lead;
  const ops = [];

  if (border) {
    ops.push(...drawRectangle({
      x: 0.5, y: 0.5, width: width - 1, height: height - 1, borderWidth: 0.75,
      color: undefined, borderColor: GREY, borderDashArray: [3, 2], ...upright,
    }));
  }

  if (image) {
    const room = { width: width - 4, height: height - textHeight - 4 };
    const scale = Math.min(room.width / image.width, room.height / image.height);
    const w = image.width * scale, h = image.height * scale;
    ops.push(...drawImage('Im0', { x: (width - w) / 2, y: textHeight + 2 + (room.height - h) / 2, width: w, height: h, ...upright }));
  }

  const top = image ? textHeight + 1 : (height + textHeight) / 2;
  lines.forEach((line, i) => {
    const fit = Math.min(size, (width - 4) / Math.max(font.widthOfTextAtSize(line, 1), 1));
    const x = (width - font.widthOfTextAtSize(line, fit)) / 2;
    const y = top - (i + 1) * lead + (lead - fit) / 2 + fit * 0.2;
    ops.push(...drawText(font.encodeText(line), { font: 'F0', size: fit, x, y, color: image ? INK : GREY, ...upright }));
  });

  const Resources = { Font: { F0: font.ref }, ...(image && { XObject: { Im0: image.ref } }) };
  return doc.context.register(doc.context.formXObject(ops, { BBox: [0, 0, width, height], Resources }));
}

/** Adds an empty signature field on page `index` at `rect` (PDF user space). */
export async function addField(doc, index, rect) {
  const form = doc.getForm();
  const taken = new Set(form.getFields().map(f => f.getName()));
  let n = 1;
  while (taken.has(`Signature${n}`)) n++;
  const name = `Signature${n}`;

  const page = doc.getPage(index);
  const [x1, y1, x2, y2] = rect;
  const ap = await appearance(doc, x2 - x1, y2 - y1, { lines: ['Sign here'], border: true });
  const ref = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', F: 4,
    T: PDFHexString.fromText(name), Rect: rect, P: page.ref, AP: { N: ap },
  }));
  annots(page).push(ref);
  form.acroForm.addField(ref);
  return name;
}

/** Removes an unsigned signature field and its widgets. */
export function removeField(doc, name) {
  const form = doc.getForm();
  const field = form.getSignature(name);
  if (field.acroField.dict.has(N('V'))) throw new Error('A signed field cannot be removed.');
  const refs = field.acroField.getWidgets().map(w => doc.context.getObjectRef(w.dict)).concat(field.ref);
  for (const page of doc.getPages()) {
    const list = page.node.lookupMaybe(N('Annots'), PDFArray);
    for (const ref of refs) {
      const at = list?.indexOf(ref);
      if (at !== undefined && at >= 0) list.remove(at);
    }
  }
  form.acroForm.removeField(field.acroField);
}
