// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Tasks sync with this person's other browsers on the same network.

   ../sync/engine.js does the work; this tells it what to sync (every record
   in store.js: lists, tasks, deletions and the clean-up settings) and through
   what: the ivx/docs bridge (bridge/, the same program Sign uses for tokens),
   which finds the other devices and carries the sealed messages between
   them. Tasks has no files, so nothing travels in slices. */

import * as store from './store.js';
import * as engine from '../sync/engine.js';

export {
  available, subscribe, status, rename, syncNow,
  pair, acceptPair, declinePair, confirmCode, dismissPairing, unpair,
} from '../sync/engine.js';

const BRIDGE_KEY = 'ivx-docs-bridge';
export const DEFAULT_BRIDGE = 'http://127.0.0.1:47111';

export const bridgeUrl = () => (localStorage.getItem(BRIDGE_KEY) || DEFAULT_BRIDGE).replace(/\/+$/, '');

let health = null;   // what the bridge said about itself, or null when it did not answer

/** Ask the bridge whether it is there and can sync. */
export async function checkBridge() {
  try {
    const res = await fetch(`${bridgeUrl()}/health`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    health = res.ok ? await res.json() : { ok: true, sync: false };
  } catch {
    health = null;
  }
  return health;
}

export async function setBridgeUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean && clean !== DEFAULT_BRIDGE) localStorage.setItem(BRIDGE_KEY, clean);
  else localStorage.removeItem(BRIDGE_KEY);
  return checkBridge();
}

function deviceName() {
  const ua = navigator.userAgent;
  const kind = /Android/.test(ua) ? 'Android'
    : /iPad/.test(ua) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone'
        : /Mac/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows PC'
            : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${kind}`;
}

engine.configure({
  app: 'ivx-tasks',
  deviceName,
  kv: { get: store.kvGet, set: store.kvSet },
  store: {
    setDevice: store.setDevice,
    onChange: fn => store.changes.addEventListener('change', fn),
    changesSince: store.changesSince,
    applyRemote: store.applyRemote,
    missingFiles: async () => [],
    readFile: async () => null,
    writeFile: async () => null,
  },
  transport: {
    available: () => Boolean(health?.sync),
    unavailable: () => (health
      ? 'The bridge on this computer is too old for sync. Update it.'
      : 'Sync needs the ivx/docs bridge running on this device. Start it, then turn sync on again.'),
    recheck: checkBridge,
    url: (path, headers) => [bridgeUrl() + path, headers],
  },
});

/** Turn sync on or off. On looks for the bridge first: it may have been
    started since the page last asked. */
export async function setEnabled(on) {
  if (on) await checkBridge();
  return engine.setEnabled(on);
}

/** Look for the bridge, then load what this device knows and resume sync if it was on. */
export async function init(hooks) {
  await checkBridge();
  return engine.init(hooks);
}
