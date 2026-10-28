// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Sync with other devices on the same network: the engine.

   This file knows nothing about what it syncs. The app hands it an adapter
   (see configure() below) for its records, its files and its bridge, so the
   same file drives ivx/ai Chat's chats and ivx/docs' documents. Keep it free
   of imports and app words; it is copied between the two as it is.

   A page cannot look for other devices or accept a connection, so the bridge
   does that part (ivxai-bridge's sync.rs, or ivx-docs' bridge/sync.go, which
   speak the same protocol): it announces this device, lists the others
   syncing for the same app, and relays messages between pages. It cannot
   read them. Everything that crosses the network is sealed here, with a key
   two devices agree when they are paired, and opened only on the other side.

   Pairing is a key agreement the person checks with their own eyes. One side
   commits to its key before seeing the other's, both sides derive a six-digit
   code from the exchange, and the pairing only completes once both screens
   showed the same code and both people said so. Something in the middle
   would have to make two independent codes collide, and gets one try.

   What syncs is records and files. Each record carries an id, an mtime and
   the device that wrote it, plus a rev: the local database's running number
   for the write. When two devices disagree the later change wins; that is
   the adapter's applyRemote() to decide. A device asks each peer for
   "everything since rev N" and remembers how far it got, so a sync after a
   week apart sends a week's changes and no more. Files never change once
   written, so they stay out of the change log: a record that names a file
   this device lacks makes it ask for that file by id, and it arrives in
   slices.

   Both devices need the app open for a sync to happen; there is no server in
   between to hold anything while one of them is away. */

const KV_DEVICE = 'sync.device';
const KV_ENABLED = 'sync.enabled';
const KV_PEERS = 'sync.peers';

/** Under the bridge's 4 MB per message, with room for the envelope. */
const MAX_BODY = 3_000_000;
/** One slice of a file, before sealing. */
const PART = 1_000_000;
const PULL_EVERY = 30_000;
const NEARBY_EVERY = 4_000;
const PAIR_TIMEOUT = 2 * 60_000;
const POKE_DELAY = 700;

const enc = new TextEncoder();
/* The adapter, set by configure(). */
let app = '';
let kv = null;
let store = null;
let transport = null;
let deviceName = () => 'Device';

const dec = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
  enabled: false,
  running: false,
  waiting: false,      // another tab holds sync for this browser
  error: '',
  device: null,        // { id, name }
  peers: [],           // paired: { id, name, key, pairedAt, cursor, lastSync }
  nearby: [],          // from the bridge: { id, name }
  syncing: new Set(),  // peer ids with a pull in flight
  pairing: null,
};

let hooks = {};
const listeners = new Set();
let gen = 0;           // bumped by stop(); loops from an older start give up
let release = null;    // lets go of the tab lock
let pollAbort = null;
let timers = [];

/* ── bytes ─────────────────────────────────────────────────── */

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

/* ── sealing ───────────────────────────────────────────────── */

/* The direction is bound into every message, so one sent to a peer cannot be
   bounced back at its sender as if the peer had written it. */
