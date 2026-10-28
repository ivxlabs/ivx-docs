// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Sync between two browsers on the same network, directly, with no server.

   Two browsers can talk to each other over a WebRTC data channel, but
   neither can find the other or open that channel by itself: each needs a
   short description of the other first (its ICE credentials, its DTLS
   certificate fingerprint and its addresses on the network). With no server
   to carry those, the person does, in two steps:

     1. One device shows a code, as a QR code and as text. It is also a
        link, so a phone's camera app opens the page straight into it.
     2. The other takes that code and shows a reply code, which the first
        device scans or has pasted in. The channel opens.

   That is the whole handshake, and it happens in front of the person: the
   codes carry each side's certificate fingerprint, so the channel that opens
   is with the device they scanned and nobody else, and DTLS encrypts it.

   No STUN or TURN servers are given to WebRTC, so the only addresses either
   side offers are its own on the local network (browsers hide even those
   behind random .local names, which the other device resolves on the same
   network). Two devices on different networks cannot connect at all.

   Once open, each side asks the other for everything changed since it last
   synced with that device ("after rev N") and merges it with whatever the
   app's store decides; while both pages stay open, every change is offered
   to the other side as it happens. A short drop, a Wi-Fi blip, is ridden
   out: the connection comes back by itself if the network does, with the
   same addresses. Anything longer, or closing either page, ends it, and the
   next sync starts with a new code. It cannot reconnect by itself later:
   what a code describes (a random port, a random .local name) exists only
   for that one connection, and browsers cannot listen on a fixed one, so
   without a server the person carrying the codes is the only way the two
   can find each other again. What is kept is who they have synced with and
   when, so the app can offer to.

   The app hands over its store through configure(); see there. */

const VERSION = 1;
const PREFIX = 'IVX1';
const KV_DEVICE = 'p2p.device';
const KV_CURSORS = 'p2p.cursors';
const KV_KNOWN = 'p2p.known';
/** How long a code waits for its answer. */
const CODE_LIFETIME = 10 * 60_000;
/** How long the channel may take to open once both codes are in. */
const CONNECT_TIMEOUT = 30_000;
/** One frame on the channel; anything longer is sent in pieces. */
const FRAME = 16_000;
const BATCH = 200;

const enc = new TextEncoder();
const dec = new TextDecoder();

let app = '';
let kv = null;
let store = null;
let deviceName = () => 'Device';
let hooks = {};

const state = { device: null, sessions: [] };
const listeners = new Set();
let cursors = {};
let known = {};   // device id -> { name, lastSync }: everyone this device has synced with
let nextId = 1;

/**
 * Tell the engine what it syncs. Once, before init().
 *
 *   app    which app this is; codes from another app are refused
 *   kv     { get(key, fallback), set(key, value) } for this device's own state
 *   store  setDevice(id)               the id to stamp local writes with
 *          onChange(fn)                call fn after any write
 *          changesSince(rev, limit)    → { records, upTo, more }, oldest first,
 *                                        each record with `rev` and `by`
 *          applyRemote(records)        → { touched, removed }
 *   deviceName  a function giving a first name for this device
 */
export function configure(options) {
  ({ app, kv, store } = options);
  if (options.deviceName) deviceName = options.deviceName;
}

/** Load this device's identity. `hooks.onApplied(result)` follows every merge. */
export async function init(h = {}) {
  hooks = h;
  state.device = await kv.get(KV_DEVICE, null);
  if (!state.device?.id) {
    state.device = { id: crypto.randomUUID(), name: deviceName() };
    await kv.set(KV_DEVICE, state.device);
  }
  store.setDevice(state.device.id);
  cursors = await kv.get(KV_CURSORS, {});
  known = await kv.get(KV_KNOWN, {});

  // A closed tab does not close its channel; the other side would only
  // notice when it timed out. Saying so makes it notice at once.
  addEventListener('pagehide', () => {
    for (const s of state.sessions) if (s.open) s.dc.send(JSON.stringify({ t: 'bye' }));
  });

  let timer = null;
  store.onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const s of state.sessions) if (s.peer && s.open) send(s, { t: 'poke' });
    }, 300);
  });
  emit();
}

export const supported = () => typeof RTCPeerConnection === 'function';

