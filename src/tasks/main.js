// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Tasks: to-do lists in the browser, shown as a list or a board.

   Lists hold tasks. Upcoming gathers the dated tasks of every list for a
   span of days the person picks, sorted by time with starred first among
   equals; Starred gathers the starred ones. A completed task is archived
   after a while, an archived one goes to the trash, and the trash empties
   itself, each after a number of days set in Settings.

   Everything lives in this browser (store.js). Sync (sync.js) keeps it in
   step with the person's other browsers on the same network, reminders
   (notify.js) come as notifications, and backups (backup.js) go to their
   own Google Drive when they ask for it. */

import '../site.js';
import { status } from '../site.js';
import './tasks.css';
import * as store from './store.js';
import * as sync from './sync.js';
import * as notify from './notify.js';
import * as backup from './backup.js';
import { qrElement, scan } from '../sync/qr.js';
import {
  DAY, DEFAULT_CLEANUP, WEEKDAYS, byOrder, byTime, complete, daysBetween, describeRepeat,
  isArchived, isLive, isOpen, isTrashed, parseDate, range, series, sweep, today, upcoming, weekday,
} from './model.js';

const $ = id => document.getElementById(id);
const UI_KEY = 'ivx-tasks-ui';
const BACKUP_KEY = 'ivx-tasks-backup';

/** The first day of the week where the person is: 0 Sunday … 6 Saturday. */
const FIRST_DAY = (() => {
  try {
    const locale = new Intl.Locale(navigator.language);
    return ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
})();

const ui = {
  view: { type: 'list', id: 'default' },
  mode: 'list',
  range: 'week',
  custom: {},
  overdue: true,
  showDone: false,
  ...JSON.parse(localStorage.getItem(UI_KEY) || '{}'),
};
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

/* ── a little DOM ──────────────────────────────────────────── */

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'draggable', 'open']);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

/** An icon from src/icons (Phosphor), for beside a label; `fill` for its filled form. */
const icon = (name, fill = false) => h('i', { class: `icon icon-${name}${fill ? ' fill' : ''}`, 'aria-hidden': 'true' });

/**
 * A button: `label`, with `props.icon` beside it. With `props.iconOnly` the
 * label is its accessible name and tooltip instead of its text.
 */
function button(label, onclick, { icon: name, iconOnly, class: cls = '', ...props } = {}) {
  return h('button', {
    type: 'button', onclick, ...props,
    class: `${cls}${iconOnly ? ' icon-only' : ''}`.trim() || null,
    ...(iconOnly ? { 'aria-label': label, title: label } : {}),
  }, name ? icon(name) : null, iconOnly ? null : label);
}

const flash = text => {
  status(text);
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => status(), 2500);
};

async function attempt(task) {
  try {
    return await task();
  } catch (err) {
    console.error(err);
    status(err.message, true);
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => status(), 6000);
    return undefined;
  }
}

/* ── formatting ────────────────────────────────────────────── */

const time = hhmm => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

