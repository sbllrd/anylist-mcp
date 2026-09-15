# Samwise notes: hardening, audit, and deployment (Pippin)

This file is ours, not upstream's — kept separate from `README.md` (upstream's own, vendored) specifically so `git fetch upstream` never conflicts with our notes. See "Upstream source" below for how this directory relates to the actual `bobby060/anylist-mcp` project.

## Upstream source

- **Original project**: [`bobby060/anylist-mcp`](https://github.com/bobby060/anylist-mcp) — has its own nested submodule, `anylist-js/`, unaffected by anything below (we've never needed to modify it, so it's still pinned straight from `bobby060/anylist-js`).
- **Used with its full tool set** (lists, recipes, meal planning, shopping/retailer send) for the initial build — not scoped down. See `docs/PROJECT_PLAN.md` for why (Pippin/AnyList stays the primary system for this domain; the custom Obsidian-based replacement is Phase 2, deferred).
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

## Logging integration: none, deliberately

Don't add a `services/logging` dependency or `log_execution()` calls into this vendored source. `execution_logs` rows for every call to this server are the orchestrator's job (it's the MCP client making the calls) — adding logging here would mean maintaining a diff from upstream for something the orchestrator already covers, which cuts against the whole point of the single-directory vendoring pattern (hardening commits only, kept minimal and rebasable). See `orchestrator/README.md`'s Logging integration section.
