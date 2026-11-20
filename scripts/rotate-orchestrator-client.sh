#!/usr/bin/env bash
# Replace Gandalf's AnyList OAuth client (orchestrator-gandalf) without
# printing any secret:
#   1. create a new confidential client inside the container
#   2. store its client_id and client_secret in the login Keychain
#   3. mint a 180-day client_credentials token on the local port
#   4. set it as ZeroClaw's mcp.servers.anylist Authorization header
#   5. check the new token works, then delete the old client and its tokens
#   6. restart the ZeroClaw daemon
#
# Usage (run it yourself in Terminal, not through an agent):
#   services/mcp-anylist/scripts/rotate-orchestrator-client.sh <your-anylist-email> <old-client-id>
set -euo pipefail

EMAIL="${1:?usage: $0 <email> <old-client-id>}"
OLD_ID="${2:?usage: $0 <email> <old-client-id>}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER=mcp-anylist-anylist-mcp-1
LOCAL=http://127.0.0.1:3000
ZC=("$REPO/orchestrator/zeroclaw/target/release/zeroclaw" --config-dir "$REPO/orchestrator/state")
KEYCHAIN_SERVICE=samwise-anylist-orchestrator-gandalf

out="$(docker exec -w /app "$CONTAINER" node scripts/create-client.js "$EMAIL" orchestrator-gandalf)"
new_id="$(printf '%s\n' "$out" | awk '/client_id:/ {print $2}')"
new_secret="$(printf '%s\n' "$out" | awk '/client_secret:/ {print $2}')"
unset out
[[ -n "$new_id" && -n "$new_secret" ]] || { echo "create-client.js gave no credentials" >&2; exit 1; }
echo "New client: $new_id"

security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$new_id" -w "$new_secret"
echo "client_id and client_secret saved in the login Keychain as '$KEYCHAIN_SERVICE'"

token="$(curl -sf -X POST "$LOCAL/oauth/token" -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$new_id\",\"client_secret\":\"$new_secret\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')"
unset new_secret
[[ -n "$token" ]] || { echo "no access token returned" >&2; exit 1; }

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL/mcp" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rotate-check","version":"1"}}}')"
[[ "$code" == 200 ]] || { echo "new token failed the MCP check (HTTP $code); old client left in place" >&2; exit 1; }
echo "New token works (MCP initialize: HTTP 200)"

"${ZC[@]}" config set mcp.servers.anylist.headers.Authorization "Bearer $token" --no-interactive >/dev/null
unset token
echo "ZeroClaw header updated"

docker exec -i -w /app "$CONTAINER" node - "$OLD_ID" <<'JS'
const Database = require("better-sqlite3");
const id = process.argv[2];
const db = new Database("/data/anylist-mcp.db");
const t = db.prepare("DELETE FROM oauth_tokens WHERE client_id = ?").run(id).changes;
const c = db.prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(id).changes;
console.log(`Old client ${id}: removed ${c} client row(s), ${t} token(s)`);
JS

launchctl kickstart -k "gui/$(id -u)/com.zeroclaw.daemon"
echo "ZeroClaw restarted. Done."
