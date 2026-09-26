import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerAllTools } from '../../src/tools/index.js';
import { parseClientScopes, profileForClient, scopeServer } from '../../src/tools/scopes.js';
import { MockAnyListClient } from './helpers.js';

// Like helpers.js's createMockServer, but it also keeps each tool's config
// and records description updates, so schema narrowing can be checked.
function createCapturingServer() {
  const tools = {};
  const server = {
    registerTool: (name, config, handler) => {
      tools[name] = { config, handler, updates: [] };
      return { update: (u) => tools[name].updates.push(u) };
    },
    server: { getClientCapabilities: () => null },
  };
  return { server, tools };
}

function register(profile, client) {
  const { server, tools } = createCapturingServer();
  const getClient = () => Promise.resolve(client);
  registerAllTools(scopeServer(server, profile, getClient), getClient);
  return tools;
}

describe('parseClientScopes', () => {
  it('treats unset as no mappings', () => {
    assert.deepEqual(parseClientScopes(undefined), {});
    assert.deepEqual(parseClientScopes('  '), {});
  });

  it('rejects an unknown profile name', () => {
    assert.throws(() => parseClientScopes('{"abc": "shared_housheold"}'), /unknown profile/);
  });

  it('rejects non-object JSON', () => {
    assert.throws(() => parseClientScopes('["abc"]'), /JSON object/);
    assert.throws(() => parseClientScopes('{nope'), /not valid JSON/);
  });

  it('maps unmapped and missing clients to full', () => {
    const scopes = parseClientScopes('{"abc": "shared_household"}');
    assert.equal(profileForClient(scopes, 'abc'), 'shared_household');
    assert.equal(profileForClient(scopes, 'other'), 'full');
    assert.equal(profileForClient(scopes, undefined), 'full');
  });
});

describe('full profile', () => {
  it('registers every tool with every action', () => {
    const tools = register('full', new MockAnyListClient());
    assert.deepEqual(Object.keys(tools).sort(), ['health_check', 'meal_plan', 'recipe_collections', 'recipes', 'shopping']);
    assert.ok(tools.recipes.config.inputSchema.action.options.includes('delete'));
  });
});

describe('shared_household_read profile', () => {
  let client;
  let tools;

  beforeEach(() => {
    client = new MockAnyListClient();
    tools = register('shared_household_read', client);
  });

  it('narrows every action enum to reads', () => {
    assert.deepEqual(tools.recipes.config.inputSchema.action.options, ['list', 'get']);
    assert.deepEqual(tools.recipe_collections.config.inputSchema.action.options, ['list']);
    assert.deepEqual(tools.meal_plan.config.inputSchema.action.options, ['list_events', 'list_labels']);
    assert.ok(!tools.shopping.config.inputSchema.action.options.includes('add_item'));
    assert.ok(tools.health_check);
  });

  it('refuses a write action even if the schema is bypassed', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Pasta' });
    const result = await tools.recipes.handler({ action: 'delete', name: 'Pasta' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not permitted/);
    assert.equal(client._recipes.length, 1);
  });

  it('refuses create in the read profile', async () => {
    const result = await tools.recipes.handler({ action: 'create', name: 'New' });
    assert.equal(result.isError, true);
    assert.equal(client._recipes.length, 0);
  });

  it('still serves reads', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Pasta' });
    const result = await tools.recipes.handler({ action: 'list' });
    assert.match(result.content[0].text, /Pasta/);
  });

  it('keeps the scope note on dynamic description updates', async () => {
    await tools.shopping.handler({ action: 'list_lists' });
    for (const u of tools.shopping.updates) assert.match(u.description, /may only use these actions/);
  });
});

