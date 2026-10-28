// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Offline shell for ivx/docs, every tool at once. It only ever touches
   same-origin GET requests for the site's own files; documents are never
   fetched at all, and calls to Sign's token bridge are on another origin and
   pass straight by. */

/* Stamped in by the sw-precache plugin in vite.config.js, so the cache name
   changes whenever any asset does. */
const CACHE = 'ivx-docs-__CACHE_VERSION__';
const SHELL = __PRECACHE_MANIFEST__;

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

  // Pages are network first, so a redeploy shows up on the next load. A
  // directory URL (/sign/) is precached under its index.html, so offline it
  // falls back to that.
  if (request.mode === 'navigate') {
    const page = new URL('index.html', request.url).href;
    event.respondWith(fetch(request)
      .then(res => { if (res.ok) store(page, res); return res; })
      .catch(() => caches.match(page, MATCH).then(hit => hit || offline())));
    return;
  }

  // Everything else is a content-hashed build artefact or a PDF.js data file:
  // immutable, so cache first, filling the cache as files are first used.
  event.respondWith(caches.match(request, MATCH).then(hit => hit || fetch(request)
    .then(res => { if (res.ok && res.type === 'basic') store(request, res); return res; })
    .catch(offline)));
});

/* Tasks' reminders (src/tasks/notify.js). A click opens Tasks, or brings an
   open one forward; the Mark done and Snooze buttons go to that page to act
   on, since the tasks live in its database, not here. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { page, task } = event.notification.data || {};
  if (!page) return;
  const act = event.action || 'open';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    const open = list.find(c => c.url.split(/[?#]/)[0] === page);
    if (open) {
      open.postMessage({ type: 'ivx-task', task, act });
      return open.focus();
    }
    const url = new URL(page);
    if (task) url.search = new URLSearchParams({ task, act }).toString();
    return self.clients.openWindow(url.href);
  }));
});