function dayLabel(date) {
  const diff = daysBetween(today(), date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = parseDate(date);
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function when(task) {
  const parts = [];
  if (task.date) parts.push(dayLabel(task.date));
  if (task.start) parts.push(task.end ? `${time(task.start)}–${time(task.end)}` : time(task.start));
  return parts.join(', ');
}

const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400) || 1} day${Math.round(s / 86400) > 1 ? 's' : ''} ago`;
  return new Date(ms).toLocaleDateString();
};

/* ── the data ──────────────────────────────────────────────── */

const lists = () => store.all('list').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
const tasks = () => store.all('task');
const cleanup = () => ({ ...DEFAULT_CLEANUP, ...store.get('settings:cleanup') });
const newId = () => crypto.randomUUID();
const listName = id => store.get(id)?.name ?? 'No list';

/** A first list, under a fixed id, so two devices starting fresh and then
    paired end up with one "My Tasks" rather than two. */
async function ensureList() {
  if (!lists().length) await store.put({ id: 'default', kind: 'list', name: 'My Tasks', order: 0 });
}

function viewList() {
  if (ui.view.type === 'list' && store.get(ui.view.id)) return store.get(ui.view.id);
  return null;
}

/** Where a task added from the current view goes. */
const homeList = () => viewList()?.id ?? lists()[0]?.id;

/** The top of a list, for a new task. */
const topOrder = listId => Math.min(0, ...tasks().filter(t => t.listId === listId).map(t => t.order ?? 0)) - 1;

async function addTask(title) {
  const listId = homeList();
  if (!listId) return;
  const task = {
    id: newId(), kind: 'task', listId, title, notes: '', status: 'todo',
    starred: ui.view.type === 'starred', date: '', start: '', end: '', repeat: null,
    order: topOrder(listId), completedAt: 0, archivedAt: 0, trashedAt: 0, snooze: 0,
  };
  // Added to Upcoming, it is for the first day being shown.
  if (ui.view.type === 'upcoming') task.date = range(ui.range, today(), FIRST_DAY, ui.custom)[0];
  await store.put(task);
}

async function setDone(task, done) {
  if (!done) {
    return store.put({ id: task.id, status: 'todo', completedAt: 0, archivedAt: 0 });
  }
  const result = complete(task, Date.now(), newId(), FIRST_DAY);
  await store.put({ id: task.id, ...result.done }, ...(result.next ? [result.next] : []));
  if (result.next) flash(`Next one: ${when(result.next)}`);
}

async function setStatus(task, value) {
  if (value === task.status) return;
  if (value === 'done') return setDone(task, true);
  return store.put({ id: task.id, status: value, completedAt: 0, archivedAt: 0 });
}

const toTrash = task => store.put({ id: task.id, trashedAt: Date.now() });

/** Back from the trash or the archive, with its clock started again so it
    does not slip straight back. */
async function restore(task) {
  const listId = store.get(task.listId) ? task.listId : lists()[0]?.id;
  if (task.trashedAt) {
    return store.put({ id: task.id, listId, trashedAt: 0, ...(task.archivedAt ? { archivedAt: Date.now() } : {}) });
  }
  return store.put({ id: task.id, listId, archivedAt: 0, ...(task.status === 'done' ? { completedAt: Date.now() } : {}) });
}

/** Apply the clean-up schedule: archive, trash, then delete, as each falls due. */
async function tidy() {
  const rules = cleanup();
  const now = Date.now();
  const patches = [];
  const purge = [];
  for (const original of tasks()) {
    let t = original;
    for (let step = 0; step < 3; step++) {
      const next = sweep(t, rules, now);
      if (!next) break;
      if (next === 'purge') { purge.push(t.id); t = null; break; }
      t = { ...t, ...next };
    }
    if (t && t !== original) patches.push({ id: t.id, archivedAt: t.archivedAt, trashedAt: t.trashedAt });
  }
  if (patches.length) await store.put(...patches);
  if (purge.length) await store.remove(...purge);
}

/* ── what a view shows ─────────────────────────────────────── */

function viewTasks() {
  const all = tasks();
  switch (ui.view.type) {
    case 'upcoming': {
      const [from, to] = range(ui.range, today(), FIRST_DAY, ui.custom);
      return { from, to, groups: upcoming(all, { from, to, day: today(), overdue: ui.overdue }) };
    }
    case 'starred': return { items: all.filter(t => isLive(t) && t.starred).sort(byTime) };
    case 'archive': return { items: all.filter(isArchived).sort((a, b) => b.archivedAt - a.archivedAt) };
    case 'trash': return { items: all.filter(isTrashed).sort((a, b) => b.trashedAt - a.trashedAt) };
    default: return { items: all.filter(t => isLive(t) && t.listId === ui.view.id) };
  }
}

/** For the board: every live task the view covers, done ones included. */
function boardTasks() {
  const all = tasks().filter(isLive);
  if (ui.view.type === 'upcoming') {
    const [from, to] = range(ui.range, today(), FIRST_DAY, ui.custom);
    const day = today();
    return all.filter(t => t.date && ((t.date >= from && t.date <= to) || (ui.overdue && t.date < day && t.status !== 'done')))
      .sort(byTime);
  }
  if (ui.view.type === 'starred') return all.filter(t => t.starred).sort(byTime);
  return all.filter(t => t.listId === ui.view.id).sort(byOrder);
}

/* ── rendering ─────────────────────────────────────────────── */

let dragging = null;   // the task being dragged

function taskRow(task, { showList = false, reorder = false } = {}) {
  const overdue = isOpen(task) && task.date && task.date < today();
  const meta = [
    task.date && h('span', { class: overdue ? 'late' : '' }, icon(task.start ? 'clock' : 'calendar-blank'), when(task)),
    task.repeat && h('span', { title: describeRepeat(task.repeat) }, icon('repeat'), describeRepeat(task.repeat)),
    showList && h('span', null, listName(task.listId)),
    task.status === 'doing' && h('span', { class: 'badge' }, 'In progress'),
  ].filter(Boolean);
  const live = isLive(task);
  const row = h('div', {
    class: `task${task.status === 'done' ? ' done' : ''}`,
    'data-id': task.id,
    draggable: live,
    ondragstart: e => { dragging = task; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', task.title); row.classList.add('dragging'); },
    ondragend: () => { dragging = null; row.classList.remove('dragging'); },
  },
  live
    ? h('button', {
      type: 'button', class: 'tick', 'aria-pressed': String(task.status === 'done'),
      'aria-label': task.status === 'done' ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`,
      onclick: () => attempt(() => setDone(task, task.status !== 'done')),
    }, icon('check'))
    : h('span', { class: 'tick-space' }),
  h('button', { type: 'button', class: 'body', onclick: () => openEditor(task) },
    h('span', { class: 'title' }, task.title || 'Untitled task'),
    meta.length ? h('span', { class: 'meta' }, meta) : null,
    task.notes ? h('span', { class: 'notes' }, task.notes.split('\n')[0]) : null),
  live
    ? h('button', {
      type: 'button', class: 'star', 'aria-pressed': String(Boolean(task.starred)),
      'aria-label': task.starred ? 'Unstar' : 'Star',
      onclick: () => attempt(() => store.put({ id: task.id, starred: !task.starred })),
    }, icon('star', Boolean(task.starred)))
    : null,
  !live ? h('span', { class: 'row-actions' },
    button('Restore', () => attempt(() => restore(task)), { class: 'small', icon: 'arrow-counter-clockwise' }),
    isTrashed(task)
      ? button('Delete forever', () => attempt(() => store.remove(task.id)), { class: 'small', icon: 'trash' })
      : button('Delete', () => attempt(() => toTrash(task)), { class: 'small', icon: 'trash' })) : null);

  if (reorder) {
    row.addEventListener('dragover', e => {
      if (!dragging || dragging.id === task.id || dragging.listId !== task.listId) return;
      e.preventDefault();
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      row.classList.remove('drop-before', 'drop-after');
      if (dragging) attempt(() => moveNextTo(dragging, task, after));
    });
  }
  return row;
}

/** Put `task` just before or after `target` in their list. */
function moveNextTo(task, target, after) {
  const open = tasks().filter(t => isOpen(t) && t.listId === target.listId && t.id !== task.id).sort(byOrder);
  const i = open.findIndex(t => t.id === target.id);
  const [a, b] = after ? [open[i], open[i + 1]] : [open[i - 1], open[i]];
  const order = a && b ? (a.order + b.order) / 2 : a ? a.order + 1 : b.order - 1;
  return store.put({ id: task.id, order });
}