async function seal(key, to, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${state.device.id}>${to}`) },
    key, enc.encode(JSON.stringify(obj)));
  return { t: 'box', iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function unseal(key, from, box) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(`${from}>${state.device.id}`) },
      key, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;   // not for us, or not from who it says
  }
}

/* ── the bridge ────────────────────────────────────────────── */

/**
 * Tell the engine what it syncs, and through what. Once, before init().
 *
 *   app        which app this is, letters, digits and dashes. Devices only
 *              ever see, pair and sync with others of the same app.
 *   kv         { get(key, fallback), set(key, value) }: where the engine
 *              keeps this device's id, its peers and their keys.
 *   store      the records:
 *     setDevice(id)                 the id to stamp local writes with
 *     onChange(fn)                  call fn after any local write
 *     changesSince(rev, limit)      → { records, upTo, more }: what changed
 *                                     here after rev, oldest first, each with
 *                                     its `rev` and `by`. Leave out anything
 *                                     not ready to share; a later write gives
 *                                     it a new rev.
 *     applyRemote(records)          → { touched, removed, wanted }: wanted
 *                                     is the ids of files the records name
 *                                     and this device lacks
 *     missingFiles()                → ids of files named but never arrived
 *     readFile(id)                  → the file as a string, or null
 *     writeFile(id, text)           → { touched, removed } if it was taken,
 *                                     or null
 *   transport  the bridge:
 *     available()                   whether it can sync at all
 *     unavailable()                 a sentence saying why not
 *     recheck()                     a promise; look for the bridge again
 *     url(path, headers)            → [url, headers] for one of its routes
 *   deviceName  a function giving a first name for this device
 */
export function configure(adapter) {
  ({ app, kv, store, transport } = adapter);
  if (adapter.deviceName) deviceName = adapter.deviceName;
}

/** Whether this page has a bridge that can do it at all. */
export function available() {
  return Boolean(transport?.available());
}

async function call(path, { method = 'GET', body, signal } = {}) {
  const [url, headers] = transport.url(path, body ? { 'Content-Type': 'application/json' } : {});
  if (!url) throw new Error('No bridge is running for this page.');
  const res = await fetch(url, {
    method, headers, signal, cache: 'no-store',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error?.message || (res.status === 404
      ? 'This bridge is too old for sync. Update it.'
      : `The bridge answered ${res.status}.`));
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Hand one message to a device, waiting out a full inbox a few times. */
async function deliver(to, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call('/sync/send', { method: 'POST', body: { to, body } });
    } catch (err) {
      if (err.status !== 503 || attempt >= 4) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
}

const sendPlain = (to, obj) => deliver(to, JSON.stringify(obj));

async function send(peer, obj) {
  return deliver(peer.id, JSON.stringify(await seal(peer.key, peer.id, obj)));
}

/* ── state for the UI ──────────────────────────────────────── */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener's problem is not sync's */ }
  }
}

const nearbyIds = () => new Set(state.nearby.map(p => p.id));

export function status() {
  const near = nearbyIds();
  const paired = new Set(state.peers.map(p => p.id));
  const p = state.pairing;
  return {
    available: available(),
    enabled: state.enabled,
    running: state.running,
    waiting: state.waiting,
    error: state.error,
    device: state.device,
    peers: state.peers.map(peer => ({
      id: peer.id, name: peer.name, pairedAt: peer.pairedAt, lastSync: peer.lastSync || 0,
      online: near.has(peer.id), syncing: state.syncing.has(peer.id),
    })),
    nearby: state.nearby.filter(n => !paired.has(n.id)),
    pairing: p && {
      stage: p.stage, role: p.role, peerName: p.peerName, code: p.code,
      confirmed: p.localOk, reason: p.reason,
    },
  };
}

/* ── persistence ───────────────────────────────────────────── */

const savePeers = () => kv.set(KV_PEERS, state.peers);

/**
 * Load what this device knows and, if sync was left on, start it.
 *
 * `hooks.onApplied({ touched, removed })` is called after records change
 * because of another device; `hooks.onPairRequest({ name })` when one asks to
 * pair.
 */
export async function init(h = {}) {
  hooks = h;
  if (!store) throw new Error('sync: configure() comes before init().');
  state.device = await kv.get(KV_DEVICE, null);
  if (!state.device?.id) {
    state.device = { id: randomId(), name: deviceName() };
    await kv.set(KV_DEVICE, state.device);
  }
  store.setDevice(state.device.id);
  state.peers = (await kv.get(KV_PEERS, [])).filter(p => p?.id && p.key);
  state.enabled = Boolean(await kv.get(KV_ENABLED, false));

  let pokeTimer = null;
  store.onChange(() => {
    if (!state.running) return;
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(pokeAll, POKE_DELAY);
  });

  if (state.enabled) start();
}

export async function setEnabled(on) {
  state.enabled = Boolean(on);
  await kv.set(KV_ENABLED, state.enabled);
  if (state.enabled) await start();
  else await stop();
  emit();
}

export async function rename(name) {
  const clean = String(name || '').trim().slice(0, 64);
  if (!clean || clean === state.device.name) return;
  state.device = { ...state.device, name: clean };
  await kv.set(KV_DEVICE, state.device);
  // Re-announce under the new name; the bridge treats a same-id start as an update.
  if (state.running) await call('/sync/start', { method: 'POST', body: announce() }).catch(() => {});
  emit();
}

/* ── running ───────────────────────────────────────────────── */

const announce = () => ({ app, ...state.device });

/* One tab per browser does the syncing. Two would each take half of the
   messages off the bridge and both get confused; the lock makes the second
   wait its turn, and it takes over the moment the first tab closes. */
async function start() {
  if (state.running || state.waiting || !state.enabled) return;
  if (!available()) {
    state.error = transport.unavailable();
    emit();
    // The bridge may simply not be started yet; look again in a while.
    const mine = gen;
    setTimeout(() => {
      if (mine === gen && state.enabled && !state.running) transport.recheck().then(() => start());
    }, 30_000);
    return;
  }
  const mine = ++gen;
  state.waiting = true;
  emit();

  const run = async () => {
    state.waiting = false;
    if (mine !== gen) return;
    try {
      await call('/sync/start', { method: 'POST', body: announce() });
    } catch (err) {
      state.error = err.message;
      emit();
      setTimeout(() => { if (mine === gen && state.enabled) start(); }, 15_000);
      return;
    }
    state.running = true;
    state.error = '';
    emit();
    loop(mine);
    timers.push(setInterval(() => refreshNearby(mine), NEARBY_EVERY));
    timers.push(setInterval(() => syncAll(), PULL_EVERY));
    await refreshNearby(mine);
    syncAll();
    await new Promise(resolve => { release = resolve; });
  };

  if (navigator.locks?.request) navigator.locks.request(`ivx-sync-${app}`, run).catch(() => {});
  else run();
}

async function stop() {
  const wasRunning = state.running;
  gen++;
  timers.forEach(clearInterval);
  timers = [];
  pollAbort?.abort();
  release?.();
  release = null;
  state.running = false;
  state.waiting = false;
  state.nearby = [];
  state.syncing.clear();
  if (state.pairing) failPairing('Sync was turned off.');
  if (wasRunning) await call('/sync/stop', { method: 'POST', body: {} }).catch(() => {});
  emit();
}

async function loop(mine) {
  while (mine === gen) {
    pollAbort = new AbortController();
    let messages = [];
    try {
      ({ messages = [] } = await call('/sync/poll', { signal: pollAbort.signal }));
    } catch (err) {
      if (mine !== gen) return;
      if (err.status === 409) {
        // The bridge restarted and forgot us; announce again.
        await call('/sync/start', { method: 'POST', body: announce() }).catch(() => {});
      }
      await sleep(3000);
      continue;
    }
    for (const m of messages) {
      if (mine !== gen) return;
      try { await receive(m); } catch { /* one bad message must not stop the rest */ }
    }
  }
}

async function refreshNearby(mine) {
  if (mine !== gen) return;
  let peers;
  try {
    ({ peers = [] } = await call('/sync/peers'));
  } catch {
    return;
  }
  const before = nearbyIds();
  const was = JSON.stringify(state.nearby);
  state.nearby = peers.map(p => ({ id: p.id, name: p.name || 'Unnamed device' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let renamed = false;
  for (const peer of state.peers) {
    const seen = state.nearby.find(n => n.id === peer.id);
    if (seen && seen.name !== peer.name) { peer.name = seen.name; renamed = true; }
    // Back in range: catch up straight away rather than at the next tick.
    if (seen && !before.has(peer.id)) pull(peer);
  }
  if (renamed) savePeers();
  if (renamed || JSON.stringify(state.nearby) !== was) emit();
}

function syncAll() {
  const near = nearbyIds();
  for (const peer of state.peers) if (near.has(peer.id)) pull(peer);
}

export function syncNow() {
  syncAll();
}

function pull(peer) {
  if (state.syncing.has(peer.id)) return;
  state.syncing.add(peer.id);
  emit();
  send(peer, { t: 'pull', since: peer.cursor || 0 }).catch(() => {
    state.syncing.delete(peer.id);
    emit();
  });
  // A peer that went quiet mid-sync must not block the next attempt forever.
  setTimeout(() => { if (state.syncing.delete(peer.id)) emit(); }, 60_000);
}

function pokeAll() {
  const near = nearbyIds();
  for (const peer of state.peers) {
    if (near.has(peer.id)) send(peer, { t: 'poke' }).catch(() => {});
  }
}

/* ── incoming ──────────────────────────────────────────────── */

async function receive({ from, name, body }) {
  let msg;
  try { msg = JSON.parse(body); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.t !== 'box') return pairingMessage(from, name, msg);

  const peer = state.peers.find(p => p.id === from);
  const p = state.pairing;
  if (p?.key && p.peerId === from) {
    const inner = await unseal(p.key, from, msg);
    if (inner?.t === 'pair-ok' && inner.sid === p.sid) return remoteConfirmed();
    if (inner && !peer) return;   // nothing else is accepted before pairing completes
  }
  if (!peer) return;
  const inner = await unseal(peer.key, from, msg);
  if (!inner) return;

  switch (inner.t) {
    case 'pull': return servePull(peer, Number(inner.since) || 0);
    case 'poke': return pull(peer);
    case 'changes': return takeChanges(peer, inner);
    case 'file-get': serveFiles(peer, inner.ids || []); return;
    case 'file-part': return takePart(inner);
    case 'file-none': incoming.delete(inner.id); return;
    case 'unpair': return forget(peer.id, false);
    default:
  }
}

async function servePull(peer, since) {
  let limit = 200;
  for (;;) {
    const batch = await store.changesSince(since, limit);
    // What the asker wrote itself it already has, or something newer.
    const records = batch.records
      .filter(r => r.by !== peer.id)
      .map(({ rev, ...r }) => r);
    const body = JSON.stringify(await seal(peer.key, peer.id,
      { t: 'changes', records, upTo: batch.upTo, more: batch.more }));
    if (body.length <= MAX_BODY) return deliver(peer.id, body);
    if (limit > 1) { limit = Math.max(1, limit >> 1); continue; }
    // One record too big to carry at all. Skip it rather than wedge every
    // sync behind it.
    return send(peer, { t: 'changes', records: [], upTo: batch.upTo, more: batch.more });
  }
}

const healed = new Set();   // peers asked for every missing file this session

async function takeChanges(peer, { records = [], upTo = 0, more = false }) {
  const result = records.length
    ? await store.applyRemote(records)
    : { touched: new Set(), removed: new Set(), wanted: [] };
  peer.cursor = Math.max(peer.cursor || 0, Number(upTo) || 0);
  peer.lastSync = Date.now();
  await savePeers();
  if (result.touched?.size) hooks.onApplied?.(result);
  if (result.wanted?.length) askFiles(peer, result.wanted);

  if (more) {
    send(peer, { t: 'pull', since: peer.cursor }).catch(() => {
      state.syncing.delete(peer.id);
      emit();
    });
    return;
  }
  state.syncing.delete(peer.id);
  emit();
  // Files a message names but never arrived — the sender was mid-save, or
  // the transfer was cut off — are asked for again once per session.
  if (!healed.has(peer.id)) {
    healed.add(peer.id);
    const missing = await store.missingFiles();
    if (missing.length) askFiles(peer, missing);
  }
}

/* ── files ─────────────────────────────────────────────────── */

/* Files are not part of the change log: they never change, and they live and
   die with the records that name them. A device that takes a record naming a
   file it lacks asks for it by id, and it arrives in slices. */
const incoming = new Map();   // id -> { parts, got, asked }

function askFiles(peer, ids) {
  const now = Date.now();
  const fresh = ids.filter(id => {
    const pending = incoming.get(id);
    return !pending || now - pending.asked > 120_000;
  });
  for (const id of fresh) incoming.set(id, { parts: [], got: 0, asked: now });
  for (let i = 0; i < fresh.length; i += 16) {
    send(peer, { t: 'file-get', ids: fresh.slice(i, i + 16) }).catch(() => {});
  }
}

async function serveFiles(peer, ids) {
  for (const id of ids.slice(0, 64)) {
    try {
      const text = await store.readFile(id);
      if (typeof text !== 'string') { await send(peer, { t: 'file-none', id }); continue; }
      const n = Math.max(1, Math.ceil(text.length / PART));
      for (let i = 0; i < n; i++) {
        await send(peer, { t: 'file-part', id, i, n, data: text.slice(i * PART, (i + 1) * PART) });
      }
    } catch {
      return;   // the peer left; it asks again next time
    }
  }
}

async function takePart({ id, i, n, data }) {
  const slot = incoming.get(id);
  if (!slot || typeof data !== 'string' || !(i >= 0 && i < n) || n > 10_000) return;
  if (slot.parts[i] === undefined) slot.got++;
  slot.parts[i] = data;
  if (slot.got < n) return;
  incoming.delete(id);
  const result = await store.writeFile(id, slot.parts.join('')).catch(() => null);
  if (result?.touched?.size) hooks.onApplied?.({ removed: new Set(), wanted: [], ...result });
}

/* ── pairing ───────────────────────────────────────────────── */

/* Initiator A, responder B:
     A → B  pair-req     { sid, commit: H(pubA) }
     B → A  pair-key     { sid, pubB }               once B's person accepts
     A → B  pair-reveal  { sid, pubA }               B checks it against the commit
   Both derive the key and the code from the ECDH secret and the transcript,
   show the code, and send a sealed pair-ok when their person confirms it. */

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const lastDeclined = new Map();   // id -> when, so one device cannot nag

async function keypair() {
  const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { kp, pub };
}

async function derive(p, theirPub) {
  const peerKey = await crypto.subtle.importKey('raw', theirPub, ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, p.kp.privateKey, 256);
  const [pubA, pubB] = p.role === 'init' ? [p.pub, theirPub] : [theirPub, p.pub];
  const [idA, idB] = p.role === 'init' ? [state.device.id, p.peerId] : [p.peerId, state.device.id];
  const transcript = await sha256(concat(pubA, pubB, enc.encode(`${app}|${idA}|${idB}`)));
  const n = new DataView(transcript.buffer).getUint32(0) % 1_000_000;
  p.code = String(n).padStart(6, '0').replace(/^(\d{3})/, '$1 ');
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  p.key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: transcript, info: enc.encode(`ivx-sync/1 ${app}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  p.stage = 'confirm';
  emit();
}

