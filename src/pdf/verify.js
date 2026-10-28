// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Checking the signatures in a PDF, the way a reader does. For each signed
   field that means four questions:

     intact    do the bytes the signature covers still hash to what was
               signed, and does the signature over that hash verify?
     coverage  does it cover the whole file, and if not, what did the later
               revisions change? Signing, filling in forms and adding
               comments are expected; anything else could alter what the
               document shows without touching the signed bytes.
     when      a trusted timestamp if there is one, otherwise the time the
               signer's own computer claimed.
     who       the certificate chain as the signature carries it. Nothing
               here holds a list of trusted issuers, so identity is shown,
               not vouched for.

   Everything runs on the file's own bytes; nothing is fetched. */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFSignature, PDFStream } from 'pdf-lib';
import { nameOf, sha256 } from '../crypto/cms.js';
import { load, same, serialise } from './incremental.js';
import { signatureFields } from './fields.js';

const N = PDFName.of;

const OID = {
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
};

const HASHES = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

const DN = {
  '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST',
  '2.5.4.5': 'serialNumber', '2.5.4.97': 'organizationIdentifier', '1.2.840.113549.1.9.1': 'E',
};

const latin1 = bytes => new TextDecoder('latin1').decode(bytes);
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], h => parseInt(h, 16));
const digest = async (hash, data) => new Uint8Array(await crypto.subtle.digest(hash, data));
const equal = (a, b) => same(new Uint8Array(a), new Uint8Array(b));
const text = obj => { try { return obj?.decodeText(); } catch { return undefined; } };

/**
 * Every signature in `bytes`, oldest first:
 *   { field, page, rect, kind: 'signature' | 'timestamp', signer, status,
 *     problem, time, timeFrom, timestamp, certificates, chain,
 *     validAtSigning, end, later }
 * status is 'valid', 'invalid' or 'unknown'; `later` is null when the
 * signature covers the whole file, else { revisions, changes: [...] }.
 */
export async function verifySignatures(bytes) {
  const doc = await load(bytes, 'Password-protected PDFs cannot be checked here.');

  const where = new Map(signatureFields(doc).map(f => [f.name, f]));
  const signed = doc.getForm().getFields()
    .filter(field => field instanceof PDFSignature)
    .map(field => ({ name: field.getName(), sig: field.acroField.dict.lookup(N('V')) }))
    .filter(({ sig }) => sig instanceof PDFDict);

  const latest = signed.length ? objects(doc) : null;
  const results = [];
  for (const { name, sig } of signed) {
    const { page = null, rect = null } = where.get(name) ?? {};
    results.push({ field: name, page, rect, ...await check(bytes, sig, { doc, latest }) });
  }
  return results.sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity));
}

/* ── one signature ───────────────────────────────────────────────────── */

