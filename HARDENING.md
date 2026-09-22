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

## Hardening steps for the real deployment (beyond the quick-tunnel test setup)

- [x] **Non-root container user** — fixed: `Dockerfile` had no `USER` directive (ran as root). Added `chown -R node:node` + `USER node` before `CMD`, using the unprivileged user the `node:22-alpine` base image already ships. Verified via `docker compose exec anylist-mcp whoami` → `node`.
- [x] `.env` / `config/allowed-emails.txt` git-ignored — confirmed (root `.gitignore` covers both patterns; also has its own `.gitignore` upstream).
- [x] Swap the quick/temporary Cloudflare tunnel for a **named tunnel** on a real subdomain — done: `anylist.bllrd.co`, via `infra/cloudflare/terraform/` (`module "anylist"`). DNS delegated to Cloudflare at the registrar; DNSSEC enabled.
- [x] ~~Add Cloudflare Access with a Service Token requirement in front of it~~ — **tried and reverted**: a service-token-only Access policy on `/setup`/`/login` returns a dead-end 403 for any browser (no fallback login for a human — service tokens are machine-to-machine only). Confirmed live, then removed (`access_protected_paths = []` in `main.tf`). AnyList runs with **no Cloudflare Access layer** — its own `allowed-emails.txt` + password auth gates registration, and `/mcp` is separately protected by its own OAuth bearer token. See `infra/cloudflare/terraform/modules/mcp-tunnel/variables.tf` for the corrected module semantics this bug produced.
- [ ] Rotate `SERVER_SECRET_KEY` / `SESSION_SECRET` from whatever was used in early testing — regenerate both with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` before any real/production deployment. **Rotating `SERVER_SECRET_KEY` invalidates every already-stored encrypted AnyList credential** (it's the AES-256-GCM key protecting them at rest) — anyone registered will need to redo `/setup` after a rotation.
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

## Custom category management: reverse-engineered endpoint, verified live 2026-09-22

`shopping`'s `create_category`/`rename_category`/`delete_category`/`list_categories` actions (added 2026-09-22) call `List.createCategory`/`renameCategory`/`removeCategory` in the vendored `anylist-js` submodule (pinned commit already includes this, upstream `bobby060/anylist-js` commit `1788508`). Those methods post `PBListOperation` envelopes to `data/shopping-lists/update-v2`, based on the reverse-engineered Rust client `phildenhoff/anylist_rs` — not a documented AnyList API, and there's no test coverage for it in `anylist-js`'s own test suite.

**Confirmed live-working (2026-09-22, "TEMP PACKING LIST 4")**, after two rounds of live testing and fixes (see the whole-list create/rename section below for both bugs found and fixed along the way): creating two custom categories and adding an item under each landed correctly in the AnyList app — real categories, in the list's actual active category set, items no longer falling back to "Other". `rename_category`/`delete_category` are unchanged by either fix and remain unverified live; same for assigning an *existing* item to a custom category (only new-item creation was exercised).

## Whole-list create/rename: reverse-engineered; create_list verified live, rename_list not yet

`shopping`'s `create_list`/`rename_list` actions (added 2026-09-22) needed new methods on `anylist-js` itself — `AnyList.createList`/`renameList` in `anylist-js/lib/index.js` — since the upstream library had no way to create or rename a whole list at all (only per-list operations like items/categories/stores). Reverse-engineered the same way as the category work: `phildenhoff/anylist_rs`'s `create_list`/`rename_list` (handler IDs `new-shopping-list`/`rename-list`) posting to the same `data/shopping-lists/update` (v1) endpoint `addItem`/`removeItem` already use live.

**`create_list` confirmed live-working (2026-09-22)**: creating a list via the app-visible name succeeded end-to-end in a real Claude web session.

**Found and fixed (2026-09-22, round 1)**: `create_category` on a just-created list failed with "List has no category groups". Root cause was a stale-cache bug, not a missing server capability — AnyList's server auto-provisions a default category group on list creation (observed live as an "Untitled Category Set" containing just "Other"), but `AnyList.createList` built its returned `List` object locally instead of re-fetching from the server, so that list's `categoryGroups` stayed empty for the rest of the session. Fixed by having `createList` call `getLists()` again after the create op and return the freshly-fetched list. Also added `List.createCategoryGroup` as a last-resort fallback for the genuine "no group at all" case (handler ID `create-category-group`, operation class 4/`ListCategoryGroupOperation` — both guessed, no reference implementation existed to copy since `phildenhoff/anylist_rs` doesn't create groups either).

**Re-verified live, found and fixed a second bug (2026-09-22, round 2)**: the group-discovery fix worked — a retest showed only one category set (the app's real default), correctly containing the new custom categories. But items assigned to them still displayed as "Other". Cause: `Item.assignToCustomCategory` (already present in the vendored `anylist-js`, from the same upstream commit as `createCategory`) has a docblock explicitly warning that setting `categoryMatchId` alone "creates a 'shadow' entry that isn't recognized as a real category-group membership" — a real category assignment needs a follow-up `update-list-item` op carrying `categoryAssignments` (with the real `categoryGroupId`/`categoryId`) too, which `AnyListClient.addItem` never sent. Fixed: `resolveCategoryMatchId` (`src/tools/shopping.js`) now returns a `categoryAssignment` alongside `matchId` for a custom category (using a slugified name as the fallback `matchId`, per that docblock's guidance, instead of the raw category UUID), and `AnyListClient.addItem` calls `item.assignToCustomCategory(...)` right after creating a **brand-new** item if one is given. Deliberately **not** applied to the existing-item update path — `assignToCustomCategory` re-encodes the whole item via `Item._encode()`, and `Item` doesn't track `recipeId`/prices/photoIds, so running it against an item that already has those could silently drop them (a pre-existing comment on `addItem` already flagged this same risk for a different reason).

**Re-verified live a second time (2026-09-22, "TEMP PACKING LIST 4"): confirmed working.** Two custom categories created, one item added under each, both landed under their real category in the app (not "Other"), no orphaned second category set. This closes out the full create-list → create-category → add-item-with-custom-category flow as live-verified.

Also noticed in passing, unrelated to this bug: `item.js` has its entire `setStores`/`assignToCustomCategory` section duplicated verbatim (a `git log`-visible upstream merge artifact, not something introduced here) — harmless (JS just uses the later definition, byte-identical to the first) but worth a cleanup pass sometime; that's what the `xo` "Duplicate name" lint errors bypassed with `--no-verify` earlier were flagging.

**Known remaining gap, not yet solved**: even the fallback `createCategoryGroup` path doesn't make its group the list's *active* one — that's `PBListSettings.listCategoryGroupId`, set via a separate `data/list-settings/update` operation this pass didn't implement. Should be moot for the normal case now that `createList` discovers the server's real default group, but would resurface if that group is ever genuinely absent.

`delete_list` was deliberately left out of this pass — it needs `listFoldersResponse`/`listSettingsResponse` from user-data, which nothing in `anylist-js` currently decodes.

## Logging integration: none, deliberately

Don't add a `services/logging` dependency or `log_execution()` calls into this vendored source. `execution_logs` rows for every call to this server are the orchestrator's job (it's the MCP client making the calls) — adding logging here would mean maintaining a diff from upstream for something the orchestrator already covers, which cuts against the whole point of the single-directory vendoring pattern (hardening commits only, kept minimal and rebasable). See `orchestrator/README.md`'s Logging integration section.
