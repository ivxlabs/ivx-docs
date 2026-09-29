// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* A detached CMS SignedData in the shape PAdES baseline (ETSI.CAdES.detached)
   expects: SHA-256, the signer's certificate referenced by a
   signing-certificate-v2 attribute, and no signing-time attribute — the
   signing time lives in the PDF signature dictionary instead.

   The signature itself comes from `signer.sign()`, which only ever sees the
   encoded signed attributes. That is what lets the same code drive a key in
   this browser, a key from a .p12 file, and a key that never leaves a
   hardware token. */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
};

export const sha256 = async data => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

/** 'RSA' or 'EC', from the certificate's public key. */
export const keyType = cert =>
  cert.subjectPublicKeyInfo.algorithm.algorithmId === OID.rsa ? 'RSA' : 'EC';

/** Web Crypto parameters for signing with the key behind `cert`. */
export const algorithmFor = cert => keyType(cert) === 'RSA'
  ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  : { name: 'ECDSA', hash: 'SHA-256', namedCurve: curveOf(cert) };

function curveOf(cert) {
  const oid = cert.subjectPublicKeyInfo.algorithm.algorithmParams?.valueBlock?.toString();
  return { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521' }[oid] ?? 'P-256';
}

const attribute = (type, value) => new pkijs.Attribute({ type, values: [value] });

/**
 * DER-encoded CMS SignedData over `content`.
 * `signer` is { certificates: [signer, ...chain], sign(bytes) → raw signature }.
 */
export async function signedData(content, signer) {
  const [cert] = signer.certificates;
  const rsa = keyType(cert) === 'RSA';
  const sha256Id = () => new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new asn1js.Null() });

  const certHash = await sha256(cert.toSchema().toBER());
  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: sha256Id(),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier(rsa
      ? { algorithmId: OID.sha256WithRSA, algorithmParams: new asn1js.Null() }
      : { algorithmId: OID.ecdsaWithSHA256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        attribute(OID.contentType, new asn1js.ObjectIdentifier({ value: OID.data })),
        attribute(OID.messageDigest, new asn1js.OctetString({ valueHex: await sha256(content) })),
        // SigningCertificateV2 { certs: [ESSCertIDv2 { certHash }] }, SHA-256 being the default hash.
        attribute(OID.signingCertificateV2, new asn1js.Sequence({ value: [
          new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: certHash })] })] }),
        ] })),
      ],
    }),
  });

  // What gets signed is the attribute set with its universal SET tag, not the [0] it is stored under.
  const attrs = new Uint8Array(signerInfo.signedAttrs.toSchema().toBER());
  attrs[0] = 0x31;
  signerInfo.signedAttrs.encodedValue = attrs.buffer;

  const raw = new Uint8Array(await signer.sign(attrs));  // a fresh buffer, whatever came back
  const signature = rsa ? raw : pkijs.createCMSECDSASignature(raw.buffer);
  signerInfo.signature = new asn1js.OctetString({ valueHex: signature });

  const sd = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [sha256Id()],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: signer.certificates,
    signerInfos: [signerInfo],
  });
  return new Uint8Array(new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) }).toSchema().toBER());
}