async function check(bytes, sig, now) {
  const subFilter = text(sig.lookup(N('SubFilter'))) ?? '';
  const timestampOnly = subFilter === 'ETSI.RFC3161';
  const out = {
    kind: timestampOnly ? 'timestamp' : 'signature',
    signer: text(sig.lookup(N('Name'))) ?? null,
    status: 'invalid', problem: null,
    time: null, timeFrom: null, timestamp: null,
    certificates: [], chain: null, validAtSigning: null,
    end: null, later: null,
  };
  const fail = problem => Object.assign(out, { status: 'invalid', problem });
  const claimed = (() => { try { return sig.lookup(N('M'))?.decodeDate(); } catch { return undefined; } })();

  if (subFilter === 'adbe.x509.rsa_sha1') return Object.assign(out, { status: 'unknown', problem: 'This older signature format (adbe.x509.rsa_sha1) cannot be checked here.' });

  // The byte range must be two runs that leave out exactly the signature value.
  const range = sig.lookup(N('ByteRange'));
  const r = range instanceof PDFArray ? range.asArray().map(n => n.asNumber?.()) : [];
  if (r.length !== 4 || r.some(n => !Number.isInteger(n) || n < 0) || r[0] !== 0 || r[1] >= r[2] || r[2] + r[3] > bytes.length) {
    return fail('The signature’s byte range is malformed.');
  }
  const [, a, b, length] = r;
  out.end = b + length;
  const gap = latin1(bytes.subarray(a, b));
  if (!/^<[\s0-9a-fA-F]*>$/.test(gap)) return fail('The signed bytes leave out more than the signature itself.');

  const content = new Uint8Array(a + length);
  content.set(bytes.subarray(0, a));
  content.set(bytes.subarray(b, out.end), a);

  out.later = await laterChanges(bytes, out.end, now);

  let sd;
  try {
    const asn1 = asn1js.fromBER(unhex(gap.slice(1, -1).replace(/\s/g, '')));
    if (asn1.offset === -1) throw new Error();
    sd = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: asn1.result }).content });
  } catch {
    return fail('The signature value cannot be read.');
  }
  const si = sd.signerInfos[0];
  const pool = (sd.certificates ?? []).filter(c => c instanceof pkijs.Certificate);
  const cert = signerCertificate(si, pool);
  if (cert) {
    const { chain, end } = await chainOf(cert, pool);
    out.certificates = await Promise.all(chain.map(describe));
    out.chain = end;
    out.signer = nameOf(cert);
  }

  // Do the covered bytes still hash to what was signed?
  let intact = null;
  if (timestampOnly) {
    const { messageImprint } = tstInfo(sd);
    const hash = HASHES[messageImprint.hashAlgorithm.algorithmId];
    if (hash) intact = equal(messageImprint.hashedMessage.valueBlock.valueHexView, await digest(hash, content));
  } else if (sd.encapContentInfo.eContent) {                       // adbe.pkcs7.sha1: the content is the hash
    intact = equal(sd.encapContentInfo.eContent.getValue(), await digest('SHA-1', content));
  } else if (si.signedAttrs) {
    const md = attribute(si.signedAttrs, OID.messageDigest);
    const hash = HASHES[si.digestAlgorithm.algorithmId];
    if (md && hash) intact = equal(md.valueBlock.valueHexView, await digest(hash, content));
  }
  if (intact === false) return fail('The document has been changed since it was signed.');

  // And does the signature over that hash verify against the certificate?
  let verified;
  try {
    ({ signatureVerified: verified } = await sd.verify({ signer: 0, data: content, extendedMode: true }));
  } catch (err) {
    if (/unsupported/i.test(err.message)) return Object.assign(out, { status: 'unknown', problem: 'This signature uses an algorithm that cannot be checked here.' });
    verified = false;
  }
  if (!verified) return fail('The signature does not match the signer’s certificate.');
  out.status = 'valid';

  // When: a timestamp's time beats the signer's own claim.
  if (timestampOnly) {
    Object.assign(out, { time: tstInfo(sd).genTime, timeFrom: 'timestamp' });
  } else {
    out.timestamp = await timestamp(si);
    const attr = attribute(si.signedAttrs, OID.signingTime);
    if (out.timestamp?.valid) Object.assign(out, { time: out.timestamp.time, timeFrom: 'timestamp' });
    else if (attr || claimed) Object.assign(out, { time: attr?.toDate() ?? claimed, timeFrom: 'signer' });
  }

  const [first] = out.certificates;
  const at = out.time ?? new Date();
  if (first) out.validAtSigning = first.from <= at && at <= first.until;
  return out;
}

const attribute = (attrs, type) => attrs?.attributes.find(x => x.type === type)?.values[0];

const tstInfo = sd => pkijs.TSTInfo.fromBER(sd.encapContentInfo.eContent.getValue());

function signerCertificate(si, pool) {
  if (!si) return null;
  if (si.sid instanceof pkijs.IssuerAndSerialNumber) {
    return pool.find(c => c.issuer.isEqual(si.sid.issuer) && c.serialNumber.isEqual(si.sid.serialNumber)) ?? null;
  }
  return pool[0] ?? null;                                           // by key identifier: rare enough to guess
}

/** A signature timestamp (PAdES B-T): a token over the signature value. */
async function timestamp(si) {
  const token = attribute(si.unsignedAttrs, OID.timeStampToken);
  if (!token) return null;
  try {
    const sd = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: token }).content });
    const { genTime } = tstInfo(sd);
    const { signatureVerified, signerCertificate } = await sd.verify({ signer: 0, data: si.signature.valueBlock.valueHexView, extendedMode: true })
      .catch(() => ({ signatureVerified: false }));
    return { time: genTime, authority: signerCertificate ? nameOf(signerCertificate) : null, valid: signatureVerified };
  } catch {
    return { time: null, authority: null, valid: false };
  }
}

/* ── certificates ────────────────────────────────────────────────────── */

const signs = (cert, issuer) => cert.verify(issuer).catch(() => false);

/** The chain from `cert` up through `pool`, and how it ends:
    'root' (a self-signed certificate), 'incomplete' or 'broken'. */
async function chainOf(cert, pool) {
  const chain = [cert];
  for (let c = cert; ;) {
    if (c.subject.isEqual(c.issuer)) return { chain, end: await signs(c, null) ? 'root' : 'broken' };
    const issuer = pool.find(x => !chain.includes(x) && x.subject.isEqual(c.issuer));
    if (!issuer) return { chain, end: 'incomplete' };
    if (!await signs(c, issuer)) return { chain, end: 'broken' };
    chain.push(issuer);
    c = issuer;
  }
}

const dn = name => name.typesAndValues
  .map(t => `${DN[t.type] ?? t.type}=${t.value.valueBlock.value}`)
  .join(', ');

