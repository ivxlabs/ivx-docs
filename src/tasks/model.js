// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* What a task is and what time does to it, without the browser: dates,
   repeats, the Upcoming list, reminders and the clean-up schedule. Pure
   functions over plain records, so tools/tasks-test.mjs can check them.

   A task:

     id, kind: 'task', listId, title, notes
     status    'todo' | 'doing' | 'done'
     starred   boolean
     date      'YYYY-MM-DD' or ''; the day it is for
     start     'HH:MM' or ''; when it is due, or when its time block starts
     end       'HH:MM' or ''; when its time block ends (needs a start)
     repeat    null, or { every, unit: 'day'|'week'|'month'|'year',
                 days: [0-6] for weeks, ends: { after?: n, on?: date },
                 n: which occurrence this is }
     snooze    epoch ms; remind again then instead
     order     its place in its list, smallest first
     completedAt, archivedAt, trashedAt   epoch ms, or 0

   Times are the device's local time: a task for 15:00 means 15:00 wherever
   the person is when it comes round. */

export const DAY = 86_400_000;

/* ── dates ─────────────────────────────────────────────────── */

const pad = n => String(n).padStart(2, '0');

export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const today = (now = Date.now()) => isoDate(new Date(now));

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** `s` moved by `n` months, keeping `day` where the month has it. */
function addMonths(s, n, day) {
  const d = parseDate(s);
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  first.setDate(Math.min(day, daysInMonth(first.getFullYear(), first.getMonth())));
  return isoDate(first);
}

export const weekday = s => parseDate(s).getDay();

/** The first day of the week `s` is in, weeks starting on `firstDay` (0 Sunday). */
export const weekStart = (s, firstDay = 1) => addDays(s, -((weekday(s) - firstDay + 7) % 7));

/** Whole days from `a` to `b`, across clock changes. */
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);

/** A moment: date at time, local. */
export function at(date, time = '00:00') {
  const d = parseDate(date);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/* ── repeating ─────────────────────────────────────────────── */

/**
 * The date of the occurrence after the one on `date`, or null when the rule
 * has run out. Months and years keep the day of the month they started on,
 * falling back to the month's last day when it is shorter.
 */
export function nextDate(rule, date, firstDay = 1) {
  if (!rule || !date) return null;
  const every = Math.max(1, Math.floor(rule.every) || 1);
  let next;
  if (rule.unit === 'day') {
    next = addDays(date, every);
  } else if (rule.unit === 'week') {
    const days = rule.days?.length ? rule.days : [weekday(date)];
    const base = weekStart(date, firstDay);
    for (let i = 1; i <= every * 7 + 7 && !next; i++) {
      const d = addDays(date, i);
      const weeks = daysBetween(base, weekStart(d, firstDay)) / 7;
      if (weeks % every === 0 && days.includes(weekday(d))) next = d;
    }
  } else if (rule.unit === 'month' || rule.unit === 'year') {
    const day = rule.day || parseDate(date).getDate();
    next = addMonths(date, rule.unit === 'month' ? every : every * 12, day);
  } else {
    return null;
  }
  if (rule.ends?.on && next > rule.ends.on) return null;
  if (rule.ends?.after && (rule.n || 1) >= rule.ends.after) return null;
  return next;
}

/**
 * Completing `task`: the changes to it, and the next occurrence to add when
 * it repeats. The done one lets go of its rule, so ticking it off and on
 * again cannot spawn a second next one.
 */
export function complete(task, now, newId, firstDay = 1) {
  const done = { status: 'done', completedAt: now, snooze: 0 };
  const date = task.repeat && nextDate(task.repeat, task.date, firstDay);
  if (!date) return { done, next: null };
  return {
    done: { ...done, repeat: null },
    next: {
      ...task,
      id: newId,
      status: 'todo',
      date,
      repeat: { ...task.repeat, n: (task.repeat.n || 1) + 1 },
      completedAt: 0, archivedAt: 0, trashedAt: 0, snooze: 0,
    },
  };
}

/** The rule as a person would say it. */
export function describeRepeat(rule, names = WEEKDAYS) {
  if (!rule) return '';
  const every = Math.max(1, rule.every || 1);
  let text;
  if (rule.unit === 'week' && rule.days?.length) {
    const days = [...rule.days].sort().map(d => names[d]).join(', ');
    text = every === 1 ? `Every week on ${days}` : `Every ${every} weeks on ${days}`;
    if (every === 1 && rule.days.length === 5 && [1, 2, 3, 4, 5].every(d => rule.days.includes(d))) text = 'Every weekday';
  } else {
    const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[rule.unit];
    text = every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  }
  if (rule.ends?.on) text += `, until ${rule.ends.on}`;
  if (rule.ends?.after) text += `, ${rule.ends.after} times`;
  return text;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ── where a task is ───────────────────────────────────────── */

export const isOpen = t => t.status !== 'done' && !t.archivedAt && !t.trashedAt;
export const isLive = t => !t.archivedAt && !t.trashedAt;
export const isArchived = t => t.archivedAt && !t.trashedAt;
export const isTrashed = t => Boolean(t.trashedAt);

/** By time, then starred first, then where they sit in their list. */
export function byTime(a, b) {
  return (a.date || '9999').localeCompare(b.date || '9999')
    || (a.start || '').localeCompare(b.start || '')
    || Number(Boolean(b.starred)) - Number(Boolean(a.starred))
    || (a.order ?? 0) - (b.order ?? 0)
    || a.id.localeCompare(b.id);
}

/** In list order, starred or not: the person put them there. */
export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

/**
 * The span a range name covers, from `day` (today), as inclusive dates.
 * Ranges look forward: what is earlier than today is overdue, not upcoming.
 */
export function range(name, day, firstDay = 1, custom = {}) {
  const end = {
    today: day,
    tomorrow: addDays(day, 1),
    week: addDays(weekStart(day, firstDay), 6),
    next7: addDays(day, 6),
    month: addDays(addMonths(day, 1, 1), -1),
    next30: addDays(day, 29),
    all: '9999-12-31',
  }[name];
  if (name === 'tomorrow') return [end, end];
  if (name === 'custom') return [custom.from || day, custom.to || custom.from || day];
  return [day, end ?? day];
}

/**
 * Upcoming: open tasks dated within [from, to] from every list, grouped by
 * day and sorted by time, starred first among the same time. With `overdue`,
 * open tasks dated before today come first, in a group of their own.
 */
export function upcoming(tasks, { from, to, day, overdue = true }) {
  const groups = new Map();
  const add = (key, task) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  };
  for (const t of tasks) {
    if (!isOpen(t) || !t.date) continue;
    if (t.date < day) {
      if (overdue && from <= day) add('overdue', t);
    } else if (t.date >= from && t.date <= to) {
      add(t.date, t);
    }
  }
  return [...groups.keys()]
    .sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a.localeCompare(b)))
    .map(key => ({ key, items: groups.get(key).sort(byTime) }));
}

