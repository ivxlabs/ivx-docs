// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Backups of Tasks to the person's own Google Drive.

   Everything else in Tasks stays in the browser, so a lost or wiped device
   would take the lists with it; this is the way out. It is the one place
   Tasks talks to anyone else, and only when asked:

   - Sign In with an ivx account (iam.ivx.run): OAuth 2.1, authorization code
     with PKCE, entirely in this page. The session lives in localStorage.
   - The Google account is connected on iam's account page, which keeps
     Google's refresh token, encrypted, and hands this page a short-lived
     Drive token when it asks (iam's /api/google/token). The token can only
     reach files ivx itself created in that Drive (the drive.file scope).
   - The backup goes from this page straight to Google. iam never sees it.

   With a passphrase the backup is sealed here first (PBKDF2 to AES-GCM), so
   Google holds only ciphertext; without one Google can read it. Each backup
   replaces the content of one file, and Drive keeps the earlier versions
   (File → Manage versions in Drive), so a bad one can be undone there.

   Restoring merges: each task and list keeps whichever side changed it
   last, the same rule sync uses, so restoring never throws away newer work. */

import * as store from './store.js';

/** iam.ivx.run and its Supabase project; CLIENT_ID is Tasks' OAuth client
    there (Authentication → OAuth Server), with this page as its redirect. */
export const IAM = {
  url: 'https://iam.ivx.run',
  supabaseUrl: 'https://axmtlkeiqcdzyittpgho.supabase.co',
  clientId: '',
};

export const configured = () => Boolean(IAM.clientId);

const SESSION_KEY = 'ivx-tasks-session';
const FLOW_KEY = 'ivx-tasks-oauth';
const FILE_NAME = 'ivx Tasks backup.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/* ── the ivx session ───────────────────────────────────────── */

const load = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
};

function save(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  driveToken = null;
  known = null;
}

/** Who is signed in, from the access token. Only decoded here; iam verifies it. */
export function account() {
  const session = load();
  if (!session) return null;
  try {
    const claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { id: claims.sub, email: claims.email || '' };
  } catch {
    return null;
  }
}

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const redirectUri = () => location.origin + location.pathname;

let endpoints = null;
async function oidc() {
  endpoints ??= fetch(`${IAM.supabaseUrl}/auth/v1/.well-known/openid-configuration`)
    .then(res => {
      if (!res.ok) throw new Error('Sign In is unavailable right now.');
      return res.json();
    })
    .catch(err => { endpoints = null; throw err; });
  return endpoints;
}

async function tokenRequest(params) {
  const res = await fetch((await oidc()).token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: IAM.clientId, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `Sign In failed (${res.status})`);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: Date.now() / 1000 + (Number(body.expires_in) || 3600),
  };
}

export async function signIn() {
  if (!configured()) throw new Error('Backups are not set up on this copy of Tasks.');
  const verifier = random();
  const state = random();
  sessionStorage.setItem(FLOW_KEY, JSON.stringify({ verifier, state }));
  const url = new URL((await oidc()).authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: IAM.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state,
    code_challenge: b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    code_challenge_method: 'S256',
  });
  location.assign(url);
}

/** Sign out here and end the session on iam, so a copied token stops working too. */
export async function signOut() {
  const session = load();
  save(null);
  if (session) {
    await fetch(`${IAM.url}/api/google/signout`, {
      method: 'POST', headers: { authorization: `Bearer ${session.access_token}` },
    }).catch(() => {});
  }
}

let refreshing = null;

/** The session, refreshed first when it is about to run out; null when signed out. */
async function current() {
  const session = load();
  if (!session || session.expires_at - 60 > Date.now() / 1000) return session;
  if (!session.refresh_token) return save(null), null;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
    .then(fresh => {
      const next = { ...fresh, refresh_token: fresh.refresh_token ?? session.refresh_token };
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      return next;
    }, () => (save(null), null))
    .finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Finish a Sign In if iam just sent the person back here (?code=…&state=…).
 * Returns an error to show, or null.
 */
export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  const pending = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null');
  sessionStorage.removeItem(FLOW_KEY);
  history.replaceState(null, '', redirectUri() + location.hash);
  if (params.has('error')) return params.get('error_description') ?? params.get('error');
  if (!pending || pending.state !== params.get('state')) return 'That Sign In expired. Please try again.';
  try {
    save(await tokenRequest({
      grant_type: 'authorization_code', code: params.get('code'),
      redirect_uri: redirectUri(), code_verifier: pending.verifier,
    }));
    return null;
  } catch (err) {
    return err.message;
  }
}