export async function rename(name) {
  const clean = String(name || '').trim().slice(0, 64);
  if (!clean || clean === state.device.name) return;
  state.device = { ...state.device, name: clean };
  await kv.set(KV_DEVICE, state.device);
  emit();
}

/* ── state for the UI ──────────────────────────────────────── */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* the listener's problem */ }
  }
}

/**
 * `known`: the devices this one has synced with, most recent first, each
 * { id, name, lastSync, connected }.
 *
 * Every session: { id, role: 'host'|'join', stage, peerName, code, error, lastSync, shaky }.
 * `shaky` while the connection has dropped and may yet come back.
 *   host:  'making' → 'waiting' (show code) → 'connecting' → 'open'
 *   join:  'making' → 'replying' (show reply) → 'open'
 * and 'closed' or 'failed' at the end.
 */
export function status() {
  return {
    supported: supported(),
    device: state.device,
    sessions: state.sessions.map(s => ({
      id: s.id, role: s.role, stage: s.stage, peerName: s.peer?.name || s.peerName || '',
      code: s.code, error: s.error, lastSync: s.lastSync, syncing: s.pulling, shaky: s.shaky,
    })),
    known: Object.entries(known)
      .map(([id, d]) => ({ id, ...d, connected: state.sessions.some(x => x.open && x.peer?.id === id) }))
      .sort((a, b) => b.lastSync - a.lastSync),
  };
}

/** Forget a device: it is no longer offered for syncing. What it sent stays. */
export async function forget(id) {
  delete known[id];
  delete cursors[id];
  await kv.set(KV_KNOWN, known);
  await kv.set(KV_CURSORS, cursors);
  emit();
}

async function remember(peer, lastSync) {
  known[peer.id] = { name: peer.name, lastSync: lastSync || known[peer.id]?.lastSync || 0 };
  await kv.set(KV_KNOWN, known);
}

/* ── codes ─────────────────────────────────────────────────── */

const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/* Browsers hide their addresses behind names like 1f0e…-….local, a UUID:
   sent as its 16 bytes instead, it keeps the QR code smaller. */
const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

function shortHost(address) {
  const m = address.match(UUID_LOCAL);
  if (!m) return address;
  const hex = m.slice(1).join('');
  return `~${b64url(Uint8Array.from(hex.match(/../g), x => parseInt(x, 16)))}`;
}

function longHost(address) {
  if (!String(address).startsWith('~')) return address;
  const hex = [...unb64url(address.slice(1))].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
}

/** The parts of a session description that the other side cannot know. */
function compact(sdp) {
  const get = re => sdp.match(re)?.[1]?.trim();
  const fingerprint = get(/^a=fingerprint:sha-256 (.+)$/m);
  if (!fingerprint) throw new Error('This browser offered no usable connection.');
  const candidates = [];
  for (const [, line] of sdp.matchAll(/^a=candidate:(.+)$/gm)) {
    const [, , protocol, , address, port, , type] = line.trim().split(/\s+/);
    if (protocol.toLowerCase() === 'udp' && type === 'host') candidates.push([shortHost(address), Number(port)]);
  }
  return {
    u: get(/^a=ice-ufrag:(.+)$/m),
    p: get(/^a=ice-pwd:(.+)$/m),
    f: b64url(Uint8Array.from(fingerprint.split(':'), h => parseInt(h, 16))),
    s: get(/^a=setup:(.+)$/m),
    c: candidates,
  };
}

/** A description built back from those parts: one data channel, nothing else. */
function expand(type, d) {
  const fingerprint = [...unb64url(d.f)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${d.u}`, `a=ice-pwd:${d.p}`,
    `a=fingerprint:sha-256 ${fingerprint}`, `a=setup:${d.s}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
    ...d.c.map(([address, port], i) => `a=candidate:${i + 1} 1 udp ${2122260223 - i} ${longHost(address)} ${port} typ host`),
    'a=end-of-candidates',
  ];
  return { type, sdp: `${lines.join('\r\n')}\r\n` };
}

function encode(type, description) {
  const body = {
    v: VERSION, a: app, t: type === 'offer' ? 'o' : 'a',
    n: state.device.name, ...compact(description.sdp),
  };
  return PREFIX + b64url(enc.encode(JSON.stringify(body)));
}

