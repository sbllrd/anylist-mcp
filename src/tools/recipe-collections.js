import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  server.registerTool("recipe_collections", {
    title: "Recipe Collections",
    description: `Manage AnyList recipe collections. Actions:
- list: Show all collections with recipe counts and names
- create: Create a new collection, optionally with recipes
- add_recipes: Add recipes (by id) to collections (by id), or to new collections (by name), in one batch. Only adds; returns JSON
- remove_recipes: Remove recipes (by id) from collections (by id), in one batch; returns JSON
- delete: Delete a collection by name, or by collection_id, or several by collection_ids (one account read; returns JSON)`,
    inputSchema: {
      action: z.enum(["list", "create", "delete", "add_recipes", "remove_recipes"]).describe("The collection action to perform"),
      name: z.string().optional().describe("Collection name (required for create; for delete, unless collection_id is given)"),
      collection_id: z.string().optional().describe("delete only: the collection's id, instead of its name"),
      collection_ids: z.array(z.string()).min(1).optional().describe("delete only: several collection ids, deleted from one account read"),
      recipe_names: z.array(z.string()).optional().describe("Recipe names to include (create only)"),
      changes: z.array(z.object({
        collection_id: z.string().optional().describe("An existing collection's id"),
        create_name: z.string().optional().describe("Name for a new collection (instead of collection_id)"),
        recipe_ids: z.array(z.string()).min(1).describe("Recipe ids to add (or remove)"),
      })).optional().describe("add_recipes and remove_recipes: one entry per collection (remove_recipes takes collection_id only)"),
      format: z.enum(["text", "json"]).optional().describe("Output format for list: 'json' returns [{id, name, recipeIds}] for programmatic use (default text)"),
    }
  }, async (params) => {
    const { action, name, format, recipe_names, changes, collection_id, collection_ids } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const collections = await client.getRecipeCollections();
          if (format === "json") {
            return textResponse(JSON.stringify(collections.map(c => ({ id: c.identifier, name: c.name, recipeIds: c.recipeIds || [] }))));
          }
          if (collections.length === 0) return textResponse("No recipe collections found.");
          const list = collections.map(c => `- **${c.name}** (${c.recipeCount} recipes)${c.recipeCount > 0 ? ': ' + c.recipeNames.join(', ') : ''}`).join('\n');
          return textResponse(`Recipe Collections (${collections.length}):\n${list}`);
        }
        case "create": {
          let collectionName = name;
          if (!collectionName) collectionName = await elicitRequiredField("name", "What should the collection be called?");
          const result = await client.createRecipeCollection(collectionName, recipe_names || []);
          return textResponse(`Created recipe collection "${result.name}"`);
        }
        case "add_recipes": {
          if (!changes || changes.length === 0) return errorResponse('Action "add_recipes" requires "changes"');
          for (const c of changes) {
            if (!!c.collection_id === !!c.create_name) return errorResponse('Each change needs exactly one of collection_id or create_name');
          }
          const outcome = await client.addRecipesToCollections(changes.map(c => ({
            collectionId: c.collection_id || null, createName: c.create_name || null, recipeIds: c.recipe_ids,
          })));
          return textResponse(JSON.stringify(outcome));
        }
        case "remove_recipes": {
          if (!changes || changes.length === 0) return errorResponse('Action "remove_recipes" requires "changes"');
          if (changes.some(c => !c.collection_id || c.create_name)) return errorResponse('Each change needs a collection_id (and no create_name)');
          const outcome = await client.removeRecipesFromCollections(changes.map(c => ({ collectionId: c.collection_id, recipeIds: c.recipe_ids })));
          return textResponse(JSON.stringify(outcome));
        }
        case "delete": {
          if (collection_ids) {
            return textResponse(JSON.stringify(await client.deleteRecipeCollections(collection_ids)));
          }
          if (collection_id) {
            const deleted = await client.deleteRecipeCollection(null, collection_id);
            return textResponse(`Deleted recipe collection "${deleted}"`);
          }
          let deleteCollectionName = name;
          if (!deleteCollectionName) deleteCollectionName = await elicitRequiredField("name", "Which collection would you like to delete?");
          await client.deleteRecipeCollection(deleteCollectionName);
          return textResponse(`Deleted recipe collection "${deleteCollectionName}"`);
        }
      }
    } catch (error) {
      return errorResponse(`Recipe collections ${action} failed: ${error.message}`);
    }
  });
}
