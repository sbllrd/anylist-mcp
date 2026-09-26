import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";

/**
 * Per-OAuth-client scope profiles (samwise fork addition, 2026-09-26).
 *
 * Every client used to get every tool and action. A scoped client now gets
 * only the tools, and the actions within them, that its profile lists:
 * - the tool's `action` enum is narrowed, so disallowed actions aren't in
 *   the schema the client sees;
 * - the handler re-checks the action, so the schema isn't the only gate.
 *
 * Profiles live in code on purpose. The deployment only maps a client_id
 * to a profile name, through ANYLIST_CLIENT_SCOPES. That means widening a
 * profile takes a commit, not an env edit.
 *
 * A tool listed as `true` has no action parameter and is allowed whole.
 */
const SHARED_HOUSEHOLD_READ = {
  health_check: true,
  recipes: ["list", "get"],
  recipe_collections: ["list"],
  meal_plan: ["list_events", "list_labels"],
  shopping: ["list_lists", "list_items", "get_favorites", "get_recents", "list_stores", "list_categories"],
};

export const SCOPE_PROFILES = {
  // Unrestricted: upstream behavior, and what an unmapped client gets.
  full: null,
  // Phase 1 of the shared_household agent: reads only.
  shared_household_read: SHARED_HOUSEHOLD_READ,
  // Phase 2: reads, plus create-only recipe writes. The guards below make
  // sure this profile can never overwrite, update or delete a recipe.
  shared_household: {
    ...SHARED_HOUSEHOLD_READ,
    recipes: ["list", "get", "create", "import_url"],
  },
};

/**
 * Parses ANYLIST_CLIENT_SCOPES, a JSON object mapping client_id to profile
 * name, e.g. {"abc123": "shared_household"}. It fails loudly at startup on
 * an unknown profile name, rather than quietly giving that client `full`.
 */
export function parseClientScopes(raw) {
  if (!raw || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ANYLIST_CLIENT_SCOPES is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ANYLIST_CLIENT_SCOPES must be a JSON object of client_id -> profile name");
  }
  for (const [clientId, profile] of Object.entries(parsed)) {
    if (!Object.hasOwn(SCOPE_PROFILES, profile)) {
      throw new Error(`ANYLIST_CLIENT_SCOPES maps client ${clientId} to unknown profile "${profile}"`);
    }
  }
  return parsed;
}

export function profileForClient(clientScopes, clientId) {
  return (clientId && Object.hasOwn(clientScopes, clientId)) ? clientScopes[clientId] : "full";
}

// ── Guards for scoped profiles ────────────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    return `${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Create-only recipe writes. Upstream's `create` elicits and then deletes
 * an existing recipe with the same name, and its `import_url` falls back to
 * a heuristic HTML parser that can save a page that isn't a recipe. A scoped
 * client gets neither behavior: an existing name or source URL is refused,
 * and imports use AnyList's native importer only.
 *
 * A guard runs before the upstream handler; returning a response refuses
 * the call, returning null lets it through. A replacement runs instead of
 * the upstream handler entirely.
 */
const GUARDS = {
  recipes: {
    async create(params, getClient) {
      if (!params.name) return errorResponse('Action "create" requires parameter "name"');
      const client = await getClient();
      await client.connect(null);
      const existing = await client.getRecipes(params.name);
      const match = existing.find(r => r.name.toLowerCase() === params.name.toLowerCase());
      if (match) {
        return errorResponse(`Recipe "${match.name}" already exists. This client can only create new recipes, never overwrite one.`);
      }
      return null; // through to the upstream handler, which now can't reach its overwrite path
    },
  },
};

const REPLACEMENTS = {
  recipes: {
    async import_url(params, getClient) {
      const { url } = params;
      if (!url) return errorResponse('Action "import_url" requires parameter "url"');
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return errorResponse(`Not a valid URL: ${url}`);
      }
      if (!["http:", "https:"].includes(parsed.protocol) || PRIVATE_HOST.test(parsed.hostname)) {
        return errorResponse("Only public http(s) recipe URLs can be imported.");
      }
      const client = await getClient();
      await client.connect(null);
      const wanted = normalizeUrl(url);
      const existing = await client.getRecipes(null);
      const dup = existing.find(r => r.sourceUrl && normalizeUrl(r.sourceUrl) === wanted);
      if (dup) return errorResponse(`Already saved: recipe "${dup.name}" has this source URL.`);
      try {
        const result = await client.importRecipeFromUrl(url, { strict: true });
        return textResponse(`Imported recipe "${result.name}"\n- ${result.ingredientCount} ingredients, ${result.stepCount} steps`);
      } catch (error) {
        return errorResponse(`Recipes import_url failed: ${error.message}`);
      }
    },
  },
};

/**
 * Wraps an McpServer so that tool registrations are filtered and narrowed
 * to `profileName`. For `full`, it returns the server unchanged.
 */
export function scopeServer(server, profileName, getClient) {
  const profile = SCOPE_PROFILES[profileName];
  if (profile === undefined) throw new Error(`Unknown AnyList scope profile "${profileName}"`);
  if (profile === null) return server;

  const scoped = Object.create(server);
  scoped.registerTool = (name, config, handler) => {
    const allowed = profile[name];
    if (!allowed) {
      // Not registered at all. Return a stub so upstream's registeredTool.update() calls stay harmless.
      return { update: () => {} };
    }
    if (allowed === true) return server.registerTool(name, config, handler);

    const note = `\n\nThis client may only use these actions: ${allowed.join(", ")}.`;
    const narrowed = {
      ...config,
      description: `${config.description}${note}`,
      inputSchema: {
        ...config.inputSchema,
        action: z.enum(allowed).describe(config.inputSchema.action.description || "The action to perform"),
      },
    };
    const guards = GUARDS[name] || {};
    const replacements = REPLACEMENTS[name] || {};
    const wrapped = async (params, extra) => {
      if (!allowed.includes(params.action)) {
        return errorResponse(`Action "${params.action}" is not permitted for this client.`);
      }
      const replacement = replacements[params.action];
      if (replacement) return replacement(params, getClient);
      const guard = guards[params.action];
      if (guard) {
        const refused = await guard(params, getClient);
        if (refused) return refused;
      }
      return handler(params, extra);
    };
    const registered = server.registerTool(name, narrowed, wrapped);
    return {
      ...registered,
      update: (updates) => registered.update(
        updates && updates.description ? { ...updates, description: `${updates.description}${note}` } : updates,
      ),
    };
  };
  return scoped;
}
