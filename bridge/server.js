#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/docs Sign token bridge.

   Browsers cannot talk to smart cards or USB signing tokens, so this small
   local server does it for them, through the token's PKCS#11 module. It has
   two endpoints and nothing else:

     GET  /certificates   the certificates on every connected token
     POST /sign           { id, pin, digest } → { signature }

   Only a 32-byte SHA-256 digest ever arrives here, the PIN is needed for
   every signature, and the private key never leaves the hardware. The server
   listens on 127.0.0.1 only, answers only the origins in $ORIGINS, and only
   under its own Host name, so an arbitrary web page — or a DNS-rebinding
   trick — cannot use it. */

import { createServer } from 'node:http';
import pkcs11js from 'pkcs11js';

const MODULE = process.env.PKCS11_MODULE ?? process.argv[2];
const PORT = Number(process.env.PORT ?? 47111);
const ORIGINS = (process.env.ORIGINS ?? 'https://docs.ivx.run,http://localhost:5173,http://localhost:4173').split(',').map(o => o.trim());
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];

if (!MODULE) {
  console.error('Usage: PKCS11_MODULE=/path/to/pkcs11.so node server.js   (or pass the path as an argument)');
  process.exit(1);
}

const {
  PKCS11, CKF_SERIAL_SESSION, CKU_USER, CKA_CLASS, CKA_ID, CKA_LABEL, CKA_VALUE,
  CKA_KEY_TYPE, CKO_CERTIFICATE, CKO_PRIVATE_KEY, CKM_RSA_PKCS, CKM_ECDSA,
} = pkcs11js;

const p11 = new PKCS11();
p11.load(MODULE);
p11.C_Initialize();
process.on('SIGINT', () => { p11.C_Finalize(); process.exit(0); });

// DER prefix of a SHA-256 DigestInfo: CKM_RSA_PKCS signs whatever it is given.
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');

const serialOf = slot => p11.C_GetTokenInfo(slot).serialNumber.trim();

function withSession(slot, act) {
  const session = p11.C_OpenSession(slot, CKF_SERIAL_SESSION);
  try { return act(session); } finally { p11.C_CloseSession(session); }
}

function find(session, template) {
  p11.C_FindObjectsInit(session, template);
  try { return p11.C_FindObjects(session, 64); } finally { p11.C_FindObjectsFinal(session); }
}

const attributes = (session, handle, types) =>
  p11.C_GetAttributeValue(session, handle, types.map(type => ({ type }))).map(a => a.value);

function certificates() {
  return p11.C_GetSlotList(true).flatMap(slot => {
    try {
      return withSession(slot, session =>
        find(session, [{ type: CKA_CLASS, value: CKO_CERTIFICATE }]).map(handle => {
          const [value, id, label] = attributes(session, handle, [CKA_VALUE, CKA_ID, CKA_LABEL]);
          return { id: `${serialOf(slot)}:${id.toString('hex')}`, label: label.toString(), certificate: value.toString('base64') };
        }));
    } catch {
      return [];                                        // an empty or unreadable slot
    }
  });
}

function sign({ id, pin, digest }) {
  const [serial, keyId] = String(id).split(':');
  const hash = Buffer.from(String(digest), 'base64');
  if (hash.length !== 32) throw new Error('Expected a SHA-256 digest.');
  const slot = p11.C_GetSlotList(true).find(s => serialOf(s) === serial);
  if (!slot) throw new Error('That token is not connected.');

  return withSession(slot, session => {
    p11.C_Login(session, CKU_USER, String(pin));
    try {
      const [key] = find(session, [{ type: CKA_CLASS, value: CKO_PRIVATE_KEY }, { type: CKA_ID, value: Buffer.from(keyId, 'hex') }]);
      if (!key) throw new Error('No private key on the token matches that certificate.');
      const [type] = attributes(session, key, [CKA_KEY_TYPE]);
      const rsa = type.every(b => b === 0);                  // CKK_RSA is 0
      p11.C_SignInit(session, { mechanism: rsa ? CKM_RSA_PKCS : CKM_ECDSA }, key);
      return p11.C_Sign(session, rsa ? Buffer.concat([SHA256_DIGEST_INFO, hash]) : hash, Buffer.alloc(1024));
    } finally {
      p11.C_Logout(session);
    }
  });
}

// What PKCS#11 says, in words for the person holding the token.
const MESSAGES = {
  CKR_PIN_INCORRECT: 'Wrong PIN.',
  CKR_PIN_LOCKED: 'The PIN is locked. Unblock the token with its PUK or admin PIN.',
  CKR_PIN_LEN_RANGE: 'That PIN is not the right length.',
  CKR_TOKEN_NOT_PRESENT: 'The token was removed.',
  CKR_DEVICE_REMOVED: 'The token was removed.',
};
const explain = err => MESSAGES[Object.keys(MESSAGES).find(code => err.message.includes(code))] ?? err.message;

const body = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(); });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

createServer(async (req, res) => {
  const { origin } = req.headers;
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const send = (status, json) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(json));
  };

  if (!HOSTS.includes(req.headers.host) || !ORIGINS.includes(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Origin ${origin} is not allowed; restart the bridge with ORIGINS=${origin}` }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && req.url === '/certificates') return send(200, { certificates: certificates() });
    if (req.method === 'POST' && req.url === '/sign') return send(200, { signature: sign(JSON.parse(await body(req))).toString('base64') });
    send(404, { error: 'Not found.' });
  } catch (err) {
    send(500, { error: explain(err) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ivx/docs Sign bridge on http://127.0.0.1:${PORT}`);
  console.log(`  module:  ${MODULE}`);
  console.log(`  origins: ${ORIGINS.join(', ')}`);
});
