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

test('removes by sending only the ids to remove, skipping ids not in the collection', async () => {
  const c = client({ collections: [{ identifier: 'c1', name: 'Weeknight', recipeIds: ['r1', 'r2'] }] });
  const out = await c.removeRecipesFromCollections([{ collectionId: 'c1', recipeIds: ['r2', 'r3'] }]);
  assert.equal(out.error, null);
  assert.deepEqual(out.results, [{ id: 'c1', name: 'Weeknight', removed: ['r2'], notIn: ['r3'] }]);
  assert.deepEqual(c.client.writes, [{ op: 'remove-recipes-from-collection', id: 'c1', name: 'Weeknight', recipeIds: ['r2'] }]);
  const cached = (await c.client._getUserData()).recipeDataResponse.recipeCollections[0].recipeIds;
  assert.deepEqual(cached, ['r1', 'r2']);
});

test('a remove with nothing in the collection writes nothing; an unknown or repeated collection refuses the batch', async () => {
  const c = client();
  await c.removeRecipesFromCollections([{ collectionId: 'c1', recipeIds: ['r3'] }]);
  assert.equal(c.client.writes.length, 0);
  for (const changes of [[{ collectionId: 'c9', recipeIds: ['r1'] }], [{ collectionId: 'c1', recipeIds: ['r1'] }, { collectionId: 'c1', recipeIds: ['r1'] }], [{ collectionId: 'c1', recipeIds: [] }]]) {
    const d = client();
    await assert.rejects(d.removeRecipesFromCollections(changes));
    assert.equal(d.client.writes.length, 0, JSON.stringify(changes));
  }
});

test('a failed remove stops the batch and reports what was already written', async () => {
  const c = client({ failOn: 'Weeknight', collections: [{ identifier: 'c0', name: 'Soups', recipeIds: ['r3'] }, { identifier: 'c1', name: 'Weeknight', recipeIds: ['r1'] }] });
  const out = await c.removeRecipesFromCollections([{ collectionId: 'c0', recipeIds: ['r3'] }, { collectionId: 'c1', recipeIds: ['r1'] }]);
  assert.deepEqual(out.results.map(r => r.name), ['Soups']);
  assert.match(out.error, /Weeknight.*500/);
});

test('deletes several collections from one account read, stopping at the first failure', async () => {
  const deletes = [];
  const c = client({ collections: [{ identifier: 'c1', name: 'A', recipeIds: [] }, { identifier: 'c2', name: 'B', recipeIds: [] }, { identifier: 'c3', name: 'C', recipeIds: [] }] });
  const make = c.client.createRecipeCollection.bind(c.client);
  c.client.createRecipeCollection = (raw) => ({ ...make(raw), async delete() { if (raw.name === 'B') throw new Error('Response code 429'); deletes.push(raw.identifier); } });
  const out = await c.deleteRecipeCollections(['c1', 'c2', 'c3']);
  assert.deepEqual(out.deleted, [{ id: 'c1', name: 'A' }]);
  assert.match(out.error, /"B".*429/);
  assert.deepEqual(deletes, ['c1']);
  assert.equal(c.client.reads, 1);
  await assert.rejects(c.deleteRecipeCollections(['c1', 'nope']), /Unknown collection/);
});