/* ── reminders ─────────────────────────────────────────────── */

/**
 * Every reminder `task` has: at its start (less `lead` minutes), at the end
 * of its time block when `blockEnd` is on, and for a task with a day but no
 * time, at `allDay` ('HH:MM', or '' for none). A snooze replaces the first.
 */
export function reminders(task, { lead = 0, allDay = '09:00', blockEnd = true } = {}) {
  if (!isOpen(task) || !task.date) return [];
  const out = [];
  if (task.start) {
    out.push({ kind: 'start', at: at(task.date, task.start) - lead * 60_000 });
    if (blockEnd && task.end) out.push({ kind: 'end', at: at(task.date, task.end) });
  } else if (allDay) {
    out.push({ kind: 'day', at: at(task.date, allDay) });
  }
  if (task.snooze) out.push({ kind: 'snooze', at: task.snooze });
  return out.map(r => ({ ...r, key: `${task.id}:${r.kind}:${r.at}` }));
}

/* ── clean-up ──────────────────────────────────────────────── */

export const DEFAULT_CLEANUP = { archive: 30, trash: 30, purge: 30 };

/**
 * What time has done to `task` under `cleanup` (days for each step, or 0 for
 * never): { archivedAt }, { trashedAt }, 'purge', or null for nothing. The
 * new moments are where the step fell due, not now, so two devices sweeping
 * the same task agree on it.
 */
export function sweep(task, cleanup, now) {
  const due = (since, days) => days > 0 && since && since + days * DAY <= now && since + days * DAY;
  if (task.trashedAt) return due(task.trashedAt, cleanup.purge) ? 'purge' : null;
  if (task.archivedAt) {
    const when = due(task.archivedAt, cleanup.trash);
    return when ? { trashedAt: when } : null;
  }
  if (task.status === 'done') {
    const when = due(task.completedAt, cleanup.archive);
    return when ? { archivedAt: when } : null;
  }
  return null;
}