function newSession(fields) {
  const p = { sid: randomId(), stage: 'asking', localOk: false, remoteOk: false, ...fields };
  p.timer = setTimeout(() => {
    if (state.pairing === p && p.stage !== 'done') failPairing('No answer in time.');
  }, PAIR_TIMEOUT);
  state.pairing = p;
  emit();
  return p;
}

function failPairing(reason, tell = false) {
  const p = state.pairing;
  if (!p) return;
  clearTimeout(p.timer);
  if (tell) sendPlain(p.peerId, { t: 'pair-no', sid: p.sid }).catch(() => {});
  p.stage = 'failed';
  p.reason = reason;
  emit();
}

/** Ask a device nearby to pair. */
export async function pair(peerId) {
  if (!state.running) throw new Error('Turn sync on first.');
  if (state.pairing && !['done', 'failed'].includes(state.pairing.stage)) {
    throw new Error('Already pairing with another device.');
  }
  const target = state.nearby.find(n => n.id === peerId);
  if (!target) throw new Error('That device is not nearby any more.');
  const { kp, pub } = await keypair();
  const p = newSession({ role: 'init', peerId, peerName: target.name, kp, pub });
  try {
    await sendPlain(peerId, { t: 'pair-req', sid: p.sid, commit: b64(await sha256(pub)) });
  } catch (err) {
    failPairing(err.message);
  }
}