function renderNav() {
  const all = tasks();
  const [from, to] = range(ui.range, today(), FIRST_DAY, ui.custom);
  const counts = {
    upcoming: upcoming(all, { from, to, day: today(), overdue: ui.overdue }).reduce((n, g) => n + g.items.length, 0),
    starred: all.filter(t => isOpen(t) && t.starred).length,
  };
  for (const el of document.querySelectorAll('[data-count]')) el.textContent = counts[el.dataset.count] || '';
  for (const el of document.querySelectorAll('.nav[data-view]')) {
    el.setAttribute('aria-current', String(ui.view.type === el.dataset.view));
  }
  $('lists').replaceChildren(...lists().map(list => {
    const open = all.filter(t => isOpen(t) && t.listId === list.id).length;
    const el = h('button', {
      type: 'button', class: 'nav', 'aria-current': String(ui.view.type === 'list' && ui.view.id === list.id),
      onclick: () => go({ type: 'list', id: list.id }),
    }, icon('list-checks'), h('span', { class: 'name' }, list.name), h('span', { class: 'count' }, open || ''));
    // Drop a task on a list to move it there.
    el.addEventListener('dragover', e => { if (dragging && dragging.listId !== list.id) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop');
      if (dragging) attempt(() => store.put({ id: dragging.id, listId: list.id, order: topOrder(list.id) }));
    });
    return el;
  }));
}

function renderHead() {
  const list = viewList();
  const rules = cleanup();
  const tools = [];
  let title = '';
  let note = '';
  switch (ui.view.type) {
    case 'upcoming': {
      title = 'Upcoming';
      const choice = h('select', {
        'aria-label': 'Show',
        onchange: e => { ui.range = e.target.value; saveUi(); render(); },
      }, [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['next7', 'Next 7 days'],
        ['month', 'This month'], ['next30', 'Next 30 days'], ['all', 'Everything scheduled'], ['custom', 'Choose dates…']]
        .map(([value, label]) => h('option', { value, selected: ui.range === value }, label)));
      tools.push(choice);
      if (ui.range === 'custom') {
        const [from, to] = range('custom', today(), FIRST_DAY, ui.custom);
        const set = (k, v) => { ui.custom = { ...ui.custom, [k]: v }; saveUi(); render(); };
        tools.push(h('input', { type: 'date', value: from, 'aria-label': 'From', onchange: e => set('from', e.target.value) }),
          h('input', { type: 'date', value: to, 'aria-label': 'To', onchange: e => set('to', e.target.value) }));
      }
      tools.push(h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: ui.overdue, onchange: e => { ui.overdue = e.target.checked; saveUi(); render(); } }),
        ' Overdue'));
      break;
    }
    case 'starred': title = 'Starred'; break;
    case 'archive':
      title = 'Archive';
      note = rules.trash ? `Archived tasks go to the trash after ${rules.trash} days.` : 'Archived tasks stay here until you delete them.';
      break;
    case 'trash':
      title = 'Trash';
      note = rules.purge ? `Tasks in the trash are deleted for good after ${rules.purge} days.` : 'Tasks stay in the trash until you empty it.';
      tools.push(button('Empty trash', () => {
        const ids = tasks().filter(isTrashed).map(t => t.id);
        if (ids.length && confirm(`Delete ${ids.length} task${ids.length === 1 ? '' : 's'} for good, on every synced device?`)) attempt(() => store.remove(...ids));
      }, { icon: 'broom' }));
      break;
    default:
      title = list?.name ?? '';
      if (list) {
        tools.push(button('Rename', () => {
          const name = prompt('Rename list', list.name)?.trim();
          if (name) attempt(() => store.put({ id: list.id, name }));
        }, { icon: 'pencil-simple' }), button('Delete list', () => deleteList(list), { icon: 'trash' }));
      }
  }
  $('title').textContent = title;
  $('viewTools').replaceChildren(...tools);
  $('viewNote').textContent = note;
  $('viewNote').hidden = !note;
  const canAdd = !['archive', 'trash'].includes(ui.view.type) && lists().length > 0;
  $('add').hidden = !canAdd;
  const boardable = canAdd;
  $('asBoard').disabled = !boardable;
  $('asList').setAttribute('aria-pressed', String(ui.mode === 'list' || !boardable));
  $('asBoard').setAttribute('aria-pressed', String(ui.mode === 'board' && boardable));
}

function empty(text) {
  return h('p', { class: 'muted empty-view' }, text);
}

