// A database from before token hashing (user_version 0, raw tokens and codes)
// is hashed in place on first open, and the old tokens keep working.
//
//   docker run --rm --network none -v "$PWD/src:/app/src:ro" -v "$PWD/test:/app/test:ro" \
//     -w /app --entrypoint node <image> test/token-hash-migration.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const dir = mkdtempSync(path.join(tmpdir(), "anylist-mig-"));
const legacy = new Database(path.join(dir, "anylist-mcp.db"));
legacy.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE oauth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL, code_challenge TEXT, challenge_method TEXT, scope TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE oauth_tokens (access_token TEXT PRIMARY KEY, refresh_token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL, scope TEXT, expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  INSERT INTO users (id, email) VALUES ('u1', 'owner@example.com');
`);
const later = Math.floor(Date.now() / 1000) + 3600;
legacy.prepare("INSERT INTO oauth_tokens VALUES (?, ?, 'u1', 'c1', 'mcp', ?, ?, unixepoch())").run("rawaccess", "rawrefresh", later, later);
legacy.prepare("INSERT INTO oauth_codes VALUES (?, 'c1', 'u1', 'https://claude.ai/cb', 'x', 'S256', NULL, ?, unixepoch())").run("rawcode", later);
legacy.close();

process.env.DATA_DIR = dir;
const db = await import("../src/http/db.js");
const conn = db.getDb();
assert.equal(conn.pragma("user_version", { simple: true }), 1);
assert.equal(conn.prepare("SELECT count(*) n FROM oauth_tokens WHERE access_token = 'rawaccess' OR refresh_token = 'rawrefresh'").get().n, 0);
assert.equal(db.getTokenRecord("rawaccess").client_id, "c1");
assert.equal(db.getTokenByRefresh("rawrefresh").user_id, "u1");
assert.equal(db.consumeOAuthCode("rawcode").client_id, "c1");
assert.equal(db.consumeOAuthCode("rawcode"), null);
// Opening again doesn't hash twice.
conn.close();
const again = new Database(path.join(dir, "anylist-mcp.db"));
assert.equal(again.prepare("SELECT access_token FROM oauth_tokens").get().access_token, db.hashSecret("rawaccess"));
console.log("ok - legacy tokens and codes hashed in place and still valid");
