// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* End-to-end check of the signing core, outside the browser:
     node tools/selftest.mjs

   Builds a PDF (once with a classic xref table, once with xref streams),
   places three fields, removes one, signs the other two with an RSA and an
   EC certificate from .p12 files, and has OpenSSL verify every signature
   against the byte range it claims. Then checks the same files with Verify's
   own verifier, tampered with and edited after signing, and merges them.
   Needs OpenSSL 3 on PATH or in
   $OPENSSL; with $PKCS11_MODULE set it also signs through a running
   bridge (see bridge/README.md). */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { update } from '../src/pdf/incremental.js';
import { addField, removeField, signatureFields } from '../src/pdf/fields.js';
import { signField } from '../src/pdf/sign.js';
import { verifySignatures } from '../src/pdf/verify.js';
import { loadForMerge, merge, parsePages } from '../src/pdf/merge.js';
import { fileSigner, tokenCertificates, tokenSigner } from '../src/crypto/signers.js';

const OPENSSL = process.env.OPENSSL ?? 'openssl';
const dir = mkdtempSync(join(tmpdir(), 'ivx-docs-'));
const ssl = (...args) => execFileSync(OPENSSL, args, { cwd: dir, stdio: 'pipe' }).toString();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function p12(name, keyArgs) {
  ssl('req', '-x509', '-newkey', ...keyArgs, '-nodes', '-days', '30', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.crt`);
  ssl('pkcs12', '-export', '-inkey', `${name}.key`, '-in', `${name}.crt`, '-passout', 'pass:secret', '-out', `${name}.p12`);
  return fileSigner(readFileSync(join(dir, `${name}.p12`)), 'secret');
}

/** Checks every signature in `bytes` with `openssl cms -verify`. */
function verify(bytes, label) {
  const text = Buffer.from(bytes).toString('latin1');
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map(m => m.slice(1).map(Number));
  ranges.forEach(([, a, b, c], i) => {
    writeFileSync(join(dir, 'content'), Buffer.concat([bytes.subarray(0, a), bytes.subarray(b, b + c)]));
    writeFileSync(join(dir, 'sig.der'), Buffer.from(text.slice(a + 1, b - 1).replace(/(00)+$/, ''), 'hex'));
    ssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', 'sig.der', '-content', 'content', '-noverify', '-purpose', 'any', '-out', '/dev/null');
    console.log(`  ✓ ${label}: signature ${i + 1} verifies, covers bytes 0–${b + c} of ${bytes.length}`);
  });
  return ranges.length;
}

const check = (ok, what) => { if (!ok) throw new Error(what); };
const summary = results => results.map(r => `${r.field}=${r.status}${r.later ? `+${r.later.changes.join('/')}` : ''}`).join(', ');

/** Checks `bytes` with Verify: every signature valid, and each earlier one
    followed only by later signatures. Then breaks it two ways. */
async function selfVerify(bytes, label) {
  const results = await verifySignatures(bytes);
  console.log(`  ✓ ${label}: verify says ${summary(results)}`);
  check(results.every(r => r.status === 'valid' && r.certificates.length && r.chain === 'root'), 'verify: not all valid');
  check(results.at(-1).later === null, 'verify: last signature should cover the whole file');
  check(results.slice(0, -1).every(r => r.later?.changes.every(c => c === 'signature')), 'verify: earlier signatures should see only signing');

  const tampered = bytes.slice();
  tampered[12] ^= 1;                                   // inside the header comment, covered by every signature
  const broken = await verifySignatures(tampered);
  check(broken.every(r => r.status === 'invalid'), 'verify: tampering went unnoticed');

  const { bytes: edited } = await update(bytes, d => { d.getPage(0).drawText('added later', { x: 50, y: 50 }); });
  const after = await verifySignatures(edited);
  check(after.every(r => r.status === 'valid' && r.later?.changes.includes('content')), 'verify: a later content change went unnoticed');
  console.log(`  ✓ ${label}: tampering → ${summary(broken)}; editing → ${summary(after)}`);
}

const rsa = await p12('Alice', ['rsa:2048']);
const ec = await p12('Bob', ['ec', '-pkeyopt', 'ec_paramgen_curve:P-256']);

for (const useObjectStreams of [false, true]) {
  const label = useObjectStreams ? 'xref stream' : 'xref table';
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText('ivx/docs Sign self-test', { x: 50, y: 780 });
  doc.addPage([595, 842]);
  let bytes = await doc.save({ useObjectStreams });

  ({ bytes } = await update(bytes, async d => {
    await addField(d, 0, [50, 600, 250, 660]);
    await addField(d, 1, [50, 100, 250, 160]);
    await addField(d, 1, [300, 100, 500, 160]);
  }));
  ({ bytes } = await update(bytes, d => removeField(d, 'Signature3')));

  bytes = await signField(bytes, 'Signature1', { png: PNG, signer: rsa });
  bytes = await signField(bytes, 'Signature2', { png: PNG, signer: ec });

  const fields = signatureFields(await PDFDocument.load(bytes));
  console.log(`${label}: ${fields.map(f => `${f.name}@p${f.page + 1}=${f.signedBy}`).join(', ')}`);
  if (fields.length !== 2 || fields.some(f => !f.signedBy)) throw new Error('fields not as expected');
  if (verify(bytes, label) !== 2) throw new Error('expected two signatures');
  await selfVerify(bytes, label);
  writeFileSync(join(dir, `signed-${useObjectStreams ? 'stream' : 'table'}.pdf`), bytes);
}

{
  const [table, stream] = ['table', 'stream'].map(k => readFileSync(join(dir, `signed-${k}.pdf`)));
  check(parsePages('', 3).join() === '0,1,2' && parsePages('3-1, 2', 3).join() === '2,1,0,1' && parsePages('2-', 3).join() === '1,2', 'parsePages');
  const merged = await merge([
    { doc: await loadForMerge(table), pages: parsePages('2, 1', 2) },
    { doc: await loadForMerge(stream), pages: parsePages('', 2) },
  ]);
  const count = (await PDFDocument.load(merged)).getPageCount();
  check(count === 4, `merge: expected 4 pages, got ${count}`);
  console.log(`merge: 2 + 2 pages → ${count}`);
  writeFileSync(join(dir, 'merged.pdf'), merged);
}

if (process.env.PKCS11_MODULE) {
  // The bridge only answers browsers from an allowed origin; act like one.
  const plain = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => plain(url, { ...init, headers: { ...init.headers, Origin: 'http://localhost:5173' } });

  const base = process.env.BRIDGE ?? 'http://127.0.0.1:47111';
  const doc = await PDFDocument.create();
  doc.addPage();
  let bytes = await doc.save();
  for (const [i, entry] of (await tokenCertificates(base)).entries()) {
    console.log(`token: ${entry.label} (${entry.name})`);
    let name;
    ({ bytes, result: name } = await update(bytes, d => addField(d, 0, [50, 50 + i * 80, 250, 110 + i * 80])));
    bytes = await signField(bytes, name, { png: PNG, signer: tokenSigner(base, entry, process.env.PIN ?? '1234') });
  }
  verify(bytes, 'token');
  await selfVerify(bytes, 'token');
  writeFileSync(join(dir, 'signed-token.pdf'), bytes);
}

console.log(`output in ${dir}`);
