import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/meal-plan.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('meal_plan tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list_events', () => {
    it('returns empty message when no events', async () => {
      const result = await handlers.meal_plan({ action: 'list_events' });
      assert.ok(result.content[0].text.includes('No meal plan events'));
    });

    it('lists events sorted by date', async () => {
      client._events.push(
        { date: '2025-02-10', title: 'Tacos', identifier: 'e1' },
        { date: '2025-02-08', title: 'Pizza', identifier: 'e2' },
      );
      const result = await handlers.meal_plan({ action: 'list_events' });
      const t = result.content[0].text;
      assert.ok(t.indexOf('2025-02-08') < t.indexOf('2025-02-10'));
    });

    it('includes event identifier in output', async () => {
      client._events.push({ date: '2025-03-01', title: 'Sushi', identifier: 'e-abc' });
      const result = await handlers.meal_plan({ action: 'list_events' });
      assert.ok(result.content[0].text.includes('e-abc'));
    });

    it('filters events by start_date', async () => {
      client._events.push(
        { date: '2025-04-01', title: 'Early', identifier: 'e-early' },
        { date: '2025-04-10', title: 'Mid', identifier: 'e-mid' },
        { date: '2025-04-20', title: 'Late', identifier: 'e-late' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', start_date: '2025-04-10' });
      const t = result.content[0].text;
      assert.ok(!t.includes('2025-04-01'), 'event before start_date should be excluded');
      assert.ok(t.includes('2025-04-10'), 'event on start_date should be included');
      assert.ok(t.includes('2025-04-20'), 'event after start_date should be included');
    });

    it('filters events by end_date', async () => {
      client._events.push(
        { date: '2025-05-01', title: 'Early', identifier: 'f-early' },
        { date: '2025-05-10', title: 'Mid', identifier: 'f-mid' },
        { date: '2025-05-20', title: 'Late', identifier: 'f-late' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', end_date: '2025-05-10' });
      const t = result.content[0].text;
      assert.ok(t.includes('2025-05-01'), 'event before end_date should be included');
      assert.ok(t.includes('2025-05-10'), 'event on end_date should be included');
      assert.ok(!t.includes('2025-05-20'), 'event after end_date should be excluded');
    });

    it('filters events by start_date and end_date range', async () => {
      client._events.push(
        { date: '2025-06-01', title: 'Before', identifier: 'g-before' },
        { date: '2025-06-05', title: 'InRange', identifier: 'g-in' },
        { date: '2025-06-10', title: 'After', identifier: 'g-after' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', start_date: '2025-06-03', end_date: '2025-06-07' });
      const t = result.content[0].text;
      assert.ok(!t.includes('2025-06-01'), 'event before range should be excluded');
      assert.ok(t.includes('2025-06-05'), 'event in range should be included');
      assert.ok(!t.includes('2025-06-10'), 'event after range should be excluded');
    });

    it('returns empty message when date filter excludes all events', async () => {
      client._events.push({ date: '2025-07-15', title: 'Lonely', identifier: 'h-lonely' });
      const result = await handlers.meal_plan({ action: 'list_events', start_date: '2025-08-01' });
      assert.ok(result.content[0].text.includes('No meal plan events'));
    });

    it('lists queued events (no date) in their own section, not on a day', async () => {
      client._events.push(
        { date: '2025-11-23', recipeName: 'Pot Roast', identifier: 'q-today' },
        { date: null, queued: true, recipeName: 'Mushroom Soup', identifier: 'q-1' },
      );
      const t = (await handlers.meal_plan({ action: 'list_events', start_date: '2025-11-23', end_date: '2025-11-23' })).content[0].text;
      assert.ok(t.includes('Meal Plan (1 events)'), t);
      assert.ok(t.indexOf('Queue') > t.indexOf('Pot Roast'), 'queue comes after the calendar');
      assert.ok(t.includes('- **Queue** 📖 Mushroom Soup'), t);
      assert.ok(!t.includes('**2025-11-23** 📖 Mushroom Soup'));
    });

    it('json marks queued events with a null date and lists them last', async () => {
      client._events.push(
        { date: null, queued: true, title: 'Grain Bowls', identifier: 'q-2' },
        { date: '2025-11-24', title: 'Tacos', identifier: 'q-3' },
      );
      const rows = JSON.parse((await handlers.meal_plan({ action: 'list_events', format: 'json', start_date: '2025-11-01' })).content[0].text);
      assert.deepEqual(rows.map(r => [r.id, r.date, r.queued]), [['q-3', '2025-11-24', false], ['q-2', null, true]]);
    });

    it('shows the queue when no dated events match', async () => {
      client._events.push({ date: null, queued: true, title: 'Chili', identifier: 'q-4' });
      const t = (await handlers.meal_plan({ action: 'list_events' })).content[0].text;
      assert.ok(t.includes('No meal plan events found.') && t.includes('Chili'), t);
    });
  });

  describe('list_labels', () => {
    it('returns empty message when no labels', async () => {
      const result = await handlers.meal_plan({ action: 'list_labels' });
      assert.ok(result.content[0].text.includes('No meal plan labels'));
    });

    it('lists labels with ids', async () => {
      client._labels.push({ identifier: 'l1', name: 'Dinner', hexColor: '#FF0000' });
      const result = await handlers.meal_plan({ action: 'list_labels' });
      assert.ok(result.content[0].text.includes('Dinner'));
      assert.ok(result.content[0].text.includes('l1'));
    });
  });

  describe('create_event', () => {
    it('creates an event', async () => {
      const result = await handlers.meal_plan({ action: 'create_event', date: '2025-03-01' });
      assert.ok(result.content[0].text.includes('Created meal plan event'));
      assert.equal(client._events.length, 1);
    });
  });

  describe('create_event result ids', () => {
    it('text output names the new event id', async () => {
      const r = await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Tacos' });
      assert.match(r.content[0].text, /Created meal plan event for 2025-03-01 \(id: .+\)/);
    });

    it('json output returns the id, and the existing id on a retry', async () => {
      const a = JSON.parse((await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Tacos', format: 'json' })).content[0].text);
      assert.equal(a.alreadyExists, false);
      assert.ok(a.id);
      assert.deepEqual(client._events.map(e => e.identifier), [a.id]);
      const b = JSON.parse((await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Tacos', format: 'json' })).content[0].text);
      assert.deepEqual(b, { id: a.id, date: '2025-03-01', alreadyExists: true });
    });
  });

  describe('create_event retry safety', () => {
    it('does not create the same title twice on one date', async () => {
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Tacos' });
      const retry = await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'tacos' });
      assert.ok(retry.content[0].text.startsWith('already_exists:'));
      assert.equal(client._events.length, 1);
    });

    it('does not create the same recipe twice on one date', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01', title: null, recipeId: 'r1' });
      const retry = await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', recipe_id: 'r1' });
      assert.ok(retry.content[0].text.startsWith('already_exists:'));
      assert.equal(client._events.length, 1);
    });

    it('allows a different meal, or the same meal on another date', async () => {
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Tacos' });
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-01', title: 'Soup' });
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-02', title: 'Tacos' });
      assert.equal(client._events.length, 3);
    });
  });

  describe('delete_event', () => {
    it('deletes an existing event', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01' });
      const result = await handlers.meal_plan({ action: 'delete_event', event_id: 'e1' });
      assert.ok(result.content[0].text.includes('Deleted meal plan event'));
    });

    it('returns error for non-existent event', async () => {
      const result = await handlers.meal_plan({ action: 'delete_event', event_id: 'bad' });
      assert.equal(result.isError, true);
    });
  });


  describe('json output and leftovers (meal planner v2)', () => {
    it('list_events format=json returns structured events, sorted, with ids the planner can join on', async () => {
      client._events.push(
        { identifier: 'e2', date: '2025-03-02', title: 'Eat out (Declan\u2019s choice)', labelName: 'Dinner', labelId: 'L1' },
        { identifier: 'e1', date: '2025-03-01', recipeId: 'r-1', recipeName: 'Tacos', isLeftover: true },
      );
      const result = await handlers.meal_plan({ action: 'list_events', format: 'json' });
      const events = JSON.parse(result.content[0].text);
      assert.deepEqual(events.map(e => e.id), ['e1', 'e2']);
      assert.deepEqual(events[0], { id: 'e1', date: '2025-03-01', queued: false, title: null, details: null, recipeId: 'r-1', recipeName: 'Tacos', label: null, labelId: null, isLeftover: true });
      assert.equal(events[1].label, 'Dinner');
      assert.equal(events[1].isLeftover, false);
    });

    it('list_events format=json returns an empty array, not a sentence, when there are no events', async () => {
      const result = await handlers.meal_plan({ action: 'list_events', format: 'json' });
      assert.deepEqual(JSON.parse(result.content[0].text), []);
    });

    it('list_events text output is unchanged when format is omitted', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01', title: 'Tacos' });
      const result = await handlers.meal_plan({ action: 'list_events' });
      assert.match(result.content[0].text, /^Meal Plan \(1 events\):/);
    });

    it('create_event passes is_leftover through', async () => {
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-05', recipe_id: 'r-1', is_leftover: true });
      assert.equal(client._events[0].isLeftover, true);
      await handlers.meal_plan({ action: 'create_event', date: '2025-03-06', title: 'Tacos' });
      assert.equal(client._events[1].isLeftover, false);
    });
  });
});
