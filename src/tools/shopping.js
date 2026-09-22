import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

// Default categories recognized by anylist.
const valid_categories = ["baby","bakery","beverages","breakfast-and-cereal","condiments-oils-and-salad-dressings",
  "cooking-and-baking","dairy","frozen-foods","grains-pasta-and-side-dishes",
  "health-and-personal-care","household-and-cleaning","meat","pet-supplies",
  "produce","seafood","snacks-cookies-and-candy","soups-and-canned-goods",
  "wine-beer-spirits","other"];

  // TODO: What does this do?
function buildDescription(stores) {
  const base = `Manage AnyList shopping lists and items. Actions:
- list_lists: Show all lists with item counts
- create_list: Create a new shopping list
- rename_list: Rename an existing shopping list
- list_items: Show items on a list (grouped by category)
- add_item: Add an item to a list
- add_items: Add several items to a list in one call (use this instead of repeating add_item)
- check_item: Check off (complete) an item
- uncheck_item: Uncheck a previously checked-off item (make it active again)
- delete_item: Permanently remove an item from a list
- get_favorites: Get favorite items for a list
- get_recents: Get recently added items for a list
- list_stores: list stores available for the list (if any)
- list_categories: list categories (built-in and custom) available for the list
- create_category: create a new custom category on a list
- rename_category: rename an existing custom category
- delete_category: delete a custom category (built-in categories can't be deleted)`;
  if (!stores || stores.length === 0) return base;
  const storeList = stores.map(s => s.name).join(', ');
  return `${base}\n\nAvailable stores: ${storeList}`;
}