/* ── Google, through iam ───────────────────────────────────── */

async function iam(path, method = 'GET') {
  const session = await current();
  if (!session) throw new Error('Sign in with your ivx account first.');
  const res = await fetch(`${IAM.url}/api/google${path}`, {
    method, headers: { authorization: `Bearer ${session.access_token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    save(null);
    throw new Error('Your ivx session has ended. Sign in again.');
  }
  if (!res.ok) {
    const err = new Error(body.error || `iam.ivx.run answered ${res.status}`);
    err.code = body.code;
    throw err;
  }
  return body;
}

let known = null;   // { at, answer }: the last status, for a minute

/** Whether Google Drive is connected for ivx apps: { connected, email }. */
export function googleStatus() {
  if (known && Date.now() - known.at < 60_000) return known.answer;
  const answer = iam('/status');
  known = { at: Date.now(), answer };
  answer.catch(() => { known = null; });
  return answer;
}

/** Where the person connects Google Drive. */
export const connectUrl = () => `${IAM.url}/account#google`;

let driveToken = null;   // { token, until }

async function drive(url, init = {}) {
  if (!driveToken || driveToken.until < Date.now() + 60_000) {
    const { access_token, expires_in } = await iam('/token', 'POST');
    driveToken = { token: access_token, until: Date.now() + (Number(expires_in) || 3600) * 1000 };
  }
  const res = await fetch(url, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${driveToken.token}` },
  });
  if (res.status === 401) driveToken = null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Google Drive answered ${res.status}`);
  }
  return res;
}

/** The backup file this ivx account made in Drive, if there is one. */
async function findFile() {
  const q = "appProperties has { key='ivx' and value='tasks-backup' } and trashed=false";
  const res = await drive(`${DRIVE}/files?${new URLSearchParams({
    q, spaces: 'drive', orderBy: 'modifiedTime desc', pageSize: '1', fields: 'files(id,modifiedTime,size)',
  })}`);
  return (await res.json()).files?.[0] || null;
}

/* ── sealing ───────────────────────────────────────────────── */

const enc = new TextEncoder();
const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const ROUNDS = 600_000;

async function passKey(passphrase, salt, rounds) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Everything in Tasks as one file's text, sealed with `passphrase` if given. */
export async function pack(passphrase = '') {
  const records = store.everything();
  const head = { ivx: 'tasks-backup', v: 1, at: new Date().toISOString() };
  if (!passphrase) return JSON.stringify({ ...head, records });
  const data = JSON.stringify({ records });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, ROUNDS), enc.encode(data));
  return JSON.stringify({ ...head, sealed: { kdf: 'PBKDF2-SHA256', rounds: ROUNDS, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) } });
}

/** A backup's text, opened and merged into Tasks. Returns how many records changed. */
export async function unpack(text, passphrase = '') {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('That is not a Tasks backup.'); }
  if (file?.ivx !== 'tasks-backup') throw new Error('That is not a Tasks backup.');
  let records = file.records;
  if (file.sealed) {
    if (!passphrase) throw new Error('This backup is locked with a passphrase. Enter it in Settings, then restore again.');
    const s = file.sealed;
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) },
        await passKey(passphrase, unb64(s.salt), s.rounds || ROUNDS), unb64(s.data));
      ({ records } = JSON.parse(new TextDecoder().decode(pt)));
    } catch {
      throw new Error('That passphrase does not open this backup.');
    }
  }
  if (!Array.isArray(records)) throw new Error('That backup is damaged.');
  const { touched, removed } = await store.applyRemote(records);
  return touched.size + removed.size;
}

/* ── Drive ─────────────────────────────────────────────────── */

/** Upload a backup, replacing the last one (Drive keeps it as a version). */
export async function backUp(passphrase = '') {
  const body = await pack(passphrase);
  const existing = await findFile();
  if (existing) {
    await drive(`${UPLOAD}/files/${existing.id}?uploadType=media`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    });
  } else {
    const boundary = `ivx${random()}`;
    const meta = { name: FILE_NAME, mimeType: 'application/json', appProperties: { ivx: 'tasks-backup' } };
    await drive(`${UPLOAD}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
        + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`,
    });
  }
  return Date.now();
}

/** Merge the latest backup from Drive. Returns how many records changed. */
export async function restore(passphrase = '') {
  const file = await findFile();
  if (!file) throw new Error('There is no Tasks backup in this Google Drive yet.');
  const res = await drive(`${DRIVE}/files/${file.id}?alt=media`);
  return unpack(await res.text(), passphrase);
}
