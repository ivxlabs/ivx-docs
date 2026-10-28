// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Checks Tasks' rules, outside the browser:
     node tools/tasks-test.mjs

   Repeats, the Upcoming list and its order, reminders and the clean-up
   schedule: the parts that are easy to get subtly wrong and tedious to
   click through. */

import assert from 'node:assert/strict';
import {
  DAY, at, complete, describeRepeat, nextDate, range, reminders, series, sweep, upcoming, weekStart,
} from '../src/tasks/model.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const task = fields => ({
  id: fields.title ?? Math.random().toString(36).slice(2), kind: 'task', listId: 'default', title: '',
  status: 'todo', starred: false, date: '', start: '', end: '', repeat: null, order: 0,
  completedAt: 0, archivedAt: 0, trashedAt: 0, snooze: 0, ...fields,
});

test('daily and every-n-days repeats', () => {
  assert.equal(nextDate({ every: 1, unit: 'day' }, '2026-10-31'), '2026-11-01');
  assert.equal(nextDate({ every: 3, unit: 'day' }, '2026-12-30'), '2027-01-02');
});

test('weekly repeats on chosen days, every n weeks', () => {
  const weekdays = { every: 1, unit: 'week', days: [1, 2, 3, 4, 5] };
  assert.equal(nextDate(weekdays, '2026-10-30'), '2026-11-02'); // Fri → Mon
  assert.equal(nextDate(weekdays, '2026-10-27'), '2026-10-28'); // Tue → Wed
  const fortnightly = { every: 2, unit: 'week', days: [1, 4] };   // Mon and Thu, every other week
  assert.equal(nextDate(fortnightly, '2026-10-26'), '2026-10-29'); // Mon → Thu, same week
  assert.equal(nextDate(fortnightly, '2026-10-29'), '2026-11-09'); // Thu → Mon two weeks on
  assert.equal(nextDate({ every: 1, unit: 'week' }, '2026-10-28'), '2026-11-04'); // no days: same weekday
});

test('monthly and yearly repeats keep their day', () => {
  const monthly = { every: 1, unit: 'month', day: 31 };
  assert.equal(nextDate(monthly, '2026-01-31'), '2026-02-28');
  assert.equal(nextDate(monthly, '2026-02-28'), '2026-03-31');
  assert.equal(nextDate({ every: 1, unit: 'year', day: 29 }, '2028-02-29'), '2029-02-28');
});

test('repeats end on a date or after a count', () => {
  assert.equal(nextDate({ every: 1, unit: 'day', ends: { on: '2026-11-01' } }, '2026-11-01'), null);
  assert.equal(nextDate({ every: 1, unit: 'day', ends: { after: 3 }, n: 3 }, '2026-11-01'), null);
  assert.equal(nextDate({ every: 1, unit: 'day', ends: { after: 3 }, n: 2 }, '2026-11-01'), '2026-11-02');
});

test('completing a repeating task adds the next one and lets go of the rule', () => {
  const t = task({ title: 'standup', date: '2026-10-30', start: '09:30', end: '09:45', repeat: { every: 1, unit: 'week', days: [1, 2, 3, 4, 5] } });
  const { done, next } = complete(t, 1000, 'next-id');
  assert.equal(done.status, 'done');
  assert.equal(done.repeat, null);
  assert.equal(next.id, 'next-id');
  assert.equal(next.date, '2026-11-02');
  assert.equal(next.start, '09:30');
  assert.equal(next.end, '09:45');
  assert.equal(next.repeat.n, 2);
  assert.equal(next.status, 'todo');
  assert.equal(complete(task({ date: '2026-10-30' }), 1, 'x').next, null);
});

test('moving one occurrence leaves the series where it was', () => {
  // Monthly on the 28th, at 10:00; this month's moved to the 29th at 14:00.
  const moved = task({
    title: 'rent', date: '2026-10-29', start: '14:00', slot: '2026-10-28',
    repeat: { every: 1, unit: 'month', day: 28, start: '10:00', end: '' },
  });
  const { next } = complete(moved, 1, 'n');
  assert.equal(next.date, '2026-11-28');
  assert.equal(next.slot, '2026-11-28');
  assert.equal(next.start, '10:00');
  assert.deepEqual(series(next), { slot: '2026-11-28', start: '10:00', end: '' });
});

test('moving a daily one forward does not put two on one day', () => {
  const moved = task({ date: '2026-10-29', slot: '2026-10-28', repeat: { every: 1, unit: 'day' } });
  assert.equal(complete(moved, 1, 'n').next.date, '2026-10-30');
  const early = task({ date: '2026-10-27', slot: '2026-10-28', repeat: { every: 1, unit: 'day' } });
  assert.equal(complete(early, 1, 'n').next.date, '2026-10-29');
});

test('a task from before slots keeps working', () => {
  const old = task({ date: '2026-10-28', start: '09:00', repeat: { every: 1, unit: 'week', days: [3] } });
  const { next } = complete(old, 1, 'n');
  assert.equal(next.date, '2026-11-04');
  assert.equal(next.start, '09:00');
  assert.equal(next.slot, '2026-11-04');
});

test('a count still counts the occurrences skipped over', () => {
  const t = task({ date: '2026-10-30', slot: '2026-10-28', repeat: { every: 1, unit: 'day', ends: { after: 3 }, n: 1 } });
  // Slots 29 (n 2) and 30 (n 3) are passed; the 31st would be a fourth.
  assert.equal(complete(t, 1, 'n').next, null);
});

