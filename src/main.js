// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/docs Sign. The document's bytes are the only state: placing, removing
   and signing a field each append a revision and re-render from the result. */

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/dancing-script/400.css';
import './style.css';

import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { render, toBox, toRect } from './viewer.js';
import { update } from './pdf/incremental.js';
import { addField, removeField, signatureFields } from './pdf/fields.js';
import { signField } from './pdf/sign.js';
import { deviceSigner, fileSigner, tokenCertificates, tokenSigner } from './crypto/signers.js';
import { drawn, pad, typed, uploaded } from './appearance.js';

const $ = id => document.getElementById(id);
const viewer = $('viewer');
const dialog = $('sign');
const form = dialog.querySelector('form');
const f = form.elements;

const SETTINGS = 'ivxdocs-sign';
const REMEMBERED = ['look', 'with', 'typed', 'name', 'email', 'bridge'];

let doc = null;                                       // { name, bytes, dirty }
let placing = false;
let signing = null;                                   // the field the dialog is for
let tokenCerts = [];

const px = box => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, `${v}px`]));

function status(text = '', error = false) {
  $('status').textContent = text;
  $('status').hidden = !text;
  $('status').classList.toggle('error', error);
}

/** Runs `task` with `label` showing, and shows any failure instead. */
async function busy(label, task) {
  status(label);
  try {
    await task();
    status();
  } catch (err) {
    console.error(err);
    status(err.message, true);
  }
}

/* ── document ────────────────────────────────────────────────────────── */

async function show(bytes) {
  const fields = signatureFields(await PDFDocument.load(bytes, { updateMetadata: false }));
  const pages = await render(viewer, bytes);
  pages.forEach(({ layer, viewport }, index) => {
    layer.addEventListener('pointerdown', e => placing && e.target === layer && drag(e, layer, viewport, index));
    for (const field of fields.filter(x => x.page === index)) layer.append(fieldElement(field, viewport));
  });
  $('place').disabled = $('download').disabled = false;
}

async function commit(bytes) {
  await show(bytes);
  Object.assign(doc, { bytes, dirty: true });
}

const change = edit => busy('Saving…', async () => commit((await update(doc.bytes, edit)).bytes));

async function open(file) {
  if (!file) return;
  if (doc?.dirty && !confirm('Discard the changes to the current document?')) return;
  await busy('Opening…', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await show(bytes);
    } catch (err) {
      throw err instanceof EncryptedPDFError ? new Error('Password-protected PDFs cannot be signed here.') : err;
    }
    doc = { name: file.name, bytes, dirty: false };
    $('fileName').textContent = file.name;
  });
}

function download() {
  const url = URL.createObjectURL(new Blob([doc.bytes], { type: 'application/pdf' }));
  Object.assign(document.createElement('a'), { href: url, download: doc.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  doc.dirty = false;
}

/* ── fields ──────────────────────────────────────────────────────────── */

function button(text, label, onclick) {
  const el = Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick });
  el.setAttribute('aria-label', label);
  return el;
}

function fieldElement(field, viewport) {
  const el = document.createElement('div');
  el.className = field.signedBy ? 'field signed' : 'field';
  Object.assign(el.style, px(toBox(viewport, field.rect)));
  if (field.signedBy) {
    el.title = `Signed by ${field.signedBy}`;
  } else {
    el.append(
      button('Sign', `Sign ${field.name}`, () => openSign(field.name)),
      button('×', `Remove ${field.name}`, () => change(d => removeField(d, field.name))));
  }
  return el;
}

function setPlacing(on) {
  placing = on;
  $('place').setAttribute('aria-pressed', on);
  document.body.classList.toggle('placing', on);
}

