// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/docs Verify. Opens a PDF, checks every signature in it with
   pdf/verify.js, and says what it found in plain sentences beside the pages,
   with each signed field outlined where it sits. */

import { busy, save } from '../site.js';
import './verify.css';

import { render, toBox } from '../pdf/viewer.js';
import { verifySignatures } from '../pdf/verify.js';

const $ = id => document.getElementById(id);
const report = $('report');

let doc = null;                                       // { name, bytes }

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

const when = date => date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = date => date.toLocaleDateString(undefined, { dateStyle: 'medium' });
const list = words => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CHANGES = {
  signature: 'added signatures',
  form: 'added, removed or filled in form fields',
  annotations: 'added or changed comments',
  metadata: 'changed the document properties',
  content: 'made other changes, which can alter what the document shows',
};

/* ── what a signature amounts to ─────────────────────────────────────── */

function verdict(sig) {
  if (sig.status === 'invalid') return { tone: 'bad', badge: 'Invalid' };
  if (sig.status === 'unknown') return { tone: 'unknown', badge: 'Not checked' };
  if (sig.later?.changes.includes('content')) return { tone: 'warn', badge: 'Changed since' };
  if (sig.validAtSigning === false || sig.chain === 'broken') return { tone: 'warn', badge: 'Certificate problem' };
  return { tone: 'ok', badge: 'Valid' };
}

function integrity(sig) {
  if (sig.status !== 'valid') return sig.problem;
  const what = sig.kind === 'timestamp' ? 'this timestamp' : 'it was signed';
  if (!sig.later) return `The document has not changed since ${what}.`;
  const { revisions, changes } = sig.later;
  const by = revisions === 1 ? 'A later revision' : `${revisions} later revisions`;
  return `The version covered by ${sig.kind === 'timestamp' ? 'this timestamp' : 'this signature'} is intact. ` +
    `${by} ${list(changes.map(c => CHANGES[c]))}.`;
}

function timing(sig) {
  if (!sig.time) return null;
  if (sig.kind === 'timestamp') return `Timestamped ${when(sig.time)} by ${sig.signer}.`;
  if (sig.timeFrom === 'timestamp') return `Signed ${when(sig.time)}, according to a timestamp from ${sig.timestamp.authority ?? 'a timestamp authority'}.`;
  const bad = sig.timestamp && !sig.timestamp.valid ? ' It carries a timestamp, but the timestamp does not verify.' : '';
  return `Signed ${when(sig.time)}, by the clock of the signer’s own computer.${bad}`;
}

function identity(sig) {
  const [cert, issuer] = sig.certificates;
  if (!cert) return sig.status === 'valid' ? 'The signature carries no certificate.' : null;
  const root = sig.certificates.at(-1);
  let text = {
    root: sig.certificates.length === 1
      ? 'The certificate is self-signed: it proves the document is unchanged, not who signed it.'
      : `The certificate was issued by ${issuer.name}${root !== issuer ? `, under ${root.name}` : ''}. ` +
        'Whether to trust that issuer is your call: ivx/docs keeps no list of trusted ones.',
    incomplete: `The certificate was issued by ${cert.issuer}, whose own certificate is not included, so the chain stops there.`,
    broken: 'The certificate chain does not verify: one of the certificates was not signed by the one above it.',
  }[sig.chain];
  if (sig.validAtSigning === false) text += ` The certificate was not valid at the time of signing (${day(cert.from)} to ${day(cert.until)}).`;
  return text;
}

function certificateDetails(certs) {
  if (!certs.length) return null;
  return el('details', {},
    el('summary', { textContent: certs.length === 1 ? 'Certificate' : `Certificates (${certs.length})` }),
    ...certs.map(c => el('dl', {},
      el('dt', { textContent: 'Subject' }), el('dd', { textContent: c.subject }),
      el('dt', { textContent: 'Issuer' }), el('dd', { textContent: c.issuer }),
      el('dt', { textContent: 'Valid' }), el('dd', { textContent: `${day(c.from)} to ${day(c.until)}` }),
      el('dt', { textContent: 'SHA-256' }), el('dd', { className: 'fingerprint', textContent: c.fingerprint }))));
}

