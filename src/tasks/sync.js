// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Tasks sync with this person's other browsers on the same network.

   ../sync/p2p.js does the work, browser to browser over WebRTC with no
   server in between; this tells it what to sync: every record in store.js,
   which is lists, tasks, deletions and the clean-up settings. */

import * as store from './store.js';
import * as p2p from '../sync/p2p.js';

export { supported, subscribe, status, rename, host, take, close, forget, linkFor, readCode } from '../sync/p2p.js';

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

p2p.configure({
  app: 'ivx-tasks',
  deviceName,
  kv: { get: store.kvGet, set: store.kvSet },
  store: {
    setDevice: store.setDevice,
    onChange: fn => store.changes.addEventListener('change', fn),
    changesSince: store.changesSince,
    applyRemote: store.applyRemote,
  },
});

export const init = hooks => p2p.init(hooks);