async function describe(cert) {
  const fingerprint = await sha256(cert.toSchema().toBER());
  return {
    name: nameOf(cert),
    subject: dn(cert.subject),
    issuer: dn(cert.issuer),
    from: cert.notBefore.value,
    until: cert.notAfter.value,
    fingerprint: Array.from(fingerprint, x => x.toString(16).padStart(2, '0').toUpperCase()).join(':'),
  };
}

/* ── what changed later ──────────────────────────────────────────────── */

/** tag → { obj, data } for every indirect object of `doc`. */
function objects(doc) {
  return new Map(doc.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.tag, { obj, data: serialise(obj) }]));
}

/** What the revisions after byte `end` changed in the objects that existed
    before it. New objects only matter through the old ones that point at
    them, so those are all that is compared. */
async function laterChanges(bytes, end, { doc, latest }) {
  const tail = latin1(bytes.subarray(end));
  if (/^[\s\0]*$/.test(tail)) return null;
  const revisions = Math.max(1, tail.match(/%%EOF/g)?.length ?? 0);

  let before;
  try {
    before = objects(await PDFDocument.load(bytes.subarray(0, end), { updateMetadata: false }));
  } catch {
    return { revisions, changes: ['content'] };
  }

  const changes = new Set();
  for (const [tag, then] of before) {
    const now = latest.get(tag);
    if (!now) continue;
    if (!same(then.data, now.data)) for (const c of classify(tag, then.obj, now.obj, doc)) changes.add(c);
  }
  return { revisions, changes: [...changes] };
}

const dictOf = obj => obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
const is = (dict, key, value) => dict.lookup(N(key)) === N(value);
const refTag = obj => obj instanceof PDFRef ? obj.tag : null;

function changedKeys(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter(k => {
    const x = a.get(k), y = b.get(k);
    return !x || !y || !same(serialise(x), serialise(y));
  }).map(k => k.decodeText());
}

/** The type of field `dict` belongs to, following /Parent. */
function fieldType(dict) {
  for (let d = dict, n = 0; d instanceof PDFDict && n < 32; d = d.lookup(N('Parent')), n++) {
    const ft = d.lookup(N('FT'));
    if (ft) return ft.decodeText();
  }
  return null;
}

/** The kinds of change one modified object amounts to: 'signature', 'form',
    'annotations', 'metadata', or 'content' for anything else. */
function classify(tag, then, now, doc) {
  const { catalog, context } = doc;
  const trailer = context.trailerInfo;
  if (tag === refTag(trailer.Info)) return ['metadata'];

  const annotsKinds = (a, b) => {
    const old = new Set(a?.asArray().map(String) ?? []);
    const neu = new Set(b?.asArray().map(String) ?? []);
    const moved = [...(a?.asArray() ?? []), ...(b?.asArray() ?? [])].filter(x => old.has(String(x)) !== neu.has(String(x)));
    return moved.map(x => {
      const d = dictOf(context.lookup(x));
      return d && is(d, 'Subtype', 'Widget') ? 'form' : 'annotations';
    });
  };

  const d0 = dictOf(then), d1 = dictOf(now);
  if (!d0 || !d1) {
    if (then instanceof PDFArray && now instanceof PDFArray) {
      if (doc.getPages().some(p => refTag(p.node.get(N('Annots'))) === tag)) return annotsKinds(then, now);
      if (refTag(dictOf(catalog.lookup(N('AcroForm')))?.get(N('Fields'))) === tag) return ['form'];
    }
    return ['content'];
  }

  const keys = changedKeys(d0, d1);
  const only = (...allowed) => keys.every(k => allowed.includes(k));

  if (is(d1, 'Type', 'Metadata')) return ['metadata'];
  if (tag === refTag(trailer.Root)) {
    return only('AcroForm', 'DSS', 'Metadata')
      ? keys.map(k => ({ AcroForm: 'form', DSS: 'signature', Metadata: 'metadata' })[k])
      : ['content'];
  }
  if (tag === refTag(catalog.get(N('AcroForm')))) {
    return only('Fields', 'SigFlags', 'DR', 'DA', 'NeedAppearances') ? ['form'] : ['content'];
  }
  if (is(d1, 'Type', 'Page')) {
    return only('Annots') ? annotsKinds(d0.lookup(N('Annots')), d1.lookup(N('Annots'))) : ['content'];
  }

  const ft = fieldType(d1);
  if (ft === 'Sig') return only('V', 'AP') && !d0.has(N('V')) ? ['signature'] : ['content'];
  if (ft) return only('V', 'AP', 'AS') ? ['form'] : ['content'];
  if (d1.has(N('Subtype')) && d1.has(N('Rect')) && !is(d1, 'Subtype', 'Widget')) return ['annotations'];
  return ['content'];
}