export async function acceptPair() {
  const p = state.pairing;
  if (!p || p.role !== 'resp' || p.stage !== 'asked') return;
  Object.assign(p, await keypair(), { stage: 'keying' });
  emit();
  try {
    await sendPlain(p.peerId, { t: 'pair-key', sid: p.sid, pub: b64(p.pub) });
  } catch (err) {
    failPairing(err.message);
  }
}

export function declinePair() {
  const p = state.pairing;
  if (!p || ['done', 'failed'].includes(p.stage)) return;
  if (p.role === 'resp') lastDeclined.set(p.peerId, Date.now());
  failPairing('Declined.', true);
}

/** The person's verdict on the code. */
export async function confirmCode(match) {
  const p = state.pairing;
  if (!p || p.stage !== 'confirm') return;
  if (!match) return failPairing('The codes did not match, so nothing was paired.', true);
  p.localOk = true;
  emit();
  try {
    await deliver(p.peerId, JSON.stringify(await seal(p.key, p.peerId, { t: 'pair-ok', sid: p.sid })));
  } catch (err) {
    return failPairing(err.message);
  }
  if (p.remoteOk) finishPairing();
}

export function dismissPairing() {
  const p = state.pairing;
  if (p && !['done', 'failed'].includes(p.stage)) failPairing('Cancelled.', true);
  state.pairing = null;
  emit();
}

