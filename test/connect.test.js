import { test } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';

// A stand-in for anylist-js: getLists() rebuilds `lists` each call, like the real one.
function fakeAnyList(snapshots) {
  let calls = 0;
  return {
    lists: [],
    async getLists() {
      const next = snapshots[Math.min(calls++, snapshots.length - 1)];
      if (next instanceof Error) throw next;
      this.lists = next.map(l => ({ ...l }));
      return this.lists;
    },
    getListById(id) { return this.lists.find(l => l.identifier === id); },
    getListByName(name) { return this.lists.find(l => l.name === name); },
    get calls() { return calls; },
  };
}

test('connect reloads the lists every call, so changes made in the apps show up', async () => {
  const c = new AnyListClient({ defaultListName: 'Shopping List' });
  c.client = fakeAnyList([
    [{ identifier: 'L1', name: 'Shopping List', items: [{ name: 'eggs' }] }],
    [{ identifier: 'L1', name: 'Shopping List', items: [{ name: 'eggs' }, { name: 'milk' }] }],
  ]);
  await c.connect();
  assert.deepEqual(c.targetList.items.map(i => i.name), ['eggs']);
  await c.connect();
  assert.deepEqual(c.targetList.items.map(i => i.name), ['eggs', 'milk']);
});

test('a failed list read is retried on the next call instead of sticking', async () => {
  const c = new AnyListClient({ defaultListName: 'Shopping List' });
  c.client = fakeAnyList([new Error('Response code 429 (Too Many Requests)'), [{ identifier: 'L1', name: 'Shopping List', items: [] }]]);
  await assert.rejects(c.connect(), /429/);
  await c.connect();
  assert.equal(c.targetList.identifier, 'L1');
});