/** Drag out a field on a page; a plain click places one of a default size. */
function drag(e, layer, viewport, index) {
  const at = ev => {
    const r = layer.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const box = ([x1, y1], [x2, y2]) => ({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });

  const start = at(e);
  const ghost = Object.assign(document.createElement('div'), { className: 'field ghost' });
  layer.append(ghost);
  layer.setPointerCapture(e.pointerId);

  const move = ev => Object.assign(ghost.style, px(box(start, at(ev))));
  layer.addEventListener('pointermove', move);
  layer.addEventListener('pointerup', ev => {
    layer.removeEventListener('pointermove', move);
    ghost.remove();
    let end = at(ev);
    const { width, height } = box(start, end);
    if (width < 12 || height < 12) end = [start[0] + 180 * viewport.scale, start[1] + 60 * viewport.scale];
    change(d => addField(d, index, toRect(viewport, start, end)));
  }, { once: true });
}

/* ── signing ─────────────────────────────────────────────────────────── */

const signaturePad = pad($('pad'));
const bridgeUrl = () => f.bridge.value.trim().replace(/\/+$/, '');

/** Shows the panel matching the checked radio of group `name`. */
function tabs(name, onchange = () => {}) {
  const sync = () => {
    for (const el of form.querySelectorAll(`div[data-${name}]`)) el.hidden = el.dataset[name] !== f[name].value;
    onchange(f[name].value);
  };
  for (const radio of f[name]) radio.addEventListener('change', sync);
  sync();
}

function previewTyped() {
  $('typedPreview').textContent = f.typed.value || 'Your name';
}

function openSign(name) {
  signing = name;
  $('fieldName').textContent = name;
  $('signError').textContent = '';
  if (!f.typed.value) f.typed.value = f.name.value;
  previewTyped();
  dialog.showModal();
  signaturePad.reset();
}

function signer() {
  switch (f.with.value) {
    case 'device':
      if (!f.name.value.trim()) throw new Error('Enter your name for the certificate.');
      return deviceSigner(f.name.value.trim(), f.email.value.trim());
    case 'file':
      if (!f.p12.files[0]) throw new Error('Choose your certificate file.');
      return f.p12.files[0].arrayBuffer().then(buffer => fileSigner(buffer, f.password.value));
    case 'token': {
      const entry = tokenCerts[f.tokenCert.value];
      if (!entry) throw new Error('Find the certificates on your token first.');
      if (!f.pin.value) throw new Error('Enter the token PIN.');
      return tokenSigner(bridgeUrl(), entry, f.pin.value);
    }
  }
}

const look = () => ({
  type: () => typed(f.typed.value),
  draw: () => drawn($('pad')),
  image: () => uploaded(f.image.files[0]),
})[f.look.value]();

/** Runs `task` for the dialog, with the Sign button held and errors shown in place. */
async function dialogTask(task) {
  $('signError').textContent = '';
  $('doSign').disabled = true;
  try {
    await task();
  } catch (err) {
    console.error(err);
    $('signError').textContent = err.message;
  } finally {
    $('doSign').disabled = false;
  }
}

form.addEventListener('submit', e => {
  if (e.submitter?.value !== 'sign') return;          // Cancel just closes
  e.preventDefault();
  dialogTask(async () => {
    const png = await look();
    const bytes = await signField(doc.bytes, signing, { png, signer: await signer() });
    await commit(bytes);
    localStorage.setItem(SETTINGS, JSON.stringify(Object.fromEntries(REMEMBERED.map(k => [k, f[k].value]))));
    dialog.close();
  });
});

$('loadToken').onclick = () => dialogTask(async () => {
  tokenCerts = await tokenCertificates(bridgeUrl());
  f.tokenCert.replaceChildren(...tokenCerts.map((c, i) => new Option(`${c.name} (${c.label})`, i)));
  if (!tokenCerts.length) throw new Error('No certificates found. Is the token plugged in?');
});

$('clearPad').onclick = () => signaturePad.reset(true);
f.typed.addEventListener('input', previewTyped);
f.image.addEventListener('change', () => {
  const file = f.image.files[0];
  $('imagePreview').src = file ? URL.createObjectURL(file) : '';
});

const remembered = JSON.parse(localStorage.getItem(SETTINGS) ?? '{}');
for (const k of REMEMBERED) if (remembered[k]) f[k].value = remembered[k];
tabs('look', value => value === 'draw' && signaturePad.reset());
tabs('with');

/* ── wiring ──────────────────────────────────────────────────────────── */

for (const id of ['open', 'openEmpty']) $(id).addEventListener('change', e => open(e.target.files[0]));
$('place').onclick = () => setPlacing(!placing);
$('download').onclick = download;

addEventListener('keydown', e => e.key === 'Escape' && !dialog.open && setPlacing(false));
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  open(e.dataTransfer.files[0]);
});
addEventListener('beforeunload', e => doc?.dirty && e.preventDefault());

// Installed as an app, PDFs can be opened with it straight from the OS.
window.launchQueue?.setConsumer(async ({ files }) => files[0] && open(await files[0].getFile()));

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