async function validateStoreName(client, storeName) {
  if (!storeName) return { valid: true, message: null };
  const stores = client.getStores();
  const storeNames = stores.map(s => s.name.toLowerCase());
  if (!storeNames.includes(storeName.toLowerCase())) {
    return { valid: false, message: `Store "${storeName}" not found in list "${client.targetList.name}". Available stores: ${storeNames.join(", ")}.
    Create a new store from the web application or mobile app, then try again.` };
  }
  return { valid: true, message: null };
}

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Resolves a category name for addItem: a built-in slug is used as-is (via
// categoryMatchId alone, unchanged). A custom category additionally needs a
// categoryAssignment (categoryGroupId + categoryId) — categoryMatchId alone
// only creates a "shadow" entry AnyList doesn't recognize as real
// category-group membership (see Item.assignToCustomCategory's docblock).
async function resolveCategoryMatchId(client, categoryName) {
  if (!categoryName || categoryName === "other") return { matchId: "other", message: null };
  if (valid_categories.includes(categoryName)) return { matchId: categoryName, message: null };

  const categories = client.getCategories();
  const match = categories.find(c => (c.name || '').trim().toLowerCase() === categoryName.trim().toLowerCase());
  if (!match) {
    const customNames = categories.filter(c => !c.systemCategory).map(c => c.name);
    const customList = customNames.length > 0 ? ` Custom categories on this list: ${customNames.join(", ")}.` : '';
    return { matchId: null, message: `Category "${categoryName}" not found. Built-in categories: ${valid_categories.join(", ")}.${customList}` };
  }
  return {
    matchId: match.systemCategory || slugify(match.name),
    categoryAssignment: { categoryGroupId: match.categoryGroupId, categoryId: match.identifier },
    message: null,
  };
}

export function register(server, getClient) {
  const { elicitListName, elicitItemChoice, elicitRequiredField } = createElicitationHelpers(server);

  function findPartialMatches(client, itemName, wantChecked = false) {
    const items = client.targetList.items || [];
    const lower = itemName.toLowerCase();
    return items
      .filter(i => Boolean(i.checked) === wantChecked && i.name.toLowerCase().includes(lower))
      .map(i => i.name);
  }

  async function resolveItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact) return itemName;
    const matches = findPartialMatches(client, itemName);
    if (matches.length === 0) throw new Error(`Item "${itemName}" not found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  // Symmetric to resolveItemName, but resolves against checked-off items —
  // used by uncheck_item, which only makes sense on an already-checked item.
  async function resolveCheckedItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact && exact.checked) return itemName;
    const matches = findPartialMatches(client, itemName, true);
    if (matches.length === 0) throw new Error(`No checked-off item matching "${itemName}" found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  let lastStoreSignature = '';

  const registeredTool = server.registerTool("shopping", {
    title: "Shopping Lists & Items",
    description: buildDescription([]),
    inputSchema: {
      action: z.enum(["list_lists", "create_list", "rename_list", "list_items", "add_item", "add_items",
        "set_item_store", "check_item", "uncheck_item", "delete_item", "get_favorites", "get_recents", "list_stores",
        "list_categories", "create_category", "rename_category", "delete_category"]).describe("The shopping action to perform"),
      list_name: z.string().optional().describe("Name of the list to act on (defaults to configured default list). For create_list, the name of the new list; for rename_list, the existing list to rename."),
      name: z.string().optional().describe("Item name (required for add_item, set_item_store, check_item, uncheck_item, delete_item)"),
      items: z.array(z.union([
        z.string(),
        z.object({
          name: z.string(),
          quantity: z.union([z.number().min(1), z.string().min(1)]).optional(),
          notes: z.string().optional(),
          category: z.string().optional(),
          store_name: z.string().optional(),
        })
      ])).optional().describe("Items to add (add_items only). Each entry is either a plain item name or an object with name/quantity/notes/category/store_name"),
      quantity: z.union([z.number().min(1), z.string().min(1)]).optional().describe("Item quantity, e.g. 2 or \"500 g\" (add_item only, defaults to 1)"),
      notes: z.string().optional().describe("Notes for the item (add_item only)"),
      include_checked: z.boolean().optional().describe("Include checked-off items (list_items only, default false)"),
      include_notes: z.boolean().optional().describe("Include notes for each item (list_items only, default false)"),
      category: z.string().optional().describe(`Category for the item (add_item only, defaults to 'other'). Either a built-in category slug (${valid_categories.join(", ")}) or the name of an existing custom category (see list_categories / create_category).`),
      store_name: z.string().optional().describe("Store to assign to this item (add_item and set_item_store only; omit or leave blank to clear)"),
      category_name: z.string().optional().describe("Category name (required for create_category, rename_category, delete_category; the category to act on)"),
      new_category_name: z.string().optional().describe("New name for the category (rename_category only)"),
      new_list_name: z.string().optional().describe("New name for the list (rename_list only)"),
    }
  }, async (params) => {
    const { action, list_name, name, quantity, notes, include_checked, include_notes } = params;
    try {
      const client = await getClient();
      switch (action) {
        case "list_lists": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const lists = client.getLists();
          if (lists.length === 0) return textResponse("No lists found in the account.");
          const output = lists.map(l => `- ${l.name} (${l.uncheckedCount} unchecked items)`).join("\n");
          return textResponse(`Available lists (${lists.length}):\n${output}`);
        }
        case "create_list": {
          let newListName = list_name;
          if (!newListName) newListName = await elicitRequiredField("list_name", "What would you like to name the new list?");
          const created = await client.createList(newListName);
          return textResponse(`Successfully created list "${created.name}"`);
        }
        case "rename_list": {
          let targetListName = list_name;
          if (!targetListName) targetListName = await elicitRequiredField("list_name", "Which list would you like to rename?");
          let newListName = params.new_list_name;
          if (!newListName) newListName = await elicitRequiredField("new_list_name", `What should "${targetListName}" be renamed to?`);
          await client.connect(targetListName);
          const renamed = await client.renameList(newListName);
          return textResponse(`Successfully renamed list "${targetListName}" to "${renamed.name}"`);
        }
        case "list_items": {
          let resolvedListName = list_name;
          if (!resolvedListName && !client.defaultListName) {
            await client.connect(null);
            const lists = client.getLists();
            if (lists.length > 1) {
              resolvedListName = await elicitListName(lists);
            }
          }
          await client.connect(resolvedListName);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const items = await client.getItems(include_checked || false, include_notes || false);
          if (items.length === 0) {
            return textResponse(include_checked
              ? `List "${client.targetList.name}" is empty.`
              : `No unchecked items on list "${client.targetList.name}".`);
          }
          const itemsByCategory = {};
          items.forEach(item => {
            const cat = item.category || 'other';
            if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
            itemsByCategory[cat].push(item);
          });
          const itemList = Object.keys(itemsByCategory).sort().map(category => {
            const categoryItems = itemsByCategory[category].map(item => {
              const qRaw = item.quantity == null ? "" : String(item.quantity).trim();
              const qty = (qRaw && qRaw !== "1") ? ` (${qRaw})` : "";
              const status = item.checked ? " ✓" : "";
              const note = item.note ? ` [${item.note}]` : "";
              const store = item.store ? ` @${item.store}` : "";
              return `  - ${item.name}${qty}${status}${note}${store}`;
            }).join("\n");
            return `**${category}**\n${categoryItems}`;
          }).join("\n\n");
          return textResponse(`Shopping list "${client.targetList.name}" (${items.length} items):\n${itemList}`);
        }
        case "add_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to add?");
          await client.connect(list_name);
          
          const {valid, message} = await validateStoreName(client, params.store_name);
          if (!valid)
            return errorResponse(message);

          const { matchId, categoryAssignment, message: categoryError } = await resolveCategoryMatchId(client, params.category);
          if (categoryError) return errorResponse(categoryError);

          await client.addItem(itemName, quantity || 1, notes || null, matchId, params.store_name || null, categoryAssignment || null);
          return textResponse(`Successfully added "${itemName}" to list "${client.targetList.name}"`);
        }
        case "add_items": {
          const entries = params.items;
          if (!entries || entries.length === 0) throw new Error(`Action "add_items" requires a non-empty "items" array`);
          await client.connect(list_name);
          const added = [];
          const failed = [];
          for (const entry of entries) {
            const item = typeof entry === "string" ? { name: entry } : entry;
            try {
              const { matchId, categoryAssignment, message: categoryError } = await resolveCategoryMatchId(client, item.category);
              if (categoryError) throw new Error(categoryError);
              const { valid, message } = await validateStoreName(client, item.store_name);
              if (!valid) throw new Error(message);
              await client.addItem(item.name, item.quantity || 1, item.notes || null, matchId, item.store_name || null, categoryAssignment || null);
              added.push(item.name);
            } catch (error) {
              failed.push(`${item.name}: ${error.message}`);
            }
          }
          const summary = [`Added ${added.length} of ${entries.length} items to list "${client.targetList.name}":`];
          added.forEach(n => summary.push(`  ✓ ${n}`));
          failed.forEach(f => summary.push(`  ✗ ${f}`));
          return failed.length > 0 ? errorResponse(summary.join("\n")) : textResponse(summary.join("\n"));
        }
        case "check_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to check off?");
          await client.connect(list_name);
          const resolvedCheck = await resolveItemName(client, itemName);
          await client.removeItem(resolvedCheck);
          return textResponse(`Successfully checked off "${resolvedCheck}" from list "${client.targetList.name}"`);
        }
        case "uncheck_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to uncheck?");
          await client.connect(list_name);
          const resolvedUncheck = await resolveCheckedItemName(client, itemName);
          await client.uncheckItem(resolvedUncheck);
          return textResponse(`Successfully unchecked "${resolvedUncheck}" on list "${client.targetList.name}"`);
        }
        case "delete_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to delete?");
          await client.connect(list_name);
          const resolvedDelete = await resolveItemName(client, itemName);
          await client.deleteItem(resolvedDelete);
          return textResponse(`Successfully deleted "${resolvedDelete}" from list "${client.targetList.name}"`);
        }
        case "get_favorites": {
          await client.connect(list_name || null);
          const items = await client.getFavoriteItems(list_name);
          if (items.length === 0) return textResponse(`No favorite items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Favorite items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "get_recents": {
          await client.connect(list_name || null);
          const items = await client.getRecentItems(list_name);
          if (items.length === 0) return textResponse(`No recent items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Recent items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "list_stores": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          if (stores.length === 0) return textResponse(`No stores found for list "${client.targetList.name}".`);
          const list = stores.map(s => `- ${s.name}`).join('\n');
          return textResponse(`Stores for "${client.targetList.name}" (${stores.length}):\n${list}`);
        }
        case "list_categories": {
          await client.connect(list_name || null);
          const categories = client.getCategories();
          if (categories.length === 0) return textResponse(`No categories found for list "${client.targetList.name}".`);
          const list = categories.map(c => `- ${c.name}${c.systemCategory ? '' : ' (custom)'}`).join('\n');
          return textResponse(`Categories for "${client.targetList.name}" (${categories.length}):\n${list}`);
        }
        case "create_category": {
          let categoryName = params.category_name;
          if (!categoryName) categoryName = await elicitRequiredField("category_name", "What would you like to name the new category?");
          await client.connect(list_name);
          const created = await client.createCategory(categoryName);
          return textResponse(`Successfully created category "${created.name}" on list "${client.targetList.name}"`);
        }
        case "rename_category": {
          let categoryName = params.category_name;
          if (!categoryName) categoryName = await elicitRequiredField("category_name", "Which category would you like to rename?");
          let newCategoryName = params.new_category_name;
          if (!newCategoryName) newCategoryName = await elicitRequiredField("new_category_name", `What should "${categoryName}" be renamed to?`);
          await client.connect(list_name);
          const renamed = await client.renameCategory(categoryName, newCategoryName);
          return textResponse(`Successfully renamed category "${categoryName}" to "${renamed.name}" on list "${client.targetList.name}"`);
        }
        case "delete_category": {
          let categoryName = params.category_name;
          if (!categoryName) categoryName = await elicitRequiredField("category_name", "Which category would you like to delete?");
          await client.connect(list_name);
          await client.deleteCategory(categoryName);
          return textResponse(`Successfully deleted category "${categoryName}" from list "${client.targetList.name}"`);
        }
      }
    } catch (error) {
      return errorResponse(`Shopping ${action} failed: ${error.message}`);
    }
  });
}