/** A code, from itself or from a link carrying it. */
export function readCode(text) {
  const raw = String(text || '').match(new RegExp(`${PREFIX}[A-Za-z0-9_-]+`))?.[0];
  if (!raw) throw new Error('That is not a sync code.');
  let body;
  try { body = JSON.parse(dec.decode(unb64url(raw.slice(PREFIX.length)))); } catch { throw new Error('That sync code is damaged. Try it again.'); }
  if (body.v !== VERSION) throw new Error('That code is from another version of the app. Update both, then try again.');
  if (body.a !== app) throw new Error('That code is for another app.');
  if (!body.u || !body.p || !body.f || !Array.isArray(body.c)) throw new Error('That sync code is damaged. Try it again.');
  if (!body.c.length) throw new Error('The other device offered no address on this network.');
  return { kind: body.t === 'o' ? 'offer' : 'answer', name: String(body.n || 'Another device').slice(0, 64), body };
}

/** The page's own address with a code in it, for a QR code a camera app can open. */
export const linkFor = code => `${location.origin}${location.pathname}#sync=${code}`;

/* ── sessions ──────────────────────────────────────────────── */

/** Wait for every local address to be known, since none can be sent later. */
const gathered = pc => new Promise(resolve => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
  pc.addEventListener('icegatheringstatechange', done);
  setTimeout(resolve, 4000);
});

function newSession(role, peerName = '') {
  // No ICE servers: local addresses only, so it can only ever connect on this network.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const s = { id: nextId++, role, pc, dc: null, stage: 'making', peerName, peer: null, code: '', error: '', lastSync: 0, open: false, shaky: false, pulling: false, again: false, frags: new Map() };
  state.sessions.push(s);
  pc.addEventListener('connectionstatechange', () => {
    const now = pc.connectionState;
    // Dropped, but ICE keeps checking: if the network comes back with the
    // same addresses, so does the connection, and it catches up.
    if (now === 'disconnected' && s.open) { s.shaky = true; emit(); }
    if (now === 'connected' && s.shaky) { s.shaky = false; if (s.peer) pull(s); emit(); }
    if (now === 'failed') {
      fail(s, s.open
        ? `Lost the connection to ${s.peer?.name || 'the other device'}. Reconnect when you are both on the same Wi-Fi again.`
        : 'Could not reach the other device. Both need to be on the same Wi-Fi, and some networks keep their devices apart.');
    }
    if (now === 'closed') end(s);
  });
  s.expiry = setTimeout(() => {
    if (!s.open && !['failed', 'closed'].includes(s.stage)) fail(s, 'The code was not used in time. Start again.');
  }, CODE_LIFETIME);
  emit();
  return s;
}

function fail(s, reason) {
  if (['failed', 'closed'].includes(s.stage)) return;
  s.stage = 'failed';
  s.error = reason;
  s.open = false;
  s.pc.close();
  clearTimeout(s.expiry);
  emit();
}

function end(s) {
  if (['failed', 'closed'].includes(s.stage)) return;
  s.stage = 'closed';
  s.open = false;
  s.pc.close();
  clearTimeout(s.expiry);
  emit();
}

/**
 * Start a sync from this device: returns the session, whose code the other
 * device needs. `forName` labels it while waiting, when it is meant for a
 * device synced with before.
 */
export async function host(forName = '') {
  const s = newSession('host', forName);
  try {
    wire(s, s.pc.createDataChannel('ivx-sync', { ordered: true }));
    await s.pc.setLocalDescription(await s.pc.createOffer());
    await gathered(s.pc);
    s.code = encode('offer', s.pc.localDescription);
    s.stage = 'waiting';
  } catch (err) {
    fail(s, err.message);
  }
  emit();
  return s;
}