function renderList() {
  const view = viewTasks();
  const out = [];
  if (view.groups) {
    for (const g of view.groups) {
      out.push(h('h3', { class: g.key === 'overdue' ? 'group late' : 'group' }, g.key === 'overdue' ? 'Overdue' : dayLabel(g.key)));
      out.push(h('div', { class: 'rows' }, g.items.map(t => taskRow(t, { showList: true }))));
    }
    if (!out.length) out.push(empty('Nothing scheduled for these days. Give a task a date and it shows up here, from every list.'));
  } else if (ui.view.type === 'list') {
    const open = view.items.filter(t => t.status !== 'done').sort(byOrder);
    const done = view.items.filter(t => t.status === 'done').sort((a, b) => b.completedAt - a.completedAt);
    out.push(open.length
      ? h('div', { class: 'rows' }, open.map(t => taskRow(t, { reorder: true })))
      : empty(done.length ? 'All done.' : 'No tasks yet. Add one above.'));
    if (done.length) {
      const rules = cleanup();
      out.push(h('div', { class: 'done-head' },
        button(`Completed (${done.length})`, () => { ui.showDone = !ui.showDone; saveUi(); render(); }, { class: 'link-button', icon: ui.showDone ? 'caret-down' : 'caret-right', 'aria-expanded': String(ui.showDone) }),
        rules.archive ? h('span', { class: 'muted' }, `archived after ${rules.archive} days`) : null,
        ui.showDone ? button('Archive all', () => attempt(() => store.put(...done.map(t => ({ id: t.id, archivedAt: Date.now() })))), { class: 'small', icon: 'archive' }) : null));
      if (ui.showDone) out.push(h('div', { class: 'rows' }, done.map(t => taskRow(t))));
    }
  } else {
    out.push(view.items.length
      ? h('div', { class: 'rows' }, view.items.map(t => taskRow(t, { showList: true })))
      : empty({ starred: 'Star a task and it shows up here.', archive: 'Nothing archived.', trash: 'The trash is empty.' }[ui.view.type]));
  }
  $('items').replaceChildren(...out);
}

function renderBoard() {
  const all = boardTasks();
  const cross = ui.view.type !== 'list';
  const columns = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].map(([value, label]) => {
    const items = all.filter(t => t.status === value);
    if (value === 'done') items.sort((a, b) => b.completedAt - a.completedAt);
    const col = h('section', { class: 'column', 'data-status': value },
      h('h3', null, label, ' ', h('span', { class: 'count' }, items.length || '')),
      h('div', { class: 'rows' }, items.map(t => taskRow(t, { showList: cross }))));
    col.addEventListener('dragover', e => { if (dragging) { e.preventDefault(); col.classList.add('drop'); } });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drop');
      if (dragging) attempt(() => setStatus(dragging, value));
    });
    return col;
  });
  $('items').replaceChildren(h('div', { class: 'board' }, columns));
}

function render() {
  if (ui.view.type === 'list' && !viewList()) ui.view = lists()[0] ? { type: 'list', id: lists()[0].id } : { type: 'upcoming' };
  renderNav();
  renderHead();
  if (ui.mode === 'board' && !['archive', 'trash'].includes(ui.view.type)) renderBoard();
  else renderList();
  if (editing && !store.get(editing.id)) $('editor').close();
  if ($('settings').open) renderSettings();
}

function go(view) {
  ui.view = view;
  saveUi();
  closeSide();
  render();
}

async function deleteList(list) {
  const inside = tasks().filter(t => t.listId === list.id && !t.trashedAt);
  if (lists().length === 1) return flash('This is your only list. Make another before deleting it.');
  if (!confirm(inside.length
    ? `Delete "${list.name}"? Its ${inside.length} task${inside.length === 1 ? '' : 's'} go to the trash.`
    : `Delete "${list.name}"?`)) return;
  await attempt(async () => {
    const now = Date.now();
    if (inside.length) await store.put(...inside.map(t => ({ id: t.id, trashedAt: now })));
    await store.remove(list.id);
  });
}

/* ── the editor ────────────────────────────────────────────── */

let editing = null;
const form = $('editForm');
const field = name => form.elements[name];

$('weekdays').replaceChildren(...[...Array(7)].map((_, i) => {
  const d = (FIRST_DAY + i) % 7;
  return h('label', { class: 'day' }, h('input', { type: 'checkbox', name: 'day', value: String(d) }), WEEKDAYS[d].slice(0, 2));
}));

function presetOf(rule) {
  if (!rule) return '';
  const plain = (rule.every || 1) === 1 && !rule.ends?.on && !rule.ends?.after;
  if (plain && rule.unit === 'day') return 'daily';
  if (plain && rule.unit === 'week' && rule.days?.length === 5 && [1, 2, 3, 4, 5].every(d => rule.days.includes(d))) return 'weekdays';
  if (plain && rule.unit === 'week' && (rule.days?.length ?? 1) <= 1) return 'weekly';
  if (plain && rule.unit === 'month') return 'monthly';
  if (plain && rule.unit === 'year') return 'yearly';
  return 'custom';
}

function showCustom() {
  const custom = field('repeat').value === 'custom';
  $('custom').hidden = !custom;
  $('weekdays').hidden = field('unit').value !== 'week';
  field('endsOn').hidden = field('ends').value !== 'on';
  $('endsAfter').hidden = field('ends').value !== 'after';
}

for (const name of ['repeat', 'unit', 'ends']) field(name).addEventListener('change', showCustom);

/* A repeating task's date and times are this occurrence's. Changing them
   moves this one only, and the editor says so, offering to move the series
   with it; changing the rule itself starts the series again from here. */
let ruleTouched = false;

function showMove() {
  const task = editing;
  const repeating = task?.repeat && field('repeat').value && !ruleTouched;
  const s = repeating ? series(task) : null;
  const moved = s && (field('date').value !== s.slot || field('start').value !== s.start || field('end').value !== s.end);
  $('repeatNote').hidden = !moved;
  $('moveAllRow').hidden = !moved;
  if (moved) {
    $('repeatNote').textContent = `This one is moved from ${dayLabel(s.slot)}${s.start ? ` at ${time(s.start)}` : ''}. `
      + 'The repeats stay on their own schedule.';
  } else {
    field('moveAll').checked = false;
  }
}

for (const name of ['date', 'start', 'end']) field(name).addEventListener('input', showMove);
$('custom').addEventListener('change', () => { ruleTouched = true; showMove(); });
field('repeat').addEventListener('change', () => { ruleTouched = true; showMove(); });

