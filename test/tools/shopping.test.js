import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('shopping tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('add_item', () => {
    it('adds an item', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully added "Milk"'));
      assert.equal(client._items.length, 1);
      assert.equal(client._items[0].name, 'Milk');
    });

    it('adds item with quantity and notes', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Eggs', quantity: 2, notes: 'organic' });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
    });

    it('accepts a string quantity with a unit', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Flour', quantity: '500 g' });
      assert.equal(client._items[0].quantity, '500 g');
    });


    it ('should default to "other" category if not provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bread' });
      assert.equal(client._items[0].category, 'other');
    });

    it('should set category when provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bananas', category: 'produce' });
      assert.equal(client._items[0].category, 'produce');
    });

    it('should return error for an unresolvable category', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Soda', category: 'invalid-category' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Category "invalid-category" not found'));
      assert.equal(client._items.length, 0);
    });

    it('should assign an item to an existing custom category by name', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Farmers Market', systemCategory: null });
      await handlers.shopping({ action: 'add_item', name: 'Corn', category: 'Farmers Market' });
      assert.equal(client._items[0].category, 'cat-1');
    });
  });

  describe('add_items', () => {
    it('adds multiple items from plain names', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.ok(result.content[0].text.includes('Added 3 of 3 items'));
      assert.equal(client._items.length, 3);
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Eggs', 'Bread']);
    });

    it('adds items with quantity, notes and category', async () => {
      await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Eggs', quantity: 2, notes: 'organic', category: 'dairy' }],
      });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
      assert.equal(client._items[0].category, 'dairy');
    });

    it('defaults quantity to 1 and category to other', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk'] });
      assert.equal(client._items[0].quantity, 1);
      assert.equal(client._items[0].category, 'other');
    });

    it('mixes plain names and objects', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk', { name: 'Eggs', quantity: 12 }] });
      assert.equal(client._items.length, 2);
      assert.equal(client._items[1].quantity, 12);
    });

    it('continues past a failing item and reports it', async () => {
      client.addItem = async (name) => {
        if (name === 'Eggs') throw new Error('boom');
        client._items.push({ name });
      };
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      const text = result.content[0].text;
      assert.equal(result.isError, true);
      assert.ok(text.includes('Added 2 of 3 items'));
      assert.ok(text.includes('✓ Milk'));
      assert.ok(text.includes('✗ Eggs: boom'));
      assert.ok(text.includes('✓ Bread'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Bread']);
    });

    it('rejects an unresolvable category without aborting the batch', async () => {
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Soda', category: 'invalid-category' }, 'Milk'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Category "invalid-category" not found'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk']);
    });

    it('assigns items to an existing custom category by name', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Farmers Market', systemCategory: null });
      await handlers.shopping({ action: 'add_items', items: [{ name: 'Corn', category: 'Farmers Market' }] });
      assert.equal(client._items[0].category, 'cat-1');
    });

    it('assigns a store to an item', async () => {
      client._stores = [{ name: 'Costco' }];
      await handlers.shopping({ action: 'add_items', items: [{ name: 'Milk', store_name: 'Costco' }] });
      assert.equal(client._items[0].store, 'Costco');
    });

    it('rejects an unknown store without aborting the batch', async () => {
      client._stores = [{ name: 'Costco' }];
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Milk', store_name: 'Nowhere' }, 'Eggs'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Store "Nowhere" not found'));
      assert.deepEqual(client._items.map(i => i.name), ['Eggs']);
    });

    it('errors on a missing or empty items array', async () => {
      const missing = await handlers.shopping({ action: 'add_items' });
      assert.equal(missing.isError, true);
      assert.ok(missing.content[0].text.includes('non-empty "items" array'));

      const empty = await handlers.shopping({ action: 'add_items', items: [] });
      assert.equal(empty.isError, true);
    });

    it('connects to the list only once for the whole batch', async () => {
      let connects = 0;
      const realConnect = client.connect.bind(client);
      client.connect = async (n) => { connects++; return realConnect(n); };
      await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.equal(connects, 1);
    });
  });

  describe('check_item', () => {
    it('checks off an existing item', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'check_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully checked off'));
      assert.equal(client._items[0].checked, true);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'check_item', name: 'Nonexistent' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('uncheck_item', () => {
    it('unchecks a checked-off item', async () => {
      client._items.push({ name: 'Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('resolves a checked item by partial name', async () => {
      client._items.push({ name: 'Whole Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('returns error when no checked item matches', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('No checked-off item'));
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('delete_item', () => {
    it('deletes an existing item', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'delete_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully deleted'));
      assert.equal(client._items.length, 0);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'delete_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('list_items', () => {
    it('returns empty message when no items', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('No unchecked items'));
    });

    it('lists items grouped by category', async () => {
      client._items.push({ name: 'Milk', category: 'Dairy' }, { name: 'Bread', category: 'Bakery' });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(result.content[0].text.includes('Bread'));
      assert.ok(result.content[0].text.includes('Dairy'));
      assert.ok(result.content[0].text.includes('Bakery'));
    });

    it('renders quantities (including units) next to the item', async () => {
      client._items.push({ name: 'Flour', quantity: '500 g' }, { name: 'Eggs', quantity: 12 });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Flour (500 g)'));
      assert.ok(result.content[0].text.includes('Eggs (12)'));
    });

    it('excludes checked items by default', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(!result.content[0].text.includes('Done'));
    });

    it('includes checked items when requested', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items', include_checked: true });
      assert.ok(result.content[0].text.includes('Done'));
    });

    it('includes notes when requested', async () => {
      client._items.push({ name: 'Milk', notes: 'whole milk' });
      const result = await handlers.shopping({ action: 'list_items', include_notes: true });
      assert.ok(result.content[0].text.includes('whole milk'));
    });
  });

  describe('list_lists', () => {
    it('returns empty message when no lists', async () => {
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('No lists found'));
    });

    it('returns list names with counts', async () => {
      client._lists = [
        { name: 'Groceries', uncheckedCount: 5 },
        { name: 'Costco', uncheckedCount: 2 },
      ];
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('Groceries'));
      assert.ok(result.content[0].text.includes('5 unchecked'));
    });
  });

  describe('create_list', () => {
    it('creates a new list', async () => {
      const result = await handlers.shopping({ action: 'create_list', list_name: 'Camping Trip' });
      assert.ok(result.content[0].text.includes('Successfully created list "Camping Trip"'));
      assert.equal(client._lists.length, 1);
      assert.equal(client._lists[0].name, 'Camping Trip');
    });
  });

  describe('rename_list', () => {
    it('renames an existing list', async () => {
      const result = await handlers.shopping({
        action: 'rename_list', list_name: 'Groceries', new_list_name: 'Weekly Groceries',
      });
      assert.ok(result.content[0].text.includes('Successfully renamed list "Groceries" to "Weekly Groceries"'));
      assert.equal(client.targetList.name, 'Weekly Groceries');
    });
  });

  describe('get_favorites', () => {
    it('returns empty message when no favorites', async () => {
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('No favorite items'));
    });

    it('returns favorite items', async () => {
      client._favorites = [{ name: 'Bananas', details: 'organic' }];
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('Bananas'));
      assert.ok(result.content[0].text.includes('organic'));
    });
  });

  describe('get_recents', () => {
    it('returns empty message when no recents', async () => {
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('No recent items'));
    });

    it('returns recent items', async () => {
      client._recents = [{ name: 'Avocado' }];
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('Avocado'));
    });
  });

  describe('list_categories', () => {
    it('returns empty message when no categories', async () => {
      const result = await handlers.shopping({ action: 'list_categories' });
      assert.ok(result.content[0].text.includes('No categories found'));
    });

    it('lists categories, flagging custom ones', async () => {
      client._categories = [
        { name: 'Produce', systemCategory: 'produce' },
        { name: 'Farmers Market', systemCategory: null },
      ];
      const result = await handlers.shopping({ action: 'list_categories' });
      assert.ok(result.content[0].text.includes('Produce'));
      assert.ok(!result.content[0].text.includes('Produce (custom)'));
      assert.ok(result.content[0].text.includes('Farmers Market (custom)'));
    });
  });

  describe('create_category', () => {
    it('creates a custom category', async () => {
      const result = await handlers.shopping({ action: 'create_category', category_name: 'Farmers Market' });
      assert.ok(result.content[0].text.includes('Successfully created category "Farmers Market"'));
      assert.equal(client._categories.length, 1);
      assert.equal(client._categories[0].name, 'Farmers Market');
    });
  });

  describe('rename_category', () => {
    it('renames a custom category', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Farmers Market', systemCategory: null });
      const result = await handlers.shopping({
        action: 'rename_category', category_name: 'Farmers Market', new_category_name: 'Local Produce',
      });
      assert.ok(result.content[0].text.includes('Successfully renamed category "Farmers Market" to "Local Produce"'));
      assert.equal(client._categories[0].name, 'Local Produce');
    });

    it('refuses to rename a built-in category', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Produce', systemCategory: 'produce' });
      const result = await handlers.shopping({
        action: 'rename_category', category_name: 'Produce', new_category_name: 'Fresh Produce',
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("can't be renamed"));
    });

    it('returns error for non-existent category', async () => {
      const result = await handlers.shopping({
        action: 'rename_category', category_name: 'Ghost', new_category_name: 'Nope',
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('delete_category', () => {
    it('deletes a custom category', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Farmers Market', systemCategory: null });
      const result = await handlers.shopping({ action: 'delete_category', category_name: 'Farmers Market' });
      assert.ok(result.content[0].text.includes('Successfully deleted category "Farmers Market"'));
      assert.equal(client._categories.length, 0);
    });

    it('refuses to delete a built-in category', async () => {
      client._categories.push({ identifier: 'cat-1', name: 'Produce', systemCategory: 'produce' });
      const result = await handlers.shopping({ action: 'delete_category', category_name: 'Produce' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("can't be deleted"));
      assert.equal(client._categories.length, 1);
    });

    it('returns error for non-existent category', async () => {
      const result = await handlers.shopping({ action: 'delete_category', category_name: 'Ghost' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });
});
