// End-to-end smoke test of the browser OAuth flow and page hardening
// (audit S-06, S-07, S-08). Starts src/http/index.js on a scratch DATA_DIR
// and drives it over HTTP. Run inside the app image, with no network:
//
//   docker run --rm --network none -v "$PWD/src:/app/src:ro" -v "$PWD/test:/app/test:ro" \
//     -w /app --entrypoint node <image> test/http-oauth.smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(path.join(tmpdir(), "anylist-smoke-"));
writeFileSync(path.join(dataDir, "allowed-emails.txt"), "owner@example.com\n");
const PORT = 3999;
const env = {
  ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
  SESSION_SECRET: randomBytes(16).toString("hex"), SERVER_SECRET_KEY: randomBytes(32).toString("hex"),
};
const server = spawn("node", ["src/http/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const BASE = `http://127.0.0.1:${PORT}`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let cookie = "";
async function req(method, p, { form, json, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (form) { h["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  if (json) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); process.exitCode = 1; }
}

try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  await check("login page sends a CSP and nonces its inline scripts", async () => {
    const res = await req("GET", "/login");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    for (const tag of html.match(/<script[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    assert.ok(!/ on[a-z]+=/i.test(html), "inline event handler present");
  });

  await check("registration refuses a redirect off the allowed hosts", async () => {
    for (const uri of ["https://evil.example/cb", "http://claude.ai/cb", "javascript:alert(1)", "https://claude.ai.evil.example/cb"]) {
      const res = await req("POST", "/oauth/register", { json: { redirect_uris: [uri] } });
      assert.equal(res.status, 400, uri);
    }
  });

  let clientId;
  await check("registration accepts the claude.ai callback", async () => {
    const res = await req("POST", "/oauth/register", { json: { redirect_uris: [CALLBACK] } });
    assert.equal(res.status, 201);
    clientId = (await res.json()).client_id;
  });

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authz = (extra) => `/oauth/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s1", ...extra,
  })}`;

  await check("authorize refuses unknown clients and other redirects", async () => {
    assert.equal((await req("GET", authz({ client_id: "not-registered" }))).status, 400);
    assert.equal((await req("GET", authz({ redirect_uri: "https://evil.example/cb" }))).status, 400);
    const xss = await req("GET", authz({ client_id: "<script>alert(1)</script>" }));
    assert.equal(xss.status, 400);
    assert.ok(!(await xss.text()).includes("<script>"));
  });

  await check("authorize with the registered redirect goes to login", async () => {
    const res = await req("GET", authz({}));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
  });

  await check("account creation without AnyList credentials goes to setup", async () => {
    const res = await req("POST", "/auth/register", { form: { email: "owner@example.com", password: "correct horse battery" } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/setup");
  });

  // Stand in for /setup, which would log in to the real AnyList.
  process.env.DATA_DIR = dataDir;
  process.env.SERVER_SECRET_KEY = env.SERVER_SECRET_KEY;
  const db = await import("../src/http/db.js");
  const user = db.getUserByEmail("owner@example.com");
  db.upsertAnyListCredentials(user.id, { username: "a@example.com", password: "x", defaultListName: null });

  await check("login with an OAuth flow pending asks for consent, never issues a code directly", async () => {
    const res = await req("POST", "/auth/login", { form: { email: "owner@example.com", password: "correct horse battery" } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/consent");
  });

  await check("an existing session re-authorizing still lands on consent", async () => {
    const res = await req("GET", authz({ state: "s2" }));
    assert.equal(res.headers.get("location"), "/oauth/consent");
  });

  await check("consent page names where the code will go", async () => {
    const html = await (await req("GET", "/oauth/consent")).text();
    assert.ok(html.includes("<strong>claude.ai</strong>"));
  });

  let code;
  await check("approving redirects to the registered callback with a code", async () => {
    const res = await req("POST", "/oauth/consent", { form: { approve: "yes" } });
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get("state"), "s2");
    code = loc.searchParams.get("code");
    assert.ok(code);
  });

  await check("the code can't be exchanged for another redirect", async () => {
    const res = await req("POST", "/oauth/token", { json: {
      grant_type: "authorization_code", code, redirect_uri: "https://evil.example/cb", code_verifier: verifier, client_id: clientId,
    } });
    assert.equal(res.status, 400);
  });

  await check("a fresh code exchanges with the right redirect and verifier", async () => {
    await req("GET", authz({ state: "s3" }));
    const loc = new URL((await req("POST", "/oauth/consent", { form: { approve: "yes" } })).headers.get("location"));
    const res = await req("POST", "/oauth/token", { json: {
      grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: CALLBACK, code_verifier: verifier, client_id: clientId,
    } });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).access_token);
  });

  await check("the session cookie is SameSite=Lax", async () => {
    cookie = "";
    const res = await req("GET", authz({ state: "s4" }));
    assert.match(res.headers.get("set-cookie") || "", /SameSite=Lax/i);
  });

  await check("the browser routes aren't served under /mcp (Access only guards the root)", async () => {
    assert.equal((await req("POST", "/mcp/auth/login", { form: { email: "owner@example.com", password: "x" } })).status, 404);
    assert.equal((await req("POST", "/MCP/AUTH/LOGIN", { form: { email: "owner@example.com", password: "x" } })).status, 404);
    assert.equal((await req("GET", "/mcp/oauth/consent")).status, 404);
    const res = await req("GET", "/mcp/oauth/authorize?client_id=c&state=s");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/authorize?client_id=c&state=s");
    assert.equal((await req("GET", "/mcp/.well-known/oauth-authorization-server")).status, 200);
  });

  await check("login attempts are rate limited per IP", async () => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await req("POST", "/auth/login", { form: { email: "owner@example.com", password: "wrong" } })).status);
    }
    assert.ok(statuses.includes(429), statuses.join(","));
  });
} finally {
  server.kill();
  if (process.exitCode) console.log("--- server log ---\n" + serverLog.slice(-3000));
  console.log(`${passed} passed`);
}