function openEditor(task) {
  editing = task;
  form.reset();
  field('listId').replaceChildren(...lists().map(l => h('option', { value: l.id, selected: l.id === task.listId }, l.name)));
  field('title').value = task.title;
  field('notes').value = task.notes || '';
  field('status').value = task.status;
  field('date').value = task.date || '';
  field('start').value = task.start || '';
  field('end').value = task.end || '';
  field('starred').checked = Boolean(task.starred);
  const rule = task.repeat;
  field('repeat').value = presetOf(rule);
  field('every').value = rule?.every || 1;
  field('unit').value = rule?.unit || 'week';
  for (const box of form.querySelectorAll('[name=day]')) {
    box.checked = (rule?.days ?? [weekday(task.date || today())]).includes(Number(box.value));
  }
  field('ends').value = rule?.ends?.on ? 'on' : rule?.ends?.after ? 'after' : 'never';
  field('endsOn').value = rule?.ends?.on || '';
  field('endsAfter').value = rule?.ends?.after || 10;
  showCustom();
  ruleTouched = false;
  showMove();
  const live = isLive(task);
  $('editDelete').lastElementChild.textContent = task.trashedAt ? 'Delete forever' : 'Delete';
  const restoring = Boolean(task.archivedAt || task.trashedAt);
  $('editArchive').lastElementChild.textContent = restoring ? 'Restore' : 'Archive';
  $('editArchive').firstElementChild.className = `icon icon-${restoring ? 'arrow-counter-clockwise' : 'archive'}`;
  $('editArchive').hidden = live && task.status !== 'done';
  $('editError').hidden = true;
  $('editor').showModal();
  if (!task.title) field('title').focus();
}

function ruleFromForm(date) {
  const preset = field('repeat').value;
  if (!preset) return null;
  const day = Number(date.slice(8, 10));
  const n = editing.repeat?.n || 1;
  switch (preset) {
    case 'daily': return { every: 1, unit: 'day', n };
    case 'weekdays': return { every: 1, unit: 'week', days: [1, 2, 3, 4, 5], n };
    case 'weekly': return { every: 1, unit: 'week', days: [weekday(date)], n };
    case 'monthly': return { every: 1, unit: 'month', day, n };
    case 'yearly': return { every: 1, unit: 'year', day, n };
    default: {
      const unit = field('unit').value;
      const ends = field('ends').value === 'on' && field('endsOn').value ? { on: field('endsOn').value }
        : field('ends').value === 'after' ? { after: Math.max(1, Number(field('endsAfter').value) || 1) } : {};
      const days = [...form.querySelectorAll('[name=day]:checked')].map(b => Number(b.value)).sort();
      return {
        every: Math.max(1, Number(field('every').value) || 1), unit, ends, n,
        ...(unit === 'week' ? { days: days.length ? days : [weekday(date)] } : {}),
        ...(unit === 'month' || unit === 'year' ? { day } : {}),
      };
    }
  }
}

form.addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save' || !editing) return;
  const fail = text => { e.preventDefault(); $('editError').textContent = text; $('editError').hidden = false; };
  const start = field('start').value;
  const end = field('end').value;
  let date = field('date').value;
  if (end && !start) return fail('A time block needs a start as well as an end.');
  if (start && end && end <= start) return fail('A time block has to end after it starts.');
  if ((start || field('repeat').value) && !date) date = today();
  // The series: kept as it was when only this one moved, or started again
  // from this one when the rule changed or the person asked to move it all.
  let repeat = null;
  let slot = '';
  if (date && field('repeat').value) {
    if (editing.repeat && !ruleTouched && !field('moveAll').checked) {
      const s = series(editing);
      repeat = { ...editing.repeat, start: s.start, end: s.end };
      slot = s.slot;
    } else {
      repeat = { ...ruleFromForm(date), start, end };
      slot = date;
    }
  }
  const patch = {
    id: editing.id,
    title: field('title').value.trim(),
    notes: field('notes').value,
    listId: field('listId').value,
    starred: field('starred').checked,
    date, start, end, repeat, slot,
  };
  // A new time is a new reminder; an old snooze no longer applies.
  if (date !== editing.date || start !== editing.start) patch.snooze = 0;
  if (patch.listId !== editing.listId) patch.order = topOrder(patch.listId);
  const nextStatus = field('status').value;
  const task = editing;
  await attempt(async () => {
    await store.put(patch);
    if (nextStatus !== task.status) await setStatus(store.get(task.id), nextStatus);
  });
});

$('editor').addEventListener('close', () => { editing = null; });

$('editDelete').addEventListener('click', async () => {
  const task = editing;
  if (!task) return;
  if (task.trashedAt) {
    if (!confirm('Delete this task for good, on every synced device?')) return;
    await attempt(() => store.remove(task.id));
  } else {
    await attempt(() => toTrash(task));
    flash('Moved to the trash');
  }
  $('editor').close();
});

$('editArchive').addEventListener('click', async () => {
  const task = editing;
  if (!task) return;
  await attempt(() => (task.archivedAt || task.trashedAt ? restore(task) : store.put({ id: task.id, archivedAt: Date.now() })));
  $('editor').close();
});

/* ── settings ──────────────────────────────────────────────── */

const section = (title, ...kids) => h('section', { class: 'setting' }, h('h3', null, title), kids);
const row = (...kids) => h('div', { class: 'row' }, kids);
const note = text => h('p', { class: 'muted' }, text);