describe('shared_household profile (create-only recipes)', () => {
  let client;
  let tools;

  beforeEach(() => {
    client = new MockAnyListClient();
    tools = register('shared_household', client);
  });

  it('allows create, import_url, list, get and nothing else on recipes', () => {
    assert.deepEqual(tools.recipes.config.inputSchema.action.options, ['list', 'get', 'create', 'import_url']);
  });

  it('creates a new recipe', async () => {
    const result = await tools.recipes.handler({ action: 'create', name: 'Chili' });
    assert.equal(result.isError, undefined);
    assert.equal(client._recipes.length, 1);
  });

  it('refuses to overwrite an existing recipe (case-insensitive)', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Chili' });
    const result = await tools.recipes.handler({ action: 'create', name: 'chili' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already exists/);
    assert.equal(client._recipes.length, 1);
  });

  it('refuses update and delete', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Chili' });
    for (const action of ['update', 'delete']) {
      const result = await tools.recipes.handler({ action, name: 'Chili', note: 'x' });
      assert.equal(result.isError, true);
    }
    assert.equal(client._recipes.length, 1);
    assert.equal(client._recipes[0].note, undefined);
  });

  it('refuses normalize (which can save)', async () => {
    const result = await tools.recipes.handler({ action: 'normalize', text: 'x', save: true });
    assert.equal(result.isError, true);
  });

  it('imports in strict mode', async () => {
    let opts;
    client.importRecipeFromUrl = async (url, o) => { opts = o; return { name: 'Soup', ingredientCount: 3, stepCount: 2 }; };
    const result = await tools.recipes.handler({ action: 'import_url', url: 'https://example.com/soup' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Imported recipe "Soup"/);
    assert.deepEqual(opts, { strict: true });
  });

  it('refuses a URL already saved, ignoring utm params, www and trailing slash', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Soup', sourceUrl: 'https://www.example.com/soup/' });
    let called = false;
    client.importRecipeFromUrl = async () => { called = true; };
    const result = await tools.recipes.handler({ action: 'import_url', url: 'https://example.com/soup?utm_source=ig#x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Already saved/);
    assert.equal(called, false);
  });

  it('refuses private, loopback and non-http URLs', async () => {
    let called = false;
    client.importRecipeFromUrl = async () => { called = true; };
    for (const url of ['http://127.0.0.1/x', 'http://localhost:3000/', 'http://192.168.1.5/r', 'http://10.0.0.1/',
      'http://[::1]/', 'http://printer.local/', 'file:///etc/passwd', 'ftp://example.com/r', 'not a url']) {
      const result = await tools.recipes.handler({ action: 'import_url', url });
      assert.equal(result.isError, true, url);
    }
    assert.equal(called, false);
  });

  it('reports a failed strict import as an error', async () => {
    client.importRecipeFromUrl = async () => { throw new Error('Not imported: no recipe'); };
    const result = await tools.recipes.handler({ action: 'import_url', url: 'https://news.example.com/story' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Not imported/);
  });

  it('does not expose meal plan or collection writes, or list/category management', async () => {
    for (const [tool, action] of [['meal_plan', 'create_event'], ['recipe_collections', 'create'],
      ['shopping', 'delete_item'], ['shopping', 'create_list'], ['shopping', 'rename_list'], ['shopping', 'delete_category']]) {
      const result = await tools[tool].handler({ action, name: 'x' });
      assert.equal(result.isError, true, `${tool}.${action}`);
    }
  });
});

// A client whose anylist library view has lists with sharedUsers, like the
// raw decoded user data the guard reads.
function withSharing(client, lists) {
  const origConnect = client.connect.bind(client);
  client.connect = async (name) => {
    await origConnect(name);
    client.client = {
      getListByName: (n) => lists.find(l => l.name === n),
      _getUserData: async () => ({ shoppingListsResponse: { newLists: lists } }),
    };
    return true;
  };
  return client;
}

describe('shared_household profile (writes on shared lists only)', () => {
  const LISTS = [
    { identifier: 'l1', name: 'SamaBamaLisa', sharedUsers: [{ email: 'sam@x.test' }, { email: 'Lisa@X.test' }] },
    { identifier: 'l2', name: 'Medicines List', sharedUsers: [{ email: 'sam@x.test' }] },
  ];
  let client;
  let tools;
  let saved;

  beforeEach(() => {
    saved = process.env.ANYLIST_HOUSEHOLD_SHARE_EMAIL;
    process.env.ANYLIST_HOUSEHOLD_SHARE_EMAIL = 'lisa@x.test';
    client = withSharing(new MockAnyListClient(), LISTS);
    tools = register('shared_household', client);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ANYLIST_HOUSEHOLD_SHARE_EMAIL;
    else process.env.ANYLIST_HOUSEHOLD_SHARE_EMAIL = saved;
  });

  it('adds to a list shared with the household (email case-insensitive)', async () => {
    const result = await tools.shopping.handler({ action: 'add_item', list_name: 'SamaBamaLisa', name: 'Milk' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(client._items.length, 1);
  });

  it('refuses writes to a list not shared with the household, naming the ones it can change', async () => {
    for (const action of ['add_item', 'add_items', 'check_item', 'uncheck_item', 'set_item_store']) {
      const result = await tools.shopping.handler({ action, list_name: 'Medicines List', name: 'x', items: ['x'] });
      assert.equal(result.isError, true, action);
      assert.match(result.content[0].text, /isn't shared with the household.*SamaBamaLisa/);
    }
    assert.equal(client._items.length, 0);
  });

  it('checks the default list when no list is named', async () => {
    client.defaultListName = 'Medicines List';
    const result = await tools.shopping.handler({ action: 'add_item', name: 'Milk' });
    assert.equal(result.isError, true);
  });

  it('refuses every write when no household email is configured', async () => {
    delete process.env.ANYLIST_HOUSEHOLD_SHARE_EMAIL;
    const result = await tools.shopping.handler({ action: 'add_item', list_name: 'SamaBamaLisa', name: 'Milk' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /turned off/);
  });

  it('still reads any list', async () => {
    const result = await tools.shopping.handler({ action: 'list_items', list_name: 'Medicines List' });
    assert.equal(result.isError, undefined);
  });

  it('notes which lists it can change on list_lists', async () => {
    const result = await tools.shopping.handler({ action: 'list_lists' });
    assert.match(result.content.at(-1).text, /can change \(shared with the household\): SamaBamaLisa\./);
  });

  it('exposes item deletion as its own tool, on shared lists only', async () => {
    assert.ok(tools.shopping_delete_item);
    client._items.push({ name: 'Milk', checked: false });
    const refused = await tools.shopping_delete_item.handler({ list_name: 'Medicines List', name: 'Milk' });
    assert.equal(refused.isError, true);
    assert.equal(client._items.length, 1);
    const ok = await tools.shopping_delete_item.handler({ list_name: 'SamaBamaLisa', name: 'Milk' });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.equal(client._items.length, 0);
  });

  it('gives the read-only profile no delete tool and no shopping writes', () => {
    const readTools = register('shared_household_read', withSharing(new MockAnyListClient(), LISTS));
    assert.equal(readTools.shopping_delete_item, undefined);
    assert.ok(!readTools.shopping.config.inputSchema.action.options.includes('add_item'));
  });
});
