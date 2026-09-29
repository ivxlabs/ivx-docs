// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The three places a signing key can live. Each produces the same shape —
   { name, certificates: [signer, ...chain], sign(bytes) } — so cms.js never
   needs to know which one it is talking to.

     device  a key generated in this browser, kept non-extractable in
             IndexedDB, with a self-signed certificate in your name
     file    a PKCS#12 (.p12 / .pfx) certificate file and its password
     token   a smart card or USB token, reached through the local bridge
             in bridge/ — the key never leaves the hardware */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import forge from 'node-forge';
import { algorithmFor, sha256 } from './cms.js';

const certFrom = der => pkijs.Certificate.fromBER(der);

export const nameOf = cert =>
  cert.subject.typesAndValues.find(t => t.type === '2.5.4.3')?.value.valueBlock.value ?? 'Unknown signer';

const withKey = (key, certificates) => ({
  name: nameOf(certificates[0]),
  certificates,
  sign: data => crypto.subtle.sign(algorithmFor(certificates[0]), key, data),
});

/* ── device ──────────────────────────────────────────────────────────── */

const store = (mode, act) => new Promise((resolve, reject) => {
  const open = indexedDB.open('ivxdocs-sign', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = act(open.result.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  };
});

async function selfSigned(name, email, keys) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;                                   // keep it positive
  cert.serialNumber = new asn1js.Integer({ valueHex: serial });
  for (const dn of [cert.subject, cert.issuer]) {
    dn.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: name }) }));
    if (email) dn.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '1.2.840.113549.1.9.1', value: new asn1js.IA5String({ value: email }) }));
  }
  cert.notBefore.value = new Date();
  cert.notAfter.value = new Date(Date.now() + 10 * 365 * 864e5);
  // keyUsage: digitalSignature + nonRepudiation
  const usage = new asn1js.BitString({ valueHex: new Uint8Array([0xc0]), unusedBits: 6 });
  cert.extensions = [new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: usage.toBER() })];
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  return cert;
}

/** The signing identity kept in this browser, made anew when name or email change. */
export async function deviceSigner(name, email = '') {
  const saved = await store('readonly', s => s.get('identity'));
  if (saved?.name === name && saved.email === email) return withKey(saved.key, [certFrom(saved.cert)]);

  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false, ['sign', 'verify']);
  const cert = await selfSigned(name, email, keys);
  await store('readwrite', s => s.put({ name, email, key: keys.privateKey, cert: cert.toSchema().toBER() }, 'identity'));
  return withKey(keys.privateKey, [cert]);
}

/* ── file ────────────────────────────────────────────────────────────── */

/** A signer from a PKCS#12 file. forge reads it because it still speaks the
    3DES and RC2 encryption most exported .p12 files use; Web Crypto does not. */
export async function fileSigner(buffer, password) {
  const { asn1, pki, pkcs12, util } = forge;
  const der = node => new Uint8Array(util.binary.raw.decode(asn1.toDer(node).getBytes()));

  let p12;
  try {
    p12 = pkcs12.pkcs12FromAsn1(asn1.fromDer(util.binary.raw.encode(new Uint8Array(buffer))), password);
  } catch {
    throw new Error('Could not open the certificate file. Is the password right?');
  }

  const bags = type => p12.getBags({ bagType: type })[type] ?? [];
  const keyBag = [...bags(pki.oids.pkcs8ShroudedKeyBag), ...bags(pki.oids.keyBag)][0];
  if (!keyBag) throw new Error('The certificate file holds no private key.');
  // forge only models RSA keys; for anything else it hands back the raw ASN.1.
  const pkcs8 = der(keyBag.key ? pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(keyBag.key)) : keyBag.asn1);

  const keyId = keyBag.attributes.localKeyId?.[0];
  const certificates = bags(pki.oids.certBag)
    .sort((a, b) => (b.attributes.localKeyId?.[0] === keyId) - (a.attributes.localKeyId?.[0] === keyId))
    .map(bag => certFrom(der(bag.cert ? pki.certificateToAsn1(bag.cert) : bag.asn1)));
  if (!certificates.length) throw new Error('The certificate file holds no certificate.');

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, algorithmFor(certificates[0]), false, ['sign']);
  return withKey(key, certificates);
}

/* ── token ───────────────────────────────────────────────────────────── */

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function bridge(url, body) {
  let res;
  try {
    res = await fetch(url, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('The token bridge is not reachable. Is it running?');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `The token bridge answered ${res.status}.`);
  return json;
}

/** The certificates on every token the bridge can see. */
export async function tokenCertificates(base) {
  const { certificates } = await bridge(`${base}/certificates`);
  return certificates.map(({ id, label, certificate }) => {
    const cert = certFrom(unb64(certificate));
    return { id, label, cert, name: nameOf(cert) };
  });
}

/** A signer whose key stays on the token; only a SHA-256 digest is sent. */
export const tokenSigner = (base, { id, cert }, pin) => ({
  name: nameOf(cert),
  certificates: [cert],
  sign: async data => unb64((await bridge(`${base}/sign`, { id, pin, digest: b64(await sha256(data)) })).signature),
});
