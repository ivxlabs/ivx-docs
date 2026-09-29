// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Offline shell for ivx/docs Sign. It only ever touches same-origin GET
   requests for the app's own files; documents are never fetched at all, and
   calls to the token bridge are on another origin and pass straight by. */

/* Stamped in by the sw-precache plugin in vite.config.js, so the cache name
   changes whenever any asset does. */
const CACHE = 'ivxdocs-sign-__CACHE_VERSION__';
const SHELL = __PRECACHE_MANIFEST__;
const INDEX = './index.html';

// Vite's crossorigin assets carry an Origin header that install-time requests
// did not, and hosts answer with `Vary: Origin` — hence ignoreVary.
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', event => {
  // One entry at a time, so a single 404 cannot sink the whole install.
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {})))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const offline = () => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });

const store = (key, response) => {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(key, copy)).catch(() => {});
};

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // The page is network first, so a redeploy shows up on the next load.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then(res => { if (res.ok) store(INDEX, res); return res; })
      .catch(() => caches.match(INDEX, MATCH).then(hit => hit || offline())));
    return;
  }

  // Everything else is a content-hashed build artefact or a PDF.js data file:
  // immutable, so cache first, filling the cache as files are first used.
  event.respondWith(caches.match(request, MATCH).then(hit => hit || fetch(request)
    .then(res => { if (res.ok && res.type === 'basic') store(request, res); return res; })
    .catch(offline)));
});
