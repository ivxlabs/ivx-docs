// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* What every page of ivx/docs shares: the type, the base styles, and the
   offline worker. Each tool lives in its own directory and imports this. */

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import './site.css';

/** The site root, found from the manifest link every page carries, so it is
    right in development, at docs.ivx.run, or under any other directory. */
export const ROOT = new URL('.', document.querySelector('link[rel="manifest"]').href);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', ROOT), { scope: ROOT.pathname });
}