function remoteConfirmed() {
  const p = state.pairing;
  if (p.stage !== 'confirm') return;
  p.remoteOk = true;
  if (p.localOk) finishPairing();
  else emit();
}

async function finishPairing() {
  const p = state.pairing;
  clearTimeout(p.timer);
  state.peers = state.peers.filter(x => x.id !== p.peerId);
  const peer = { id: p.peerId, name: p.peerName, key: p.key, pairedAt: Date.now(), cursor: 0, lastSync: 0 };
  state.peers.push(peer);
  await savePeers();
  p.stage = 'done';
  emit();
  pull(peer);
}

async function pairingMessage(from, name, msg) {
  const p = state.pairing;
  const live = p && !['done', 'failed'].includes(p.stage);

  if (msg.t === 'pair-req') {
    if (typeof msg.commit !== 'string' || typeof msg.sid !== 'string') return;
    // One conversation at a time, and no re-asking straight after a no.
    if (live || Date.now() - (lastDeclined.get(from) || 0) < 30_000) {
      return sendPlain(from, { t: 'pair-no', sid: msg.sid }).catch(() => {});
    }
    clearTimeout(p?.timer);
    const session = newSession({ role: 'resp', peerId: from, peerName: name || 'A device', commit: msg.commit, stage: 'asked' });
    session.sid = msg.sid;
    hooks.onPairRequest?.({ name: session.peerName });
    return;
  }

  if (!live || p.peerId !== from || msg.sid !== p.sid) return;

  if (msg.t === 'pair-no') return failPairing(p.role === 'init' ? 'The other device said no.' : 'The other device cancelled.');

  if (msg.t === 'pair-key' && p.role === 'init' && p.stage === 'asking') {
    let theirs;
    try { theirs = unb64(msg.pub); } catch { return failPairing('The other device sent a broken key.', true); }
    p.stage = 'keying';
    await sendPlain(from, { t: 'pair-reveal', sid: p.sid, pub: b64(p.pub) }).catch(err => failPairing(err.message));
    if (p.stage === 'keying') await derive(p, theirs).catch(() => failPairing('Could not agree a key.', true));
    return;
  }

  if (msg.t === 'pair-reveal' && p.role === 'resp' && p.stage === 'keying') {
    let theirs;
    try { theirs = unb64(msg.pub); } catch { return failPairing('The other device sent a broken key.', true); }
    // The key must be the one committed to before ours was sent; otherwise
    // whoever sent it chose it after seeing ours, and the code proves nothing.
    if (b64(await sha256(theirs)) !== p.commit) return failPairing('The other device changed its key mid-way. Nothing was paired.', true);
    await derive(p, theirs).catch(() => failPairing('Could not agree a key.', true));
  }
}

/* ── forgetting ────────────────────────────────────────────── */

async function forget(id, tell) {
  const peer = state.peers.find(p => p.id === id);
  if (!peer) return;
  if (tell && nearbyIds().has(id)) await send(peer, { t: 'unpair' }).catch(() => {});
  state.peers = state.peers.filter(p => p.id !== id);
  state.syncing.delete(id);
  await savePeers();
  emit();
}

/** Stop syncing with a device. What was already copied stays on both. */
export const unpair = id => forget(id, true);
