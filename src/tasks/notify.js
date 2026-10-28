// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Reminders, as the browser's own notifications.

   There is no server to wake this page at three o'clock, and browsers have
   no way to schedule a notification for later, so reminders come from the
   page while it is open: in a tab, even a background one, or installed as an
   app. Every minute it looks for reminders that have come due and shows
   them. Ones that fell due while it was closed are shown when it opens, if
   they are recent, together in one notification rather than a flood.

   Notifications go through the service worker (public/sw.js), which is the
   only way Android shows them at all, and the only way they get buttons:
   Mark done and Snooze come back here as a message, or as ?task=…&act=… on
   a fresh page when Tasks was closed.

   The settings are this device's own: a phone may want reminders that a
   laptop does not. */

import { reminders } from './model.js';

const SETTINGS_KEY = 'ivx-tasks-notify';
const SHOWN_KEY = 'ivx-tasks-notified';
const TICK = 60_000;
/** How late a missed reminder may still be shown on opening. */
const GRACE = 6 * 3_600_000;

export const DEFAULTS = { lead: 0, allDay: '09:00', blockEnd: true };

export function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function saveSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...next }));
  check();
}

export const supported = () => 'Notification' in globalThis && 'serviceWorker' in navigator;
export const permission = () => (supported() ? Notification.permission : 'unsupported');

/** Ask to show notifications. Must come from a click. */
export async function ask() {
  if (!supported()) return 'unsupported';
  const answer = await Notification.requestPermission();
  check();
  return answer;
}

/* Which reminders have been shown, by key, so a reload or a second tab does
   not show one twice. Old keys are let go of. */
function shown() {
  try { return JSON.parse(localStorage.getItem(SHOWN_KEY) || '{}'); } catch { return {}; }
}

function remember(keys, now) {
  const seen = shown();
  for (const k of keys) seen[k] = now;
  for (const [k, when] of Object.entries(seen)) if (now - when > 3 * GRACE) delete seen[k];
  localStorage.setItem(SHOWN_KEY, JSON.stringify(seen));
}

let source = () => [];
let describe = () => '';
let timer = null;

/**
 * Start reminding. `tasks()` gives every task; `when(task)` the line under
 * its title in a notification.
 */
export function start({ tasks, when }) {
  source = tasks;
  describe = when;
  check();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

/** Show whatever has come due. Called each minute and after any change. */
export async function check() {
  clearTimeout(timer);
  timer = setTimeout(check, TICK);
  if (permission() !== 'granted') return;

  // One tab speaks for the browser, so two open tabs do not both remind.
  const run = async () => {
    const now = Date.now();
    const seen = shown();
    const due = [];
    for (const task of source()) {
      for (const r of reminders(task, settings())) {
        if (r.at <= now && now - r.at < GRACE && !seen[r.key]) due.push({ task, ...r });
      }
    }
    if (!due.length) return;
    remember(due.map(d => d.key), now);
    const reg = await navigator.serviceWorker.ready;
    const late = due.filter(d => now - d.at > 2 * TICK);
    const fresh = due.filter(d => now - d.at <= 2 * TICK);
    for (const d of fresh) await show(reg, d);
    if (late.length === 1) await show(reg, late[0]);
    else if (late.length > 1) {
      await reg.showNotification(`${late.length} reminders while Tasks was closed`, {
        body: late.slice(0, 5).map(d => d.task.title || 'Untitled task').join('\n'),
        tag: 'ivx-tasks-missed',
        icon: '../icons/icon-192.png',
        data: { page: location.href.split(/[?#]/)[0] },
      });
    }
  };
  if (navigator.locks?.request) await navigator.locks.request('ivx-tasks-notify', { ifAvailable: true }, lock => lock && run());
  else await run();
}

function show(reg, { task, kind }) {
  const title = kind === 'end' ? `Time's up: ${task.title || 'Untitled task'}` : task.title || 'Untitled task';
  return reg.showNotification(title, {
    body: describe(task, kind),
    tag: `ivx-task-${task.id}`,
    renotify: true,
    icon: '../icons/icon-192.png',
    badge: '../icons/icon-192.png',
    data: { page: location.href.split(/[?#]/)[0], task: task.id },
    actions: kind === 'end' ? [{ action: 'done', title: 'Mark done' }]
      : [{ action: 'done', title: 'Mark done' }, { action: 'snooze', title: 'Snooze 10 min' }],
  });
}
