// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Signing a field: the signature dictionary is appended with a fixed-size
   hole for /Contents, the /ByteRange is filled in to cover everything but
   that hole, and the CMS signature over those bytes is written into it. */

import { PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { update } from './incremental.js';
import { appearance, rectOf } from './fields.js';
import { signedData } from '../crypto/cms.js';

const N = PDFName.of;
const RESERVED = 16384;                     // bytes of room for the CMS blob
const MAX = 9999999999;                     // ten digits: room for any real offset
const RANGE = `/ByteRange [ 0 ${MAX} ${MAX} ${MAX} ]`;
const HOLE = `<${'0'.repeat(RESERVED * 2)}>`;

const enc = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const stamp = date => date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * Signs field `name` of `bytes` with `signer`, showing `png` as the visible
 * signature. Returns the new PDF bytes.
 */
export async function signField(bytes, name, { png, signer, date = new Date() }) {
  const { bytes: out, start } = await update(bytes, async doc => {
    const { context } = doc;
    const form = doc.getForm();
    const field = form.getSignature(name);
    if (field.acroField.dict.has(N('V'))) throw new Error(`${name} is already signed.`);

    field.acroField.dict.set(N('V'), context.register(context.obj({
      Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.CAdES.detached',
      ByteRange: [0, MAX, MAX, MAX],
      Contents: PDFHexString.of('0'.repeat(RESERVED * 2)),
      M: PDFString.fromDate(date),
      Name: PDFHexString.fromText(signer.name),
    })));

    const image = await doc.embedPng(png);
    const lines = [`Digitally signed by ${signer.name}`, stamp(date)];
    for (const widget of field.acroField.getWidgets()) {
      const [x1, y1, x2, y2] = rectOf(widget);
      widget.dict.set(N('AP'), context.obj({ N: await appearance(doc, x2 - x1, y2 - y1, { image, lines }) }));
    }
    form.acroForm.dict.set(N('SigFlags'), PDFNumber.of(3));
  });

  const appended = new TextDecoder('latin1').decode(out.subarray(start));
  const range = start + appended.indexOf(RANGE);
  const hole = start + appended.indexOf(HOLE);
  if (range < start || hole < start) throw new Error('Could not find the signature placeholder.');

  const a = hole, b = hole + HOLE.length;
  out.set(enc.encode(`/ByteRange [0 ${a} ${b} ${out.length - b}]`.padEnd(RANGE.length)), range);

  const signed = new Uint8Array(a + out.length - b);
  signed.set(out.subarray(0, a));
  signed.set(out.subarray(b), a);

  const cms = hex(await signedData(signed, signer));
  if (cms.length > RESERVED * 2) throw new Error('The signature is too large for the space reserved for it.');
  out.set(enc.encode(cms), hole + 1);
  return out;
}
