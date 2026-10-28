// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* What every page of ivx/docs shares: the type, the base styles, and the
   offline worker. Each tool lives in its own directory and imports this. */

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import './icons/icons.css';
import './site.css';

/** The site root, found from the manifest link every page carries, so it is
    right in development, at docs.ivx.run, or under any other directory. */
export const ROOT = new URL('.', document.querySelector('link[rel="manifest"]').href);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', ROOT), { scope: ROOT.pathname });
}

/** Shows `text` in the page's status line; nothing hides it. */
export function status(text = '', error = false) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', error);
}

/** Runs `task` with `label` showing, and shows any failure instead. */
export async function busy(label, task) {
  status(label);
  try {
    await task();
    status();
  } catch (err) {
    console.error(err);
    status(err.message, true);
  }
}

/** Hands `bytes` to the browser as a download called `name`. */
export function save(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
