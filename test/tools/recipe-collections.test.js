import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/recipe-collections.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('recipe_collections tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list', () => {
    it('returns empty message when no collections', async () => {
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('No recipe collections'));
    });

    it('lists collections with recipe names', async () => {
      client._collections.push({ name: 'Weeknight', recipeCount: 2, recipeNames: ['Pasta', 'Salad'] });
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('Weeknight'));
      assert.ok(result.content[0].text.includes('Pasta'));
    });
  });

  describe('create', () => {
    it('creates a collection', async () => {
      const result = await handlers.recipe_collections({ action: 'create', name: 'Quick Meals' });
      assert.ok(result.content[0].text.includes('Created recipe collection "Quick Meals"'));
    });

    it('creates collection with recipes', async () => {
      await handlers.recipe_collections({ action: 'create', name: 'Favs', recipe_names: ['Pasta'] });
      assert.equal(client._collections[client._collections.length - 1].recipeNames[0], 'Pasta');
    });
  });

  describe('delete', () => {
    it('deletes an existing collection', async () => {
      client._collections.push({ name: 'Old Collection', recipeCount: 0, recipeNames: [] });
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Old Collection' });
      assert.ok(result.content[0].text.includes('Deleted recipe collection'));
      assert.equal(client._collections.length, 0);
    });

    it('deletes by id, naming the collection it deleted', async () => {
      client._collections.push({ identifier: 'c-9', name: 'Old Collection', recipeCount: 0, recipeNames: [] });
      const result = await handlers.recipe_collections({ action: 'delete', collection_id: 'c-9' });
      assert.equal(result.content[0].text, 'Deleted recipe collection "Old Collection"');
      assert.equal(client._collections.length, 0);
    });

    it('deletes several by id in one call and returns JSON', async () => {
      const result = await handlers.recipe_collections({ action: 'delete', collection_ids: ['c-1', 'c-2'] });
      assert.deepEqual(client.lastDeleteIds, ['c-1', 'c-2']);
      assert.equal(JSON.parse(result.content[0].text).deleted.length, 2);
    });

    it('returns error for non-existent collection', async () => {
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Nope' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });


  describe('list format=json (meal planner v2)', () => {
    it('returns collection ids and recipe ids, so names with commas or duplicates stay unambiguous', async () => {
      client._collections.push({ identifier: 'c-1', name: 'Boys', recipeCount: 2, recipeNames: ['Hamburgers, French Fries', 'Meatloaf'], recipeIds: ['r-1', 'r-9'] });
      const result = await handlers.recipe_collections({ action: 'list', format: 'json' });
      assert.deepEqual(JSON.parse(result.content[0].text), [{ id: 'c-1', name: 'Boys', recipeIds: ['r-1', 'r-9'] }]);
    });

    it('returns an empty array when there are none', async () => {
      const result = await handlers.recipe_collections({ action: 'list', format: 'json' });
      assert.deepEqual(JSON.parse(result.content[0].text), []);
    });
  });

  describe('add_recipes (recipe index)', () => {
    it('passes the batch through and returns JSON', async () => {
      const result = await handlers.recipe_collections({ action: 'add_recipes', changes: [{ collection_id: 'c1', recipe_ids: ['r1'] }, { create_name: 'Soups', recipe_ids: ['r2'] }] });
      assert.ok(!result.isError);
      assert.deepEqual(client.lastCollectionChanges, [{ collectionId: 'c1', createName: null, recipeIds: ['r1'] }, { collectionId: null, createName: 'Soups', recipeIds: ['r2'] }]);
      assert.equal(JSON.parse(result.content[0].text).results.length, 2);
    });

    it('needs changes, each with exactly one of collection_id or create_name', async () => {
      for (const changes of [undefined, [], [{ recipe_ids: ['r1'] }], [{ collection_id: 'c1', create_name: 'X', recipe_ids: ['r1'] }]]) {
        const result = await handlers.recipe_collections({ action: 'add_recipes', changes });
        assert.equal(result.isError, true, JSON.stringify(changes));
      }
      assert.equal(client.lastCollectionChanges, undefined);
    });
  });

  describe('remove_recipes (recipe index sync)', () => {
    it('passes the batch through and returns JSON', async () => {
      const result = await handlers.recipe_collections({ action: 'remove_recipes', changes: [{ collection_id: 'c1', recipe_ids: ['r1'] }] });
      assert.ok(!result.isError);
      assert.deepEqual(client.lastRemoveChanges, [{ collectionId: 'c1', recipeIds: ['r1'] }]);
      assert.deepEqual(JSON.parse(result.content[0].text).results[0].removed, ['r1']);
    });

    it('needs changes, each with a collection_id and no create_name', async () => {
      for (const changes of [undefined, [], [{ recipe_ids: ['r1'] }], [{ create_name: 'X', recipe_ids: ['r1'] }]]) {
        const result = await handlers.recipe_collections({ action: 'remove_recipes', changes });
        assert.equal(result.isError, true, JSON.stringify(changes));
      }
      assert.equal(client.lastRemoveChanges, undefined);
    });
  });
});