function notifySection() {
  const s = notify.settings();
  const perm = notify.permission();
  const save = patch => { notify.saveSettings(patch); renderSettings(); };
  return section('Reminders',
    perm === 'unsupported' ? note('This browser cannot show notifications.')
      : perm === 'denied' ? note('Notifications are blocked for this site. Allow them in the browser’s site settings to get reminders.')
        : perm === 'default' ? row(button('Allow notifications', () => notify.ask().then(renderSettings), { class: 'primary', icon: 'bell' }),
          h('span', { class: 'muted' }, 'so Tasks can remind you'))
          : note('Notifications are on for this browser.'),
    row(h('label', null, 'Remind me ',
      h('select', { onchange: e => save({ lead: Number(e.target.value) }) },
        [[0, 'when a task starts'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, 'an hour before']]
          .map(([v, label]) => h('option', { value: String(v), selected: s.lead === v }, label))))),
    row(h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: Boolean(s.allDay), onchange: e => save({ allDay: e.target.checked ? '09:00' : '' }) }),
      ' Remind me of tasks with a day but no time, at '),
    h('input', { type: 'time', value: s.allDay || '09:00', disabled: !s.allDay, 'aria-label': 'Time for all-day reminders', onchange: e => save({ allDay: e.target.value || '09:00' }) })),
    row(h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: s.blockEnd, onchange: e => save({ blockEnd: e.target.checked }) }),
      ' Tell me when a time block ends')),
    note('Reminders come while Tasks is open, in a tab or installed as an app; browsers give a closed page no way to wake up. Ones you miss while it is closed show when you open it again. These settings are for this device only.'));
}

function cleanupSection() {
  const rules = cleanup();
  const days = (label, key) => h('label', { class: 'days' }, label,
    h('input', {
      type: 'number', min: '0', max: '3650', value: String(rules[key]), class: 'num',
      onchange: e => attempt(() => store.put({ id: 'settings:cleanup', kind: 'setting', ...rules, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })),
    }), ' days');
  return section('Clean-up',
    days('Archive completed tasks after ', 'archive'),
    days('Move archived tasks to the trash after ', 'trash'),
    days('Delete tasks in the trash for good after ', 'purge'),
    note('0 means never. These apply on every device you sync with.'));
}

function syncSection() {
  const s = sync.status();
  const out = [note('Keep Tasks the same on your phone, your laptop or another browser: directly between them over the same Wi-Fi, with no server and nothing on the internet. Both devices need Tasks open while they sync, and changes go across as you make them until one is closed.')];
  if (!s.supported) return section('Sync', out, note('This browser cannot connect to other devices directly.'));
  if (s.device) {
    out.push(row(h('label', { class: 'grow' }, 'This device is called ',
      h('input', { value: s.device.name, onchange: e => attempt(() => sync.rename(e.target.value)) }))));
  }
  const busy = s.sessions.some(x => x.role === 'host' && ['making', 'waiting', 'connecting'].includes(x.stage));
  out.push(row(
    button('Show a code', () => attempt(sync.host), { class: 'primary', disabled: busy, icon: 'qr-code' }),
    button('Use a code', () => openScanner(), { icon: 'scan' }),
    h('span', { class: 'muted' }, 'Start on either device; the other uses its code.')));
  for (const x of s.sessions) out.push(sessionPanel(x));

  // Everyone synced with before: a way back to them, since there is no server to find them by.
  const idle = s.known.filter(d => !d.connected && !s.sessions.some(x => x.peerName === d.name && !['failed', 'closed'].includes(x.stage)));
  if (s.known.length) {
    out.push(h('h4', null, 'Your devices'), h('ul', { class: 'devices' }, s.known.map(d => h('li', null,
      icon('devices'),
      h('span', { class: 'grow' }, h('strong', null, d.name), ' ',
        h('span', { class: 'muted' }, d.connected ? 'connected now' : d.lastSync ? `last synced ${ago(d.lastSync)}` : 'not synced yet')),
      idle.includes(d) ? button('Reconnect', () => attempt(() => sync.host(d.name)), { class: 'small', icon: 'arrows-clockwise', disabled: busy }) : null,
      d.connected ? null : button(`Forget ${d.name}`, () => {
        if (confirm(`Forget ${d.name}? Tasks it sent stay here; it just stops being offered for syncing.`)) attempt(() => sync.forget(d.id));
      }, { class: 'small', icon: 'x', iconOnly: true })))),
    note('To sync again, open Tasks on both and choose Reconnect here: devices cannot find each other without a server, so it takes the codes once more.'));
  }
  return section('Sync', out);
}

function sessionPanel(x) {
  const name = x.peerName || 'the other device';
  const cancel = button('Cancel', () => sync.close(x.id), { class: 'small', icon: 'x' });
  const copy = (text, label) => button(label, () => attempt(async () => {
    await navigator.clipboard.writeText(text);
    flash('Copied');
  }), { class: 'small', icon: 'copy' });
  let body;
  switch (x.stage) {
    case 'making': body = [h('p', null, 'Preparing a code…')]; break;
    case 'waiting': {
      const link = sync.linkFor(x.code);
      body = [
        h('p', null, h('strong', null, '1. '), 'On the other device, scan this with the camera, or open Tasks there and choose ', h('em', null, 'Use a code'), '.'),
        qrElement(link),
        row(copy(link, 'Copy link')),
        h('p', null, h('strong', null, '2. '), 'It shows a reply code. Scan that here.'),
        row(button('Scan the reply', () => openScanner(), { class: 'primary small', icon: 'scan' }), cancel),
      ];
      break;
    }
    case 'replying':
      body = [
        h('p', null, `Now scan this on ${name}, with `, h('em', null, 'Scan the reply'), ':'),
        qrElement(x.code),
        row(copy(x.code, 'Copy code'), cancel),
      ];
      break;
    case 'connecting': body = [h('p', null, `Connecting to ${name}…`), row(cancel)]; break;
    case 'open':
      body = [row(h('span', { class: 'grow' }, x.shaky ? icon('wifi-slash') : null, h('strong', null, name), ' ',
        h('span', { class: 'muted' }, x.shaky ? 'connection dropped, waiting for it to come back…'
          : x.syncing || !x.lastSync ? 'syncing…' : `in sync, ${ago(x.lastSync)}`)),
      button('Disconnect', () => sync.close(x.id), { class: 'small', icon: 'link-break' }))];
      break;
    case 'failed': body = [h('p', { class: 'error-text' }, x.error), row(button('Dismiss', () => sync.close(x.id), { class: 'small' }))]; break;
    default:
      body = [row(h('span', { class: 'grow' }, `Disconnected from ${name}.`, x.lastSync ? ` Last synced ${ago(x.lastSync)}.` : ''),
        button('Dismiss', () => sync.close(x.id), { class: 'small' }))];
  }
  return h('div', { class: 'pairing' }, body);
}

