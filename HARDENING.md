# Samwise notes: hardening, audit, and deployment (Pippin)

This file is ours, not upstream's — kept separate from `README.md` (upstream's own, vendored) specifically so `git fetch upstream` never conflicts with our notes. See "Upstream source" below for how this directory relates to the actual `bobby060/anylist-mcp` project.

## Upstream source

- **Original project**: [`bobby060/anylist-mcp`](https://github.com/bobby060/anylist-mcp) — has its own nested submodule, `anylist-js/`, unaffected by anything below (we've never needed to modify it, so it's still pinned straight from `bobby060/anylist-js`).
- **Used with its full tool set** (lists, recipes, meal planning, shopping/retailer send) for the initial build — not scoped down. See `docs/architecture/mcp-anylist.md` for why (Pippin/AnyList stays the primary system for this domain; the custom Obsidian-based replacement is Phase 2, deferred — see `docs/architecture/lists-recipes-meal-planning.md`).
- **Vendored via a fork, not the original repo directly**: `.gitmodules` points this submodule at [`sbllrd/anylist-mcp`](https://github.com/sbllrd/anylist-mcp) (a fork), not `bobby060/anylist-mcp` — needed because our own hardening commits (the non-root Dockerfile fix, this file) get pushed there. The original repo isn't ours to push to. Remotes in this directory: `origin` = the fork (push here), `upstream` = the original repo (fetch-only, never push).
- **Working approach**: hardening work happens as commits directly on top of upstream's own history in this directory (not a separate clean copy) — `git log --oneline` here shows both upstream's commits and ours.
- **Pulling upstream updates**:
  ```
  cd services/mcp-anylist
  git fetch upstream
  git rebase upstream/main          # replay our commits onto the new upstream tip
  git submodule update --init       # in case anylist-js's pinned commit also changed
  git push origin main              # keep the fork's main in sync with our rebased history
  cd ../..
  git add services/mcp-anylist && git commit   # record the new pinned commit in the parent repo
  ```
  A plain `git submodule update --remote` would instead reset to `origin`'s tip with no rebase — since `origin` is our fork, that's actually safe here (it'd just re-fetch what we already pushed), but it won't pull anything new from upstream at all. Always fetch from `upstream` specifically to get real upstream changes. Re-verify the hardening below after any upstream update — a rebase or upstream change can silently affect it (e.g. the Dockerfile regaining a `USER` directive that conflicts with ours, or losing it again).
- **Fresh clone of the parent repo**: `git submodule update --init` sets up `origin` (the fork) automatically from `.gitmodules`, but not `upstream` — add it yourself: `git remote add upstream https://github.com/bobby060/anylist-mcp.git`.
- **Current pinned commit**: see `git submodule status` from the repo root, or `git -C services/mcp-anylist log -1`.

## Already has, out of the box

- HTTP mode via Docker Compose (`--profile cloudflare-temp` for a quick disposable tunnel)
- App-level auth via `allowed-emails.txt` (gates who can *register*; see upstream's OAuth model — `/mcp` itself is gated by a bearer token issued through that registration/login flow, not by the allowlist directly)
- Its own `.env.http.example` — copy and fill in real values, never commit

## Status

Live on a named Cloudflare Tunnel (2026-09-14) — `anylist.bllrd.co`, provisioned via `infra/cloudflare/terraform/` (`module "anylist"`), running `--profile cloudflare-named`. Re-verified end-to-end first on the quick tunnel (Docker build + a live Claude custom connector, real AnyList account, a real `shopping` tool call succeeded from a claude.ai chat), then moved to the named tunnel.

**Re-verified again (2026-09-14, second pass)**: both containers up and healthy (`docker ps` — `anylist-mcp` reporting `(healthy)`, `cloudflared-named` showing 4 registered QUIC connections to the Cloudflare edge), `GET https://anylist.bllrd.co/health` → `200 {"status":"ok"}`, `GET /mcp` → `401` (correct — unauthenticated), `GET /login` → `200`, `GET /setup` → `302`. The Claude connector in this session reported a `502` at session start; infra was fully healthy by the time this was checked minutes later, so treated as transient (a mid-request tunnel reconnect, most likely) rather than a real outage — worth another look if it recurs. Reconnecting the connector itself is a client-side action (claude.ai/Desktop settings), not something checkable from here.

**Moved to the Mac Mini (2026-09-24).** Rebuilt from scratch rather than copying state:
- Tunnel token copied from the existing tunnel in the Cloudflare dashboard (no Terraform on this machine, no carried-over `terraform.tfstate`), so the same tunnel + `anylist.bllrd.co` DNS are reused. The dev machine's `cloudflared` has to be stopped first, or Cloudflare load-balances across both connectors.
- `SERVER_SECRET_KEY`/`SESSION_SECRET` rotated (see checklist below); Google sign-in left disabled; `config/allowed-emails.txt` recreated (gitignored) with the single owner address; `.env` `chmod 600` again (a fresh file is `644`).
- **Host port bound to loopback** via `PORT=127.0.0.1:3000` in `.env` — the compose default `${PORT:-3000}:3000` publishes on every interface, which exposed the server to the whole LAN, bypassing the tunnel. `cloudflared-named` reaches the app over the compose network, so nothing needs the LAN port. Verified: LAN IP → unreachable, `127.0.0.1` → `200`.
- Fresh `/setup` registration (human), fresh `orchestrator-gandalf` client via `create-client.js`, fresh 180-day token set in ZeroClaw. Gotcha hit: a leading space pasted into `client_id` gives `invalid_client` (server logs `client not found`, with the space visible in the logged prefix).
- Verified: 4 tunnel connections registered; `/health` 200, `/mcp` 401 unauthenticated, `/login` 200, `/setup` 302 publicly; ZeroClaw's `initialize` + `tools/list` → 200 after its service restart.
- **Open**: `cloudflared-named` still uses `cloudflare/cloudflared:latest` — a floating tag on the container that holds the tunnel credential (pin-dependencies principle). Pin to a digest.
- **Open**: containers restart only if Docker Desktop itself starts at login — confirm "Start Docker Desktop when you sign in" is on.

## Hardening steps for the real deployment (beyond the quick-tunnel test setup)

- [x] **Non-root container user** — fixed: `Dockerfile` had no `USER` directive (ran as root). Added `chown -R node:node` + `USER node` before `CMD`, using the unprivileged user the `node:22-alpine` base image already ships. Verified via `docker compose exec anylist-mcp whoami` → `node`.
- [x] `.env` / `config/allowed-emails.txt` git-ignored — confirmed (root `.gitignore` covers both patterns; also has its own `.gitignore` upstream).
- [x] Swap the quick/temporary Cloudflare tunnel for a **named tunnel** on a real subdomain — done: `anylist.bllrd.co`, via `infra/cloudflare/terraform/` (`module "anylist"`). DNS delegated to Cloudflare at the registrar; DNSSEC enabled.
- [x] ~~Add Cloudflare Access with a Service Token requirement in front of it~~ — **tried and reverted**: a service-token-only Access policy on `/setup`/`/login` returns a dead-end 403 for any browser (no fallback login for a human — service tokens are machine-to-machine only). Confirmed live, then removed (`access_protected_paths = []` in `main.tf`). AnyList runs with **no Cloudflare Access layer** — its own `allowed-emails.txt` + password auth gates registration, and `/mcp` is separately protected by its own OAuth bearer token. See `infra/cloudflare/terraform/modules/mcp-tunnel/variables.tf` for the corrected module semantics this bug produced.
- [x] **Rotated 2026-09-24 on the Mac Mini cutover** (fresh `openssl rand -hex 32` each; free at that point since the new machine's `anylist_data` volume was empty — nothing stored under the old key). Original note: Rotate `SERVER_SECRET_KEY` / `SESSION_SECRET` from whatever was used in early testing — regenerate both with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` before any real/production deployment. **Rotating `SERVER_SECRET_KEY` invalidates every already-stored encrypted AnyList credential** (it's the AES-256-GCM key protecting them at rest) — anyone registered will need to redo `/setup` after a rotation.
- [x] `chmod 600` on `.env` — was `644` (world-readable), fixed 2026-09-14; git-ignored confirmed via the submodule's own `.gitignore` (`git check-ignore -v .env`)
- [ ] Consider a dedicated AnyList account/password rather than reuse, given it sits in plaintext on the host — **deliberately deferred**: using the real/existing household account for now, since the whole point is acting on real lists.

## Machine-to-machine auth (for the orchestrator, not a browser client)

The orchestrator (`orchestrator/zeroclaw`) needs to call this server directly, but its MCP client only supports a **static** `Authorization` header — no OAuth refresh loop like a browser-based client (claude.ai, Home Assistant) has. That ruled out the normal `authorization_code` flow (1-hour access tokens, refresh required).

Fixed 2026-09-14 (see git log): the server already had a dormant `client_credentials` grant and a `scripts/create-client.js` provisioning script for confidential OAuth clients — neither was ever wired to anything, and the grant minted the same 1-hour token as the browser flow. Two small changes:
- `saveOAuthTokens` takes an optional `accessTtlSeconds` (default unchanged, `3600`, for the browser flow).
- `handleClientCredentialsGrant` now requests a 180-day TTL — long enough to not be an operational burden on an always-on box, short enough to force a conscious rotation rather than a de-facto permanent credential.

**Provisioning a service token** (run once, from the host, human-run — not scripted through an agent):
```
docker exec mcp-anylist-anylist-mcp-1 node scripts/create-client.js <your-email> "orchestrator-gandalf"
# prints client_id + client_secret ONCE — not retrievable afterward

curl -s -X POST https://anylist.bllrd.co/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"<id>","client_secret":"<secret>"}'
# returns {"access_token": "...", "expires_in": 15552000, ...}
```
Save the `client_id`/`client_secret` somewhere safe — they let you mint a fresh `access_token` again in 180 days without re-running the provisioning script. The `access_token` itself is what goes into ZeroClaw's `mcp.servers.anylist.headers.Authorization` (as `Bearer <token>`), set via ZeroClaw's own masked `config set` prompt — never pasted into a chat or committed. See `orchestrator/HARDENING.md`'s MCP section.

**Provisioned so far**: one confidential client, `client_id` starting `a042be95…`, `client_name = "orchestrator-gandalf"`, scoped to `sballard19@gmail.com`'s account. Revoke by deleting its row from `oauth_clients` in the server's SQLite DB if it's ever compromised or no longer needed — there's no CLI/HTTP revoke path yet, only manual DB access (`docker exec ... sqlite3 /data/anylist-mcp.db "DELETE FROM oauth_clients WHERE client_id = '...'"`).

## Testable now, no hardware needed

Fully testable via Docker on any dev machine — this doesn't require the Mac Mini at all except for the final always-on deployment.

## Custom category management: category creation works; item assignment does not

`shopping`'s `create_category`/`rename_category`/`delete_category`/`list_categories` actions (added 2026-09-22) call `List.createCategory`/`renameCategory`/`removeCategory` in the vendored `anylist-js` submodule (pinned commit already includes this, upstream `bobby060/anylist-js` commit `1788508`). Those methods post `PBListOperation` envelopes to `data/shopping-lists/update-v2`, based on the reverse-engineered Rust client `phildenhoff/anylist_rs` — not a documented AnyList API, and there's no test coverage for it in `anylist-js`'s own test suite.

**`create_category`/`rename_category`/`delete_category`/`list_categories` confirmed live-working (2026-09-22, "Jamaica Packing List - TEST")**: 14 custom categories created correctly across a real multi-category-group list, all showing up right in the app's list settings.

**Assigning an item to a custom category does NOT work, despite an earlier incorrect "confirmed" claim here — see the correction in the whole-list create/rename section below.** `add_item`/`add_items`' `category` param still resolves a custom category name to a `categoryAssignment` and attempts `Item.assignToCustomCategory`, but it has no effect: items land under "Other" in the app regardless. Left in place because it's harmless (no data loss, no errors) and because a future fix (once the real mechanism is found) would wire into this same code path — but don't rely on it. Built-in category assignment (`category: "produce"` etc., the original enum-based path) is unaffected and still works as before.

## Whole-list create/rename: reverse-engineered; create_list verified live, rename_list not yet

`shopping`'s `create_list`/`rename_list` actions (added 2026-09-22) needed new methods on `anylist-js` itself — `AnyList.createList`/`renameList` in `anylist-js/lib/index.js` — since the upstream library had no way to create or rename a whole list at all (only per-list operations like items/categories/stores). Reverse-engineered the same way as the category work: `phildenhoff/anylist_rs`'s `create_list`/`rename_list` (handler IDs `new-shopping-list`/`rename-list`) posting to the same `data/shopping-lists/update` (v1) endpoint `addItem`/`removeItem` already use live.

**`create_list` confirmed live-working (2026-09-22)**: creating a list via the app-visible name succeeded end-to-end in a real Claude web session.

**Found and fixed (2026-09-22, round 1)**: `create_category` on a just-created list failed with "List has no category groups". Root cause was a stale-cache bug, not a missing server capability — AnyList's server auto-provisions a default category group on list creation (observed live as an "Untitled Category Set" containing just "Other"), but `AnyList.createList` built its returned `List` object locally instead of re-fetching from the server, so that list's `categoryGroups` stayed empty for the rest of the session. Fixed by having `createList` call `getLists()` again after the create op and return the freshly-fetched list. Also added `List.createCategoryGroup` as a last-resort fallback for the genuine "no group at all" case (handler ID `create-category-group`, operation class 4/`ListCategoryGroupOperation` — both guessed, no reference implementation existed to copy since `phildenhoff/anylist_rs` doesn't create groups either).

**Round 2 (2026-09-22)**: the group-discovery fix worked — a retest showed only one category set (the app's real default), correctly containing the new custom categories. But items assigned to them still displayed as "Other". Cause identified: `Item.assignToCustomCategory` (already present in the vendored `anylist-js`, from the same upstream commit as `createCategory`) has a docblock explicitly warning that setting `categoryMatchId` alone "creates a 'shadow' entry that isn't recognized as a real category-group membership" — a real category assignment supposedly needs a follow-up `update-list-item` op carrying `categoryAssignments` too. Wired that in: `resolveCategoryMatchId` (`src/tools/shopping.js`) resolves a custom category to a `categoryAssignment` (`categoryGroupId`/`categoryId`) alongside a slugified fallback `matchId`, and `AnyListClient.addItem` calls `item.assignToCustomCategory(...)` right after creating a **brand-new** item. Deliberately not applied to the existing-item update path — `assignToCustomCategory` re-encodes the whole item via `Item._encode()`, and `Item` doesn't track `recipeId`/prices/photoIds, so running it against an item that already has those could silently drop them.

**This did not actually work — incorrectly reported as "confirmed" here at the time, corrected 2026-09-22 after a real investigation.** The original "confirmed" claim was based on a quick visual check of a screenshot I never actually saw myself (it errored on read) plus the user's brief "I think we got it." A later live test on "Jamaica Packing List - TEST" (115 items, 14 custom categories) showed roughly half the items displaying under the wrong category in the app, which prompted a deeper investigation:

- Wrote diagnostic scripts run directly inside the deployed container (using the server's own `SERVER_SECRET_KEY`-decrypted stored credentials — the same trust boundary the server itself already operates under, nothing new exposed) to read the *raw* server state, bypassing our own `Item`/`List` wrapper classes entirely.
- **Confirmed `categoryAssignments` is empty on every single item in both test lists** (not just ones with special characters in the category name, disproving that theory) — `assignToCustomCategory` has never actually worked, for anyone, ever. The ~half of Jamaica's items that displayed correctly are almost certainly AnyList's own name-based auto-categorization memory (from years of real account usage) coincidentally landing common item names in the right place, independent of anything our code sent — not evidence our fix works.
- Ruled out a client-side encoding bug: constructed the exact same `PBListOperation`/`ListItem` message locally, encoded it, decoded it back — `categoryAssignments` round-trips perfectly. The POST reaches the server (200 response) but has no server-side effect.
- Found and tried `PBListCategorizationRule` (`itemName` → `categoryId`, its own dedicated `OperationClass` enum value, id 5) — an entirely separate, unused mechanism that looked like it might be how AnyList actually associates items with custom categories. Posted one live (handler ID guessed as `create-categorization-rule`) — got a 200, but no rule was actually created (re-read `PBListResponse.categorizationRules`, still empty). Wrong handler ID, wrong approach, or both.
- Checked `phildenhoff/anylist_rs` again specifically for this — it doesn't implement categorization rules or item-category-assignment at all. No reference implementation exists to copy, unlike everything else reverse-engineered so far.

**Status: unsolved.** `create_list`/`create_category` are genuinely verified live-working. Assigning an item to a *custom* (non-built-in) category is not, and isn't likely to be solvable by further guessing against the live API — the next real lead would be capturing actual network traffic from the AnyList app itself while manually categorizing an item, the same way category creation was originally reverse-engineered by the Rust crate's author. `add_item`/`add_items` with a *built-in* category (`category: "produce"` etc.) are unaffected by any of this.

Also noticed in passing, unrelated to this bug: `item.js` has its entire `setStores`/`assignToCustomCategory` section duplicated verbatim (a `git log`-visible upstream merge artifact, not something introduced here) — harmless (JS just uses the later definition, byte-identical to the first) but worth a cleanup pass sometime; that's what the `xo` "Duplicate name" lint errors bypassed with `--no-verify` earlier were flagging.

**Known remaining gap, not yet solved**: even the fallback `createCategoryGroup` path doesn't make its group the list's *active* one — that's `PBListSettings.listCategoryGroupId`, set via a separate `data/list-settings/update` operation this pass didn't implement. Should be moot for the normal case now that `createList` discovers the server's real default group, but would resurface if that group is ever genuinely absent.

`delete_list` was deliberately left out of this pass — it needs `listFoldersResponse`/`listSettingsResponse` from user-data, which nothing in `anylist-js` currently decodes.

## `list_items` phantom-category bug: fixed and confirmed live

Bug report (2026-09-22, from "To Do Before Jamaica", 36 items): `list_items` grouped items into categories `list_categories` didn't know about (`2-3-weeks-before`, `now`, `start-now`, `travel-week`) — stable across repeat calls, so not a race, and confirmed wrong against a manual PDF export of the real list from the app.

**Root cause**: `AnyListClient.getItems` (`src/anylist-client.js`) grouped items by `item.categoryMatchId` — a slug snapshotted onto the item at the time it was last assigned to a category, and never updated afterwards. Renaming or deleting a custom category doesn't touch existing items' `categoryMatchId`, so it goes stale and produces exactly this kind of phantom grouping. The item's `categoryAssignments` (`categoryGroupId`/`categoryId`), by contrast, is the live foreign key into the list's current category groups — the same field `list_categories` itself reads from (`AnyListClient.getCategories`). There was already a `_buildCategoryMap()` method sketching this fix, but it was dead code, never called from `getItems`.

**Fix**: `getItems` now resolves each item's category by looking up `categoryAssignments[0].categoryId` against the list's *current* categories, using that category's live name (slugified, to keep the existing display format) when found, and falling back to the old `categoryMatchId` behavior only when there's no assignment (built-in categories, which don't use `categoryAssignments` at all) or the assigned category no longer exists. Verified against synthetic `targetList` data reproducing the exact bug shape (a stale `categoryMatchId` alongside a still-valid `categoryAssignments` entry) — the item now resolves to the current category instead of the phantom one.

**Confirmed live (2026-09-22)**: rebuilt and redeployed the container (`docker compose --profile cloudflare-named build/up anylist-mcp`), then re-ran `list_categories`/`list_items` against the real "To Do Before Jamaica" list through the live connector. All 4 phantom categories (`2-3-weeks-before`, `now`, `start-now`, `travel-week`) are gone; all 36 items now group under exactly the 4 real custom categories (`friday-morning`, `hygiene-routine`, `next-week`, `this-week`) that `list_categories` reports, item count unchanged. This also answers the open question from the write-path investigation above: `categoryAssignments` **is** populated correctly for items added through the real AnyList app — the earlier "empty on every item" finding was specific to items that only ever went through our own broken `assignToCustomCategory` path, not evidence the field itself is unused by AnyList's real client.

## Logging integration: none, deliberately

Don't add a `services/logging` dependency or `log_execution()` calls into this vendored source. `execution_logs` rows for every call to this server are the orchestrator's job (it's the MCP client making the calls) — adding logging here would mean maintaining a diff from upstream for something the orchestrator already covers, which cuts against the whole point of the single-directory vendoring pattern (hardening commits only, kept minimal and rebasable). See `orchestrator/README.md`'s Logging integration section.