/** Take a code: another device's to join, or the reply to one of ours. */
export async function take(text) {
  const code = readCode(text);
  if (code.kind === 'answer') {
    const s = state.sessions.find(x => x.role === 'host' && x.stage === 'waiting');
    if (!s) throw new Error('That is a reply code, but this device is not waiting for one. Start again with "Show a code".');
    s.peerName = code.name;
    s.stage = 'connecting';
    emit();
    await s.pc.setRemoteDescription(expand('answer', code.body));
    s.connectTimer = setTimeout(() => { if (!s.open) fail(s, 'Could not reach the other device. Both need to be on the same Wi-Fi.'); }, CONNECT_TIMEOUT);
    return s;
  }
  const s = newSession('join', code.name);
  try {
    s.pc.addEventListener('datachannel', e => wire(s, e.channel));
    await s.pc.setRemoteDescription(expand('offer', code.body));
    await s.pc.setLocalDescription(await s.pc.createAnswer());
    await gathered(s.pc);
    s.code = encode('answer', s.pc.localDescription);
    s.stage = 'replying';
  } catch (err) {
    fail(s, err.message);
  }
  emit();
  return s;
}

/** End a session, or clear away one that has ended. */
export function close(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  end(s);
  state.sessions = state.sessions.filter(x => x !== s);
  emit();
}

/* ── the channel ───────────────────────────────────────────── */

function wire(s, dc) {
  s.dc = dc;
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.addEventListener('open', () => {
    s.open = true;
    s.stage = 'open';
    clearTimeout(s.expiry);
    clearTimeout(s.connectTimer);
    emit();
    send(s, { t: 'hello', v: VERSION, app, device: state.device });
  });
  dc.addEventListener('close', () => end(s));
  dc.addEventListener('message', e => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'frag') {
      const parts = s.frags.get(msg.id) || [];
      parts[msg.i] = msg.d;
      s.frags.set(msg.id, parts);
      if (parts.filter(p => p !== undefined).length < msg.n) return;
      s.frags.delete(msg.id);
      try { msg = JSON.parse(parts.join('')); } catch { return; }
    }
    receive(s, msg).catch(err => console.error('sync:', err));
  });
}

let fragId = 0;

async function send(s, obj) {
  const dc = s.dc;
  if (!dc || dc.readyState !== 'open') return;
  const text = JSON.stringify(obj);
  const frames = [];
  if (text.length <= FRAME) frames.push(text);
  else {
    const id = ++fragId;
    const n = Math.ceil(text.length / FRAME);
    for (let i = 0; i < n; i++) frames.push(JSON.stringify({ t: 'frag', id, i, n, d: text.slice(i * FRAME, (i + 1) * FRAME) }));
  }
  for (const frame of frames) {
    if (dc.bufferedAmount > 1024 * 1024) {
      await new Promise(resolve => dc.addEventListener('bufferedamountlow', resolve, { once: true }));
    }
    if (dc.readyState !== 'open') return;
    dc.send(frame);
  }
}

function pull(s) {
  if (s.pulling) { s.again = true; return; }
  s.pulling = true;
  emit();
  send(s, { t: 'pull', since: cursors[s.peer.id] || 0 });
}

async function receive(s, msg) {
  if (msg.t === 'hello') {
    if (msg.app !== app || typeof msg.device?.id !== 'string') return end(s);
    s.peer = { id: msg.device.id.slice(0, 80), name: String(msg.device.name || 'Another device').slice(0, 64) };
    await remember(s.peer);
    emit();
    return pull(s);
  }
  if (msg.t === 'bye') return end(s);
  if (!s.peer) return;
  switch (msg.t) {
    case 'poke': return pull(s);
    case 'pull': {
      let since = Number(msg.since) || 0;
      for (;;) {
        const batch = await store.changesSince(since, BATCH);
        // What the asker wrote itself it already has, or something newer.
        const records = batch.records.filter(r => r.by !== s.peer.id).map(({ rev, ...r }) => r);
        await send(s, { t: 'changes', records, upTo: batch.upTo, more: batch.more });
        if (!batch.more) return;
        since = batch.upTo;
      }
    }
    case 'changes': {
      const records = Array.isArray(msg.records) ? msg.records : [];
      const result = records.length ? await store.applyRemote(records) : null;
      cursors[s.peer.id] = Math.max(cursors[s.peer.id] || 0, Number(msg.upTo) || 0);
      await kv.set(KV_CURSORS, cursors);
      if (result && (result.touched?.size || result.removed?.size)) hooks.onApplied?.(result);
      if (msg.more) return;
      s.pulling = false;
      s.lastSync = Date.now();
      await remember(s.peer, s.lastSync);
      emit();
      if (s.again) { s.again = false; pull(s); }
      return;
    }
    default:
  }
}
