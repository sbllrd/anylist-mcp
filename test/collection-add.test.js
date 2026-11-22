import { test } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';

// A stand-in for anylist-js's account data and RecipeCollection writes.
function fakeAnyList({ recipes, collections, failOn = null }) {
  const writes = [];
  const userData = { recipeDataResponse: { recipes, recipeCollections: collections, recipeDataId: 'rd1' } };
  let reads = 0;
  return {
    writes,
    get reads() { return reads; },
    async _getUserData() { reads++; return userData; },
    async getRecipes() { this.recipeDataId = 'rd1'; return recipes; },
    createRecipeCollection(opts) {
      return {
        identifier: opts.identifier || `new-${opts.name}`,
        name: opts.name,
        recipeIds: opts.recipeIds,
        async save() { writes.push({ op: 'new-recipe-collection', name: opts.name, recipeIds: [...opts.recipeIds] }); },
        async performOperation(handlerId) {
          if (failOn === opts.name) throw new Error('Response code 500');
          writes.push({ op: handlerId, id: opts.identifier, name: opts.name, recipeIds: [...opts.recipeIds] });
        },
      };
    },
  };
}

const RECIPES = [{ identifier: 'r1', name: 'Tacos' }, { identifier: 'r2', name: 'Chili' }, { identifier: 'r3', name: 'Soup' }];

function client(opts) {
  const c = new AnyListClient({ defaultListName: 'x' });
  c.client = fakeAnyList({ recipes: RECIPES, collections: [{ identifier: 'c1', name: 'Weeknight', recipeIds: ['r1'] }], ...opts });
  return c;
}

test('adds only new ids, sending the whole list like upstream addRecipe, and leaves the cached data alone', async () => {
  const c = client();
  const out = await c.addRecipesToCollections([{ collectionId: 'c1', recipeIds: ['r1', 'r2'] }]);
  assert.equal(out.error, null);
  assert.deepEqual(out.results, [{ id: 'c1', name: 'Weeknight', created: false, added: ['r2'], alreadyIn: ['r1'] }]);
  assert.deepEqual(c.client.writes, [{ op: 'add-recipes-to-collection', id: 'c1', name: 'Weeknight', recipeIds: ['r1', 'r2'] }]);
  const cached = (await c.client._getUserData()).recipeDataResponse.recipeCollections[0].recipeIds;
  assert.deepEqual(cached, ['r1']);
});

test('nothing new to add writes nothing', async () => {
  const c = client();
  const out = await c.addRecipesToCollections([{ collectionId: 'c1', recipeIds: ['r1'] }]);
  assert.deepEqual(out.results[0].added, []);
  assert.equal(c.client.writes.length, 0);
});

test('creates a named collection with its recipes', async () => {
  const c = client();
  const out = await c.addRecipesToCollections([{ createName: 'Soups', recipeIds: ['r3'] }]);
  assert.deepEqual(c.client.writes, [{ op: 'new-recipe-collection', name: 'Soups', recipeIds: ['r3'] }]);
  assert.equal(out.results[0].created, true);
});

test('a bad id, an unknown collection, a duplicate name or a repeated collection refuses the whole batch before any write', async () => {
  for (const changes of [
    [{ collectionId: 'c1', recipeIds: ['r2'] }, { collectionId: 'c1', recipeIds: ['nope'] }],
    [{ collectionId: 'c1', recipeIds: ['r2'] }, { collectionId: 'c9', recipeIds: ['r2'] }],
    [{ collectionId: 'c1', recipeIds: ['r2'] }, { createName: ' weeknight ', recipeIds: ['r2'] }],
    [{ collectionId: 'c1', recipeIds: ['r2'] }, { collectionId: 'c1', recipeIds: ['r3'] }],
    [{ collectionId: 'c1', recipeIds: [] }],
  ]) {
    const c = client();
    await assert.rejects(c.addRecipesToCollections(changes));
    assert.equal(c.client.writes.length, 0, JSON.stringify(changes));
  }
});

test('a failed write stops the batch and reports what was already written', async () => {
  const c = client({ failOn: 'Weeknight' });
  const out = await c.addRecipesToCollections([{ createName: 'Soups', recipeIds: ['r3'] }, { collectionId: 'c1', recipeIds: ['r2'] }]);
  assert.deepEqual(out.results.map(r => r.name), ['Soups']);
  assert.match(out.error, /Weeknight.*500/);
});

test('one account read for the whole batch', async () => {
  const c = client();
  await c.addRecipesToCollections([{ createName: 'Soups', recipeIds: ['r3'] }, { collectionId: 'c1', recipeIds: ['r2'] }]);
  assert.equal(c.client.reads, 1);
});

test('the catalog carries ingredients, steps and times from the same read', async () => {
  const c = new AnyListClient({ defaultListName: 'x' });
  c.client = {
    async getRecipes() {
      return [{ identifier: 'r1', name: 'Tacos', prepTime: 10, cookTime: 20, rating: 5, creationTimestamp: 1700000000,
        ingredients: [{ rawIngredient: 'Sauce', isHeading: true }, { rawIngredient: '1 lb beef' }, { name: 'salt' }],
        preparationSteps: ['Brown the beef.'], photoIds: ['p'] }];
    },
  };
  const [r] = await c.getRecipeCatalog();
  assert.deepEqual(r.ingredients, ['## Sauce', '1 lb beef', 'salt']);
  assert.deepEqual(r.steps, ['Brown the beef.']);
  assert.equal(r.prepTime, 10);
  assert.equal(r.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(r.photoCount, 1);
});
