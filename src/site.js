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

/* ── background colour ─────────────────────────────────────── */

const BACKGROUND_KEY = 'ivx-docs-background';

/** Material Design's darkest shades: light text reads well on every one. */
export const BACKGROUNDS = [
  ['#000000', 'Black'], ['#212121', 'Grey'], ['#263238', 'Blue grey'], ['#3e2723', 'Brown'],
  ['#b71c1c', 'Red'], ['#880e4f', 'Pink'], ['#4a148c', 'Purple'], ['#311b92', 'Deep purple'],
  ['#1a237e', 'Indigo'], ['#0d47a1', 'Blue'], ['#01579b', 'Light blue'], ['#006064', 'Cyan'],
  ['#004d40', 'Teal'], ['#1b5e20', 'Green'], ['#33691e', 'Light green'], ['#bf360c', 'Deep orange'],
];

/** Use `colour` as the background on every page, or '' to follow the system again. */
export function setBackground(colour) {
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (colour) {
    localStorage.setItem(BACKGROUND_KEY, colour);
    root.dataset.bg = colour;
    root.style.setProperty('--chosen', colour);
  } else {
    localStorage.removeItem(BACKGROUND_KEY);
    delete root.dataset.bg;
    root.style.removeProperty('--chosen');
  }
  if (meta) meta.content = colour || '#0a0a0a';
}

/* A palette button in the page's bar, opening the colours as a popover.
   The choice is stored for the whole site and applied before the page is
   drawn (public/theme.js); here it is only changed. */
function backgroundPicker() {
  const bar = document.querySelector('.bar');
  if (!bar) return;
  const icon = name => {
    const i = document.createElement('i');
    i.className = `icon icon-${name}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
  };
  const panel = Object.assign(document.createElement('div'), { id: 'backgrounds', className: 'backgrounds', popover: 'auto' });
  const swatch = (colour, name) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch', title: name });
    b.setAttribute('aria-label', name);
    b.dataset.colour = colour;
    if (colour) b.style.background = colour;
    else b.append(icon('circle-half'));
    b.addEventListener('click', () => { setBackground(colour); mark(); });
    return b;
  };
  const mark = () => {
    const current = document.documentElement.dataset.bg || '';
    for (const b of panel.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.colour === current));
  };
  const heading = Object.assign(document.createElement('p'), { className: 'backgrounds-title', textContent: 'Background' });
  const grid = Object.assign(document.createElement('div'), { className: 'swatches' });
  grid.append(swatch('', 'Match the system'), ...BACKGROUNDS.map(([c, n]) => swatch(c, n)));
  panel.append(heading, grid);
  mark();

  const open = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only', title: 'Background colour' });
  open.setAttribute('aria-label', 'Background colour');
  open.setAttribute('popovertarget', 'backgrounds');
  open.append(icon('palette'));
  const tools = bar.querySelector('.tools');
  if (tools) tools.append(open);
  else {
    open.classList.add('push-end');
    bar.append(open);
  }
  document.body.append(panel);
}

backgroundPicker();

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