/* The camera, to read a code off the other device's screen, or a box to
   paste it into where there is no camera. */
let scanning = null;

async function openScanner() {
  const dialog = $('scanner');
  $('scanError').hidden = true;
  $('scanPaste').value = '';
  dialog.showModal();
  scanning?.abort();
  scanning = new AbortController();
  const { signal } = scanning;
  try {
    const text = await scan($('scanVideo'), signal);
    if (text) await useCode(text);
  } catch (err) {
    if (signal.aborted) return;
    $('scanVideo').hidden = true;
    $('scanError').textContent = err.name === 'NotAllowedError' || err.name === 'NotFoundError'
      ? 'No camera to use here. Paste the code instead.'
      : err.message;
    $('scanError').hidden = false;
  }
}

async function useCode(text) {
  try {
    const code = sync.readCode(text);
    scanning?.abort();
    $('scanner').close();
    await sync.take(text);
    openSettings('sync');
    if (code.kind === 'offer') flash(`Show the reply to ${code.name}`);
  } catch (err) {
    $('scanError').textContent = err.message;
    $('scanError').hidden = false;
    if (!$('scanner').open) status(err.message, true);
  }
}

$('scanUse').addEventListener('click', () => useCode($('scanPaste').value));
$('scanner').addEventListener('close', () => { scanning?.abort(); $('scanVideo').hidden = false; });
$('scanCancel').addEventListener('click', () => $('scanner').close());