test('describing a rule', () => {
  assert.equal(describeRepeat({ every: 1, unit: 'week', days: [1, 2, 3, 4, 5] }), 'Every weekday');
  assert.equal(describeRepeat({ every: 2, unit: 'month' }), 'Every 2 months');
  assert.equal(describeRepeat({ every: 1, unit: 'day', ends: { after: 5 } }), 'Every day, 5 times');
});

test('ranges look forward from today', () => {
  assert.equal(weekStart('2026-10-28', 1), '2026-10-26');
  assert.equal(weekStart('2026-10-28', 0), '2026-10-25');
  assert.deepEqual(range('today', '2026-10-28'), ['2026-10-28', '2026-10-28']);
  assert.deepEqual(range('week', '2026-10-28', 1), ['2026-10-28', '2026-11-01']);
  assert.deepEqual(range('month', '2026-10-28'), ['2026-10-28', '2026-10-31']);
  assert.deepEqual(range('month', '2026-02-10'), ['2026-02-10', '2026-02-28']);
  assert.deepEqual(range('next7', '2026-12-28'), ['2026-12-28', '2027-01-03']);
  assert.deepEqual(range('custom', '2026-10-28', 1, { from: '2026-11-01', to: '2026-11-05' }), ['2026-11-01', '2026-11-05']);
});

test('Upcoming sorts by time, then starred, across lists', () => {
  const tasks = [
    task({ title: 'a', listId: 'work', date: '2026-10-28', start: '15:00', order: 1 }),
    task({ title: 'b', listId: 'home', date: '2026-10-28', start: '15:00', order: 2 }),
    task({ title: 'starred', listId: 'home', date: '2026-10-28', start: '15:00', order: 3, starred: true }),
    task({ title: 'c', listId: 'work', date: '2026-10-28', start: '15:00', order: 4 }),
    task({ title: 'd', listId: 'work', date: '2026-10-28', start: '15:00', order: 5 }),
    task({ title: 'morning', date: '2026-10-28', start: '09:00' }),
    task({ title: 'all day', date: '2026-10-28' }),
    task({ title: 'tomorrow', date: '2026-10-29', start: '08:00' }),
    task({ title: 'late', date: '2026-10-20', start: '10:00' }),
    task({ title: 'done', date: '2026-10-28', status: 'done' }),
    task({ title: 'trashed', date: '2026-10-28', trashedAt: 5 }),
    task({ title: 'later', date: '2026-11-15' }),
    task({ title: 'undated' }),
  ];
  const groups = upcoming(tasks, { from: '2026-10-28', to: '2026-11-01', day: '2026-10-28' });
  assert.deepEqual(groups.map(g => g.key), ['overdue', '2026-10-28', '2026-10-29']);
  assert.deepEqual(groups[0].items.map(t => t.title), ['late']);
  assert.deepEqual(groups[1].items.map(t => t.title), ['all day', 'morning', 'starred', 'a', 'b', 'c', 'd']);
  const noOverdue = upcoming(tasks, { from: '2026-10-28', to: '2026-10-28', day: '2026-10-28', overdue: false });
  assert.deepEqual(noOverdue.map(g => g.key), ['2026-10-28']);
});

test('reminders: at the start less the lead, the end of a block, all-day, snooze', () => {
  const t = task({ id: 't', date: '2026-10-28', start: '15:00', end: '16:30' });
  const r = reminders(t, { lead: 10, blockEnd: true });
  assert.deepEqual(r.map(x => x.kind), ['start', 'end']);
  assert.equal(r[0].at, at('2026-10-28', '15:00') - 10 * 60_000);
  assert.equal(r[1].at, at('2026-10-28', '16:30'));
  assert.deepEqual(reminders(t, { blockEnd: false }).map(x => x.kind), ['start']);
  assert.deepEqual(reminders(task({ date: '2026-10-28' }), { allDay: '08:30' }).map(x => x.at), [at('2026-10-28', '08:30')]);
  assert.deepEqual(reminders(task({ date: '2026-10-28' }), { allDay: '' }), []);
  assert.deepEqual(reminders({ ...t, status: 'done' }), []);
  assert.ok(reminders({ ...t, snooze: 42 }).some(x => x.kind === 'snooze' && x.at === 42));
});

test('clean-up: done → archive → trash → gone, each on its own clock', () => {
  const rules = { archive: 30, trash: 7, purge: 14 };
  const done = task({ status: 'done', completedAt: 1_000 });
  assert.equal(sweep(done, rules, 1_000 + 29 * DAY), null);
  assert.deepEqual(sweep(done, rules, 1_000 + 31 * DAY), { archivedAt: 1_000 + 30 * DAY });
  const archived = { ...done, archivedAt: 1_000 + 30 * DAY };
  assert.deepEqual(sweep(archived, rules, 1_000 + 40 * DAY), { trashedAt: 1_000 + 37 * DAY });
  const trashed = { ...archived, trashedAt: 1_000 + 37 * DAY };
  assert.equal(sweep(trashed, rules, 1_000 + 50 * DAY), null);
  assert.equal(sweep(trashed, rules, 1_000 + 51 * DAY), 'purge');
  assert.equal(sweep(done, { ...rules, archive: 0 }, 1_000 + 999 * DAY), null);   // never
  assert.equal(sweep(task({}), rules, 1e15), null);                                // open tasks stay
});

console.log(`${passed} passed`);
