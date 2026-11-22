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
- add_recipes: Add recipes (by id) to collections (by id), or to new collections (by name), in one batch. Only adds; returns JSON`,
    inputSchema: {
      action: z.enum(["list", "create", "delete", "add_recipes"]).describe("The collection action to perform"),
      name: z.string().optional().describe("Collection name (required for create, delete)"),
      recipe_names: z.array(z.string()).optional().describe("Recipe names to include (create only)"),
      changes: z.array(z.object({
        collection_id: z.string().optional().describe("An existing collection's id"),
        create_name: z.string().optional().describe("Name for a new collection (instead of collection_id)"),
        recipe_ids: z.array(z.string()).min(1).describe("Recipe ids to add"),
      })).optional().describe("add_recipes only: one entry per collection"),
      format: z.enum(["text", "json"]).optional().describe("Output format for list: 'json' returns [{id, name, recipeIds}] for programmatic use (default text)"),
    }
  }, async (params) => {
    const { action, name, format, recipe_names, changes } = params;
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
        case "delete": {
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