function backupSection() {
  const out = [];
  const saved = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
  const keep = patch => localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}'), ...patch }));
  const phrase = h('input', {
    type: 'password', value: saved.passphrase || '', autocomplete: 'new-password', placeholder: 'none',
    onchange: e => keep({ passphrase: e.target.value }),
  });

  if (!backup.configured()) {
    out.push(note('Backups to Google Drive are not set up on this copy of Tasks. You can still save everything to a file.'));
  } else {
    const me = backup.account();
    if (!me) {
      out.push(note('Back up to your own Google Drive. Sign in with your ivx account, connect Google there once, and Tasks sends its backups straight to your Drive. ivx never sees or keeps them.'),
        row(button('Sign in with ivx', () => attempt(backup.signIn), { class: 'primary', icon: 'sign-in' })));
    } else {
      out.push(row(h('span', { class: 'grow' }, 'Signed in as ', h('strong', null, me.email || 'your ivx account')),
        button('Sign out', () => attempt(async () => { await backup.signOut(); renderSettings(); }), { class: 'small', icon: 'sign-out' })));
      const drive = h('p', { class: 'muted' }, 'Checking Google Drive…');
      out.push(drive);
      backup.googleStatus().then(g => {
        drive.replaceChildren(...(g.connected
          ? [`Google Drive: ${g.email || 'connected'}. `]
          : ['Google Drive is not connected. ',
            h('a', { href: backup.connectUrl(), target: '_blank', rel: 'noopener' }, 'Connect it on your ivx account'),
            ', then come back here.']));
      }, err => drive.replaceChildren(err.message));

      out.push(row(h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: Boolean(saved.auto), onchange: e => { keep({ auto: e.target.checked }); autoBackup(); } }),
        ' Back up every day while Tasks is open')),
      row(button('Back up now', () => attempt(async () => {
        keep({ last: await backup.backUp(phrase.value) });
        flash('Backed up to Google Drive');
        renderSettings();
      }), { class: 'primary', icon: 'cloud-arrow-up' }),
      button('Restore from Drive', () => attempt(async () => {
        const n = await backup.restore(phrase.value);
        flash(n ? `Restored ${n} change${n === 1 ? '' : 's'}` : 'Nothing to restore: Tasks already has all of it');
      }), { icon: 'cloud-arrow-down' })),
      saved.last ? note(`Last backup ${ago(saved.last)}.${saved.error ? ` The last automatic one failed: ${saved.error}` : ''}`) : null);
    }
  }
  out.push(row(h('label', { class: 'grow' }, 'Passphrase ', phrase)),
    note('With a passphrase, backups are encrypted here before they leave, so only you can read them. Without the passphrase they cannot be restored, by anyone.'),
    row(button('Save to a file', () => attempt(async () => {
      const text = await backup.pack(phrase.value);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      h('a', { href: url, download: `ivx-tasks-${today()}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }), { icon: 'download-simple' }),
    h('label', { class: 'button' }, icon('upload-simple'), 'Restore from a file',
      h('input', {
        type: 'file', accept: 'application/json,.json', hidden: true,
        onchange: e => attempt(async () => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          const n = await backup.unpack(await file.text(), phrase.value);
          flash(n ? `Restored ${n} change${n === 1 ? '' : 's'}` : 'Nothing to restore: Tasks already has all of it');
        }),
      }))),
    note('Restoring merges: whatever changed last, here or in the backup, is what you keep.'));
  return section('Backup', out);
}

let settingsScroll = 0;
function renderSettings() {
  const body = $('settingsBody');
  settingsScroll = body.scrollTop;
  // A field being typed in is left alone; the next render after it picks up.
  if (body.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), select')) return;
  body.replaceChildren(notifySection(), syncSection(), backupSection(), cleanupSection());
  body.scrollTop = settingsScroll;
}

function openSettings(focus) {
  renderSettings();
  if (!$('settings').open) $('settings').showModal();
  if (focus === 'sync') $('settingsBody').querySelectorAll('.setting')[1]?.scrollIntoView({ block: 'start' });
}

$('openSettings').addEventListener('click', () => openSettings());
$('closeSettings').addEventListener('click', () => $('settings').close());

/** Back up once a day, quietly, when the person asked for it. */
async function autoBackup() {
  const saved = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
  if (!saved.auto || !backup.configured() || !backup.account()) return;
  if (saved.last && Date.now() - saved.last < DAY) return;
  try {
    const last = await backup.backUp(saved.passphrase || '');
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...saved, last, error: '' }));
  } catch (err) {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...saved, error: err.message }));
  }
}

/* ── the rest of the page ──────────────────────────────────── */

/* The header's word on sync: how it is going while connected, and
   otherwise a nudge back to the device last synced with, which the person
   can take or leave. */
function syncLine() {
  const s = sync.status();
  const open = s.sessions.filter(x => x.stage === 'open');
  const last = s.known[0];
  let content = '';
  if (open.length) {
    content = open.some(x => x.shaky) ? 'Connection dropped, waiting…'
      : open.some(x => x.syncing) ? 'Syncing…'
        : `In sync with ${open.length === 1 ? open[0].peerName : `${open.length} devices`}`;
  } else if (last && !s.sessions.some(x => !['failed', 'closed'].includes(x.stage))) {
    content = button(`${last.lastSync ? `Last synced with ${last.name}, ${ago(last.lastSync)}` : `Sync with ${last.name}`}`,
      () => openSettings('sync'), { class: 'link-button sync-nudge', icon: 'arrows-clockwise' });
  }
  $('syncLine').replaceChildren(content);
}

$('add').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('addTitle').value.trim();
  if (!title) return;
  $('addTitle').value = '';
  attempt(() => addTask(title));
});

$('newList').addEventListener('click', () => {
  const name = prompt('New list')?.trim();
  if (!name) return;
  const id = newId();
  attempt(async () => {
    await store.put({ id, kind: 'list', name, order: Math.max(0, ...lists().map(l => l.order ?? 0)) + 1 });
    go({ type: 'list', id });
  });
});

for (const el of document.querySelectorAll('.nav[data-view]')) {
  el.addEventListener('click', () => go({ type: el.dataset.view }));
}

$('asList').addEventListener('click', () => { ui.mode = 'list'; saveUi(); render(); });
$('asBoard').addEventListener('click', () => { ui.mode = 'board'; saveUi(); render(); });

function closeSide() {
  document.body.classList.remove('side-open');
  $('menu').setAttribute('aria-expanded', 'false');
}
$('menu').addEventListener('click', () => {
  const open = document.body.classList.toggle('side-open');
  $('menu').setAttribute('aria-expanded', String(open));
});

/** A notification's button, from the service worker or a fresh page's URL. */
async function act(id, what) {
  const task = store.get(id);
  if (!task) return;
  if (what === 'done') {
    if (task.status !== 'done') await setDone(task, true);
    flash(`Done: ${task.title}`);
  } else if (what === 'snooze') {
    await store.put({ id, snooze: Date.now() + 10 * 60_000 });
    flash('Snoozed for 10 minutes');
  } else {
    openEditor(task);
  }
}

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'ivx-task') attempt(() => act(e.data.task, e.data.act));
});

/* ── start ─────────────────────────────────────────────────── */

async function boot() {
  await store.open();
  await ensureList();
  await tidy();
  render();

  let renderTimer = null;
  store.changes.addEventListener('change', () => {
    cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(render);
    notify.check();
  });

  // Back from signing in: show where they were, in Settings.
  const returning = new URLSearchParams(location.search).has('code');
  const signInError = await backup.finishSignIn();
  if (signInError) status(signInError, true);
  else if (returning) openSettings();

  const params = new URLSearchParams(location.search);
  if (params.has('task')) {
    history.replaceState(null, '', location.pathname);
    await attempt(() => act(params.get('task'), params.get('act')));
  }

  notify.start({
    tasks,
    when: (task, kind) => kind === 'end'
      ? `${time(task.end)} · ${listName(task.listId)}`
      : [when(task), listName(task.listId)].filter(Boolean).join(' · '),
  });

  sync.subscribe(() => {
    syncLine();
    if ($('settings').open) renderSettings();
  });
  await sync.init({ onApplied: () => render() });
  syncLine();

  // Opened from another device's sync code (a phone's camera app follows the link here).
  const shared = location.hash.match(/^#sync=(.+)$/)?.[1];
  if (shared) {
    history.replaceState(null, '', location.pathname + location.search);
    await attempt(async () => {
      const { name } = sync.readCode(shared);
      if (confirm(`Sync Tasks with ${name}? Both keep everything either of them has.`)) {
        await sync.take(shared);
        openSettings('sync');
      }
    });
  }

  // Each minute: a new day changes what Upcoming shows; each hour, tidy up and back up.
  let day = today();
  let hour = 0;
  setInterval(() => {
    if (day !== today()) { day = today(); render(); }
    syncLine();
    if (++hour >= 60) { hour = 0; tidy(); autoBackup(); }
  }, 60_000);
  autoBackup();
}

boot().catch(err => {
  console.error(err);
  status(err.message, true);
});
