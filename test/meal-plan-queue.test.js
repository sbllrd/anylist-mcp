import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient from '../src/anylist-client.js';

const require = createRequire(import.meta.url);
const MealPlanningCalendarEvent = require('../anylist-js/lib/meal-planning-calendar-event.js');

// Records what _encode() would send to AnyList.
const protobuf = { PBCalendarEvent: function (fields) { Object.assign(this, fields); } };
const ctx = { client: null, protobuf, uid: 'u', calendarId: 'c' };

test('an event from AnyList with no date is queued, not today', () => {
  for (const date of [undefined, null, '']) {
    const e = new MealPlanningCalendarEvent({ identifier: 'e1', date, recipeId: 'r1' }, ctx);
    assert.equal(e.date, null);
    assert.equal(e.isQueued, true);
    assert.equal(e._encode().date, undefined, 'saving or deleting it must not put it on a day');
  }
});

test('a dated event keeps its date, and a brand-new event still defaults to now', () => {
  const dated = new MealPlanningCalendarEvent({ identifier: 'e2', date: '2026-11-23' }, ctx);
  assert.equal(dated.isQueued, false);
  assert.equal(dated.date.toISOString().slice(0, 10), '2026-11-23');
  const fresh = new MealPlanningCalendarEvent({ title: 'New' }, ctx);
  assert.ok(fresh.date instanceof Date && !fresh.isQueued);
});

test('getMealPlanEvents reports queued events with a null date', async () => {
  const c = new AnyListClient({ username: 'x', password: 'y' });
  c.client = {
    getMealPlanningCalendarEvents: async () => [
      new MealPlanningCalendarEvent({ identifier: 'a', date: '2026-11-23', title: 'Pot Roast' }, ctx),
      new MealPlanningCalendarEvent({ identifier: 'b', title: 'Mushroom Soup' }, ctx),
    ],
  };
  const events = await c.getMealPlanEvents();
  assert.deepEqual(events.map(e => [e.identifier, e.date, e.queued]), [['a', '2026-11-23', false], ['b', null, true]]);
});
