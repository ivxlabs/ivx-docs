// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Where Tasks keeps everything: one IndexedDB database in this browser.

   Lists, tasks and the shared settings are all records in one object store,
   told apart by `kind`, and all of them are held in memory too: a to-do list
   is small, and the page reads it far more often than it writes it. Every
   write carries three stamps for sync (../sync/engine.js):

     mtime  when the record was last changed, on the changer's clock
     by     which device changed it; breaks an mtime tie
     rev    this database's own running number for the write, so a paired
            device can ask for "everything after rev N"

   A deletion leaves a tombstone with the same stamps, so it syncs too, and
   whichever of a change and a deletion happened later wins. */

const DB = 'ivx-tasks';
const KINDS = new Set(['list', 'task', 'setting', 'tombstone']);

let db = null;
let device = '';
let rev = 0;
const records = new Map();

/** Fires `change` after any write, with `detail.remote` for another device's. */
export const changes = new EventTarget();
const changed = remote => changes.dispatchEvent(new CustomEvent('change', { detail: { remote } }));

const ask = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function open() {
  if (db) return;
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('records', { keyPath: 'id' }).createIndex('rev', 'rev');
    req.result.createObjectStore('kv');
  };
  db = await ask(req);
  for (const r of await ask(db.transaction('records').objectStore('records').getAll())) {
    records.set(r.id, r);
    rev = Math.max(rev, r.rev || 0);
  }
}

export const setDevice = id => { device = id || ''; };

/* ── reading ───────────────────────────────────────────────── */

export const get = id => {
  const r = records.get(id);
  return r && r.kind !== 'tombstone' ? r : undefined;
};

export const all = kind => [...records.values()].filter(r => r.kind === kind);

/** Everything, tombstones included, for a backup. */
export const everything = () => [...records.values()];

/* ── writing ───────────────────────────────────────────────── */

function stamp(record) {
  const old = records.get(record.id);
  return { ...record, mtime: Math.max(Date.now(), (old?.mtime || 0) + 1), by: device, rev: ++rev };
}

async function write(list, remote = false) {
  if (!list.length) return;
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  for (const r of list) store.put(r);
  await done(tx);
  for (const r of list) records.set(r.id, r);
  changed(remote);
}

/** Saves records changed here: whole records, or `{ id, ...fields }` patches. */
export function put(...list) {
  return write(list.map(r => stamp({ ...records.get(r.id), ...r })));
}

/** Deletes records for good, everywhere they sync to. */
export function remove(...ids) {
  return write(ids.filter(id => get(id)).map(id => stamp({ id, kind: 'tombstone', of: records.get(id).kind })));
}

/* ── small local values ────────────────────────────────────── */

export async function kvGet(key, fallback = null) {
  const v = await ask(db.transaction('kv').objectStore('kv').get(key));
  return v === undefined ? fallback : v;
}

export async function kvSet(key, value) {
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await done(tx);
}

/* ── sync ──────────────────────────────────────────────────── */

const newer = (a, b) => a.mtime > b.mtime || (a.mtime === b.mtime && (a.by || '') > (b.by || ''));

/** What changed here after rev `since`, oldest first, at most `limit`. */
export async function changesSince(since = 0, limit = 200) {
  const index = db.transaction('records').objectStore('records').index('rev');
  const list = await ask(index.getAll(IDBKeyRange.lowerBound(since, true), limit + 1));
  const batch = list.slice(0, limit);
  return { records: batch, upTo: batch.length ? batch.at(-1).rev : since, more: list.length > limit };
}

/**
 * Takes records from another device or a backup, keeping whichever side
 * changed each one last. Anything malformed is skipped, not trusted.
 */
export async function applyRemote(list) {
  const take = [];
  const touched = new Set();
  const removed = new Set();
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 80 || !KINDS.has(r.kind)) continue;
    if (typeof r.mtime !== 'number' || !Number.isFinite(r.mtime)) continue;
    const mine = records.get(r.id);
    if (mine && !newer(r, mine)) continue;
    const { rev: _, ...rest } = r;
    take.push({ ...rest, rev: ++rev });
    (r.kind === 'tombstone' ? removed : touched).add(r.id);
  }
  await write(take, true);
  return { touched, removed, wanted: [] };
}
