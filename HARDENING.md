# Samwise notes: hardening, audit, and deployment (Pippin)

This file is ours, not upstream's — kept separate from `README.md` (upstream's own, vendored) specifically so `git fetch upstream` never conflicts with our notes. See "Upstream source" below for how this directory relates to the actual `bobby060/anylist-mcp` project.

## Upstream source

- **Origin**: [`bobby060/anylist-mcp`](https://github.com/bobby060/anylist-mcp), vendored as a git submodule with its own nested submodule (`anylist-js/`) — see root `.gitmodules`. Full upstream git history is present in this directory.
- **Used with its full tool set** (lists, recipes, meal planning, shopping/retailer send) for the initial build — not scoped down. See `docs/PROJECT_PLAN.md` for why (Pippin/AnyList stays the primary system for this domain; the custom Obsidian-based replacement is Phase 2, deferred).
- **Working approach**: hardening work happens as commits directly on top of upstream's own history in this directory (not a separate clean copy) — `git log --oneline` here shows both upstream's commits and ours.
- **Pulling upstream updates**: our own commits sit on top of a specific pinned commit, so a plain `git submodule update --remote` would overwrite them by resetting to upstream's branch tip. Instead: `cd services/mcp-anylist && git fetch origin && git rebase origin/main` (rebase our commits onto the new upstream tip, resolving conflicts if any — also re-run `git submodule update --init` afterward in case `anylist-js/`'s pinned commit changed), then from the repo root `git add services/mcp-anylist && git commit` to record the new pinned commit. Re-verify the hardening below after any upstream update — a rebase or upstream change can silently affect it (e.g. the Dockerfile regaining a `USER` directive that conflicts with ours, or losing it again).
- **Current pinned commit**: see `git submodule status` from the repo root, or `git -C services/mcp-anylist log -1`.

## Already has, out of the box

- HTTP mode via Docker Compose (`--profile cloudflare-temp` for a quick disposable tunnel)
- App-level auth via `allowed-emails.txt` (gates who can *register*; see upstream's OAuth model — `/mcp` itself is gated by a bearer token issued through that registration/login flow, not by the allowlist directly)
- Its own `.env.http.example` — copy and fill in real values, never commit

## Status

Live on a named Cloudflare Tunnel (2026-09-14) — `anylist.bllrd.co`, provisioned via `infra/cloudflare/terraform/` (`module "anylist"`), running `--profile cloudflare-named`. Re-verified end-to-end first on the quick tunnel (Docker build + a live Claude custom connector, real AnyList account, a real `shopping` tool call succeeded from a claude.ai chat), then moved to the named tunnel.

## Hardening steps for the real deployment (beyond the quick-tunnel test setup)

- [x] **Non-root container user** — fixed: `Dockerfile` had no `USER` directive (ran as root). Added `chown -R node:node` + `USER node` before `CMD`, using the unprivileged user the `node:22-alpine` base image already ships. Verified via `docker compose exec anylist-mcp whoami` → `node`.
- [x] `.env` / `config/allowed-emails.txt` git-ignored — confirmed (root `.gitignore` covers both patterns; also has its own `.gitignore` upstream).
- [x] Swap the quick/temporary Cloudflare tunnel for a **named tunnel** on a real subdomain — done: `anylist.bllrd.co`, via `infra/cloudflare/terraform/` (`module "anylist"`). DNS delegated to Cloudflare at the registrar; DNSSEC enabled.
- [x] ~~Add Cloudflare Access with a Service Token requirement in front of it~~ — **tried and reverted**: a service-token-only Access policy on `/setup`/`/login` returns a dead-end 403 for any browser (no fallback login for a human — service tokens are machine-to-machine only). Confirmed live, then removed (`access_protected_paths = []` in `main.tf`). AnyList runs with **no Cloudflare Access layer** — its own `allowed-emails.txt` + password auth gates registration, and `/mcp` is separately protected by its own OAuth bearer token. See `infra/cloudflare/terraform/modules/mcp-tunnel/variables.tf` for the corrected module semantics this bug produced.
- [ ] Rotate `SERVER_SECRET_KEY` / `SESSION_SECRET` from whatever was used in early testing — regenerate both with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` before any real/production deployment. **Rotating `SERVER_SECRET_KEY` invalidates every already-stored encrypted AnyList credential** (it's the AES-256-GCM key protecting them at rest) — anyone registered will need to redo `/setup` after a rotation.
- [ ] `chmod 600` on `.env`, confirm it's git-ignored (it is, per root `.gitignore`)
- [ ] Consider a dedicated AnyList account/password rather than reuse, given it sits in plaintext on the host — **deliberately deferred**: using the real/existing household account for now, since the whole point is acting on real lists.

## Testable now, no hardware needed

Fully testable via Docker on any dev machine — this doesn't require the Mac Mini at all except for the final always-on deployment.
