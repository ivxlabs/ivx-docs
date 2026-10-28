// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/docs Merge PDFs. A list of files, each with the pages to take from
   it; the list is the only state, and the list on screen is redrawn from it
   after every change. */

import { busy, save, status } from '../site.js';
import './merge.css';

import { thumbnail } from '../pdf/viewer.js';
import { loadForMerge, merge, parsePages } from '../pdf/merge.js';

const $ = id => document.getElementById(id);
const list = $('files');

let files = [];                                       // [{ name, doc, count, pages, thumb }]
let dragging = null;                                  // index of the file being dragged

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function button(text, label, onclick, disabled = false) {
  const b = el('button', { type: 'button', className: 'small', textContent: text, onclick, disabled });
  b.setAttribute('aria-label', label);
  return b;
}

function move(from, to) {
  if (to < 0 || to >= files.length || from === to) return;
  const [file] = files.splice(from, 1);
  files.splice(to, 0, file);
  draw();
}

function item(file, i) {
  const pages = el('input', { value: file.pages, placeholder: 'all', spellcheck: false });
  pages.setAttribute('aria-label', `Pages of ${file.name}`);
  pages.addEventListener('input', () => { file.pages = pages.value; totals(); });

  const li = el('li', { draggable: true },
    el('div', { className: 'thumb' }, file.thumb),
    el('div', { className: 'info' },
      el('strong', { textContent: file.name }),
      el('span', { className: 'muted', textContent: plural(file.count, 'page') }),
      el('label', { className: 'pages' }, 'Pages ', pages)),
    el('div', { className: 'order' },
      button('↑', `Move ${file.name} up`, () => move(i, i - 1), i === 0),
      button('↓', `Move ${file.name} down`, () => move(i, i + 1), i === files.length - 1),
      button('×', `Remove ${file.name}`, () => { files.splice(i, 1); draw(); })));

  li.addEventListener('dragstart', e => {
    if (e.target.closest('input')) return e.preventDefault();
    dragging = i;
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => { dragging = null; li.classList.remove('dragging'); });
  li.addEventListener('dragover', e => {
    if (dragging === null) return;
    e.preventDefault();
    li.classList.add('over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', e => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    move(dragging, i);
  });
  return li;
}

/** The pages each file contributes, or the first problem with a range. */
function picked() {
  return files.map(file => {
    try {
      return { doc: file.doc, pages: parsePages(file.pages, file.count) };
    } catch (err) {
      throw new Error(`${file.name}: ${err.message}`);
    }
  });
}

function totals() {
  let text = '';
  try {
    const n = picked().reduce((sum, p) => sum + p.pages.length, 0);
    text = `${plural(files.length, 'file')}, ${plural(n, 'page')}`;
  } catch {
    text = `${plural(files.length, 'file')}`;
  }
  $('totals').textContent = files.length ? text : '';
}

function draw() {
  list.replaceChildren(...files.map(item));
  list.hidden = $('note').hidden = !files.length;
  $('empty').hidden = !!files.length;
  $('merge').disabled = !files.length;
  totals();
}

async function add(chosen) {
  const pdfs = [...chosen].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return;
  await busy(`Opening ${plural(pdfs.length, 'file')}…`, async () => {
    const refused = [];
    for (const file of pdfs) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let doc;
      try {
        doc = await loadForMerge(bytes, file.name);
      } catch (err) {
        console.error(err);
        refused.push(/password/.test(err.message) ? err.message : `${file.name} could not be read as a PDF.`);
        continue;
      }
      const entry = { name: file.name, doc, count: doc.getPageCount(), pages: '', thumb: el('div', { className: 'placeholder' }) };
      files.push(entry);
      thumbnail(bytes, 72).then(canvas => { entry.thumb.replaceWith(canvas); entry.thumb = canvas; }, () => {});
      draw();
    }
    if (refused.length) throw new Error(refused.join(' '));   // the rest were added
  });
}

function name() {
  const base = files[0].name.replace(/\.pdf$/i, '');
  return files.length === 1 ? `${base} (pages).pdf` : `${base} and ${plural(files.length - 1, 'other')}.pdf`;
}

$('merge').onclick = () => busy('Merging…', async () => {
  const parts = picked();
  if (!parts.some(p => p.pages.length)) throw new Error('No pages picked.');
  save(await merge(parts), name());
});

/* ── wiring ──────────────────────────────────────────────────────────── */

for (const id of ['add', 'addEmpty']) {
  $(id).addEventListener('change', e => {
    add(e.target.files);
    e.target.value = '';                              // so the same file can be added twice
  });
}

addEventListener('dragover', e => e.dataTransfer.types.includes('Files') && e.preventDefault());
addEventListener('drop', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  add(e.dataTransfer.files);
});

// Errors in a range show as soon as merging is tried; clear them on the next edit.
list.addEventListener('input', () => status());