/* ── the report ──────────────────────────────────────────────────────── */

function card(sig, index) {
  const { tone, badge } = verdict(sig);
  const signer = sig.signer ?? 'Unknown signer';
  const where = sig.page === null ? sig.field : `${sig.field}, page ${sig.page + 1}`;

  const article = el('article', { className: `sig ${tone}`, id: `sig-${index}` },
    el('header', {},
      el('span', { className: 'badge', textContent: badge }),
      el('strong', { textContent: sig.kind === 'timestamp' ? 'Document timestamp' : signer })),
    el('p', { className: 'muted', textContent: where }),
    el('p', { textContent: integrity(sig) }),
    timing(sig) && el('p', { textContent: timing(sig) }),
    sig.kind === 'signature' && identity(sig) && el('p', { textContent: identity(sig) }),
    certificateDetails(sig.certificates),
    sig.later && sig.end && el('button', {
      type: 'button', className: 'small',
      onclick: () => save(doc.bytes.slice(0, sig.end), `${doc.name.replace(/\.pdf$/i, '')} (as signed by ${signer}).pdf`),
    }, el('i', { className: 'icon icon-download-simple', ariaHidden: 'true' }), 'Download the version that was signed'));

  if (sig.page !== null) {
    article.classList.add('placed');
    article.addEventListener('click', e => {
      if (e.target.closest('button, details')) return;
      document.getElementById(`mark-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  return article;
}

function summary(sigs) {
  if (!sigs.length) return 'This PDF has no signatures.';
  const tones = sigs.map(s => verdict(s).tone);
  const count = plural(sigs.length, 'signature');
  if (tones.every(t => t === 'ok')) return `${count}, ${sigs.length === 1 ? 'valid' : 'all valid'}.`;
  const bad = tones.filter(t => t === 'bad').length;
  const warn = tones.filter(t => t === 'warn').length;
  return `${count}: ${list([bad && `${bad} invalid`, warn && `${warn} with warnings`].filter(Boolean)) || 'some could not be checked'}.`;
}

async function show(bytes) {
  const sigs = await verifySignatures(bytes);
  $('empty').hidden = true;                           // lay out the two columns before sizing the pages
  report.hidden = false;
  const pages = await render($('viewer'), bytes);

  sigs.forEach((sig, index) => {
    if (sig.page === null || !pages[sig.page]) return;
    const { layer, viewport } = pages[sig.page];
    const box = toBox(viewport, sig.rect);
    const mark = el('button', {
      type: 'button', id: `mark-${index}`, className: `mark ${verdict(sig).tone}`,
      title: `${sig.signer ?? 'Unknown signer'}: ${verdict(sig).badge}`,
      onclick: () => {
        const target = $(`sig-${index}`);
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        target.classList.remove('flash');
        void target.offsetWidth;                      // restart the animation
        target.classList.add('flash');
      },
    });
    Object.assign(mark.style, Object.fromEntries(Object.entries(box).map(([k, v]) => [k, `${v}px`])));
    layer.append(mark);
  });

  report.replaceChildren(
    el('p', { className: 'summary', textContent: summary(sigs) }),
    ...sigs.map(card),
    sigs.length ? el('p', { className: 'muted', textContent:
      'Checked on this device against the file’s own bytes. Revocation is not checked, since that would mean asking a server.' }) : null);
}

async function open(file) {
  if (!file) return;
  await busy('Checking…', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    doc = { name: file.name, bytes };
    await show(bytes);
    $('fileName').textContent = file.name;
  });
}

/* ── wiring ──────────────────────────────────────────────────────────── */

for (const id of ['open', 'openEmpty']) $(id).addEventListener('change', e => open(e.target.files[0]));
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  open(e.dataTransfer.files[0]);
});

window.launchQueue?.setConsumer(async ({ files }) => files[0] && open(await files[0].getFile()));
