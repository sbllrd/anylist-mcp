import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { getDb, loadAllowedEmails, deleteExpiredTokens } from "./db.js";
import { getOrCreateSession } from "./session-manager.js";
import oauthRouter, { requireBearerToken } from "./auth/oauth.js";
import onboardingRouter from "./onboarding.js";
import { registerAllTools } from "../tools/index.js";
import { parseClientScopes, profileForClient, scopeServer } from "../tools/scopes.js";
import { isGoogleEnabled } from "./auth/providers/google.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Startup validation ────────────────────────────────────────────────────────

function validateEnv() {
  const required = ["SERVER_SECRET_KEY", "SESSION_SECRET"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (process.env.SERVER_SECRET_KEY.length !== 64) {
    console.error("SERVER_SECRET_KEY must be a 64-character hex string (32 bytes).");
    process.exit(1);
  }
  if (!process.env.BASE_URL) {
    console.warn("BASE_URL not set — will derive from incoming request Host header (fine for dev/tunnel use)");
  }
  loadAllowedEmails(); // Will throw + exit if file missing
}

// ── Express app setup ─────────────────────────────────────────────────────────

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Trust the first proxy (Cloudflare Tunnel) so req.secure reflects the
// original HTTPS connection. This also makes session cookies work correctly
// when accessed through the tunnel.
app.set("trust proxy", 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // secure=true only when the request actually arrived over HTTPS (via proxy).
    // When testing locally over plain HTTP this will be false, allowing cookies to work.
    secure: "auto",
    // Lax: sent on the top-level GET from the client to /oauth/authorize, not
    // on a cross-site POST, so another site can't auto-submit the consent form.
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // Structure only: the JSON-RPC method and tool name, never the arguments
    // (list, item and recipe content must not reach the log).
    const rpcMethod = req.body?.method;
    const rpcName = req.body?.params?.name;
    const body = req.method === "POST" && (req.path === "/sse" || req.path === "/mcp") && rpcMethod
      ? " rpc:" + JSON.stringify(rpcName ? `${rpcMethod} ${rpcName}` : rpcMethod).slice(0, 100)
      : "";
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms) session:${req.session?.id?.slice(0, 8) ?? "none"} user:${req.session?.userId ?? "-"}${body}`);
  });
  next();
});

function escapeHtml(value) {
  return value.replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]);
}

// Security headers on every response (audit S-07). Scripts need this
// response's nonce; Google sign-in is the only outside script and frame.
// No form-action: the consent form's redirect back to the client
// (claude.ai) would be blocked by it in Chromium.
app.use((req, res, next) => {
  const nonce = randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://accounts.google.com/gsi/client`,
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "frame-src https://accounts.google.com/gsi/",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "img-src 'self' data:",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// View engine (simple HTML template rendering via res.render)
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "html");
app.engine("html", (filePath, options, callback) => {
  try {
    let content = readFileSync(filePath, "utf8");
    for (const [k, v] of Object.entries(options)) {
      // Section toggle: <!-- if:key -->...<!-- endif:key -->
      // Truthy = boolean true, non-empty string, non-zero number
      const startTag = `<!-- if:${k} -->`;
      const endTag = `<!-- endif:${k} -->`;
      if (content.includes(startTag)) {
        const truthy = v !== null && v !== undefined && v !== false && v !== "" && v !== 0;
        if (!truthy) {
          const re = new RegExp(startTag + "[\\s\\S]*?" + endTag, "g");
          content = content.replace(re, "");
        } else {
          content = content.replaceAll(startTag, "").replaceAll(endTag, "");
        }
      }
      // Value replacement: {{key}}, always HTML-escaped (audit S-07: the
      // consent page echoed client_id from the query string unescaped).
      if (typeof v === "string" || typeof v === "number") {
        content = content.replaceAll(`{{${k}}}`, escapeHtml(String(v)));
      } else if (v === null || v === undefined) {
        content = content.replaceAll(`{{${k}}}`, "");
      }
    }
    // Inline scripts run only with this response's CSP nonce.
    if (options.cspNonce) content = content.replaceAll("<script", `<script nonce="${options.cspNonce}"`);
    callback(null, content);
  } catch (err) {
    callback(err);
  }
});

// ── Login page ────────────────────────────────────────────────────────────────

app.get("/login", (_req, res) => {
  res.render("login", {
    error: "",
    googleEnabled: isGoogleEnabled(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ── OAuth + onboarding routes ─────────────────────────────────────────────────

app.use(oauthRouter);
// Under /mcp only the machine endpoints (discovery, registration, token) are
// served. The browser pages live at the root, where Cloudflare Access
// requires an email code first; serving them here too bypassed Access
// (POST /mcp/auth/login reached the password check). Authorize redirects to
// the root copy; login and consent aren't served here at all.
app.use("/mcp", (req, res, next) => {
  const p = req.path.toLowerCase().replace(/\/+$/, "");
  if (p === "/oauth/authorize" || p === "/authorize") {
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    return res.redirect(302, "/oauth/authorize" + query);
  }
  if (p.startsWith("/auth/") || p === "/oauth/consent") return res.status(404).send("Not found");
  next();
});
app.use("/mcp", oauthRouter);
app.use(onboardingRouter);

// ── MCP Streamable HTTP endpoint ──────────────────────────────────────────────
//
// Per the MCP spec, we use stateful sessions: one McpServer + transport per
// session, keyed by the Mcp-Session-Id header. This is required for elicitation
// to work (the server needs to maintain request context across the session).

const mcpSessions = new Map(); // sessionId → { server, transport, clientId }

// client_id -> scope profile (see src/tools/scopes.js). Parsed once at
// startup so a typo'd profile name fails the boot, not a request.
const clientScopes = parseClientScopes(process.env.ANYLIST_CLIENT_SCOPES);

function createMcpServer(userId, clientId) {
  const mcpServer = new McpServer({ name: "anylist-mcp-server", version: "1.8.0" });
  const getClient = () => getOrCreateSession(userId);
  const profile = profileForClient(clientScopes, clientId);
  registerAllTools(scopeServer(mcpServer, profile, getClient), getClient);
  return mcpServer;
}

// A session is bound to the OAuth client that initialized it, so a scoped
// client can't reuse a full client's session (or the reverse).
function sessionBelongsTo(mcpSession, req) {
  return mcpSession.clientId === req.clientId;
}

// MCP endpoint — available at both / and /mcp.
// All specific routes above (/health, /login, /oauth/*, etc.) take precedence.
async function handleMcp(req, res) {
  try {
    const sessionId = req.headers["mcp-session-id"];
    // Initialize requests always create a new session — never route to an existing one.
    // This handles clients (e.g. HA) that send a second initialize on a stale session ID.
    const mcpSession = !isInitializeRequest(req.body) && sessionId
      ? mcpSessions.get(sessionId)
      : null;

    if (mcpSession && !sessionBelongsTo(mcpSession, req)) {
      return res.status(403).json({ error: "Session belongs to a different client." });
    }

    if (!mcpSession) {
      if (!isInitializeRequest(req.body)) {
        return res.status(404).json({ error: "Session not found. Send an initialize request first." });
      }

      // Create a new MCP session for this user
      const userId = req.userId;
      const clientId = req.clientId;
      const mcpServer = createMcpServer(userId, clientId);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (sid) => {
          mcpSessions.set(sid, { server: mcpServer, transport, clientId });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) mcpSessions.delete(sid);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    await mcpSession.transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

app.all("/", requireBearerToken, handleMcp);
app.all("/mcp", requireBearerToken, handleMcp);

// ── MCP SSE transport endpoints (for Home Assistant and other SSE-only clients) ─

function makeSseConnectHandler(postEndpoint) {
  return async function (req, res) {
    try {
      const transport = new SSEServerTransport(postEndpoint, res);
      const sessionId = transport.sessionId;
      const mcpServer = createMcpServer(req.userId, req.clientId);
      mcpSessions.set(sessionId, { server: mcpServer, transport, clientId: req.clientId });
      transport.onclose = () => { mcpSessions.delete(sessionId); };
      await mcpServer.connect(transport); // connect() calls transport.start() internally
    } catch (err) {
      console.error("SSE connect error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  };
}

async function handleSseMessage(req, res) {
  try {
    const mcpSession = req.query.sessionId ? mcpSessions.get(req.query.sessionId) : null;
    if (!mcpSession || !(mcpSession.transport instanceof SSEServerTransport)) {
      return res.status(404).json({ error: "SSE session not found." });
    }
    if (!sessionBelongsTo(mcpSession, req)) {
      return res.status(403).json({ error: "Session belongs to a different client." });
    }
    await mcpSession.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("SSE message error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
}

app.get("/sse",       requireBearerToken, makeSseConnectHandler("/messages"));
app.post("/sse",      requireBearerToken, handleMcp); // HA uses Streamable HTTP at this URL
app.post("/messages", requireBearerToken, handleSseMessage);

// ── Cleanup job ───────────────────────────────────────────────────────────────

setInterval(deleteExpiredTokens, 60 * 60 * 1000); // hourly

// ── Start server ──────────────────────────────────────────────────────────────

validateEnv();
getDb(); // Initialize DB (runs migrations)

app.listen(PORT, () => {
  console.log(`anylist-mcp HTTP server listening on port ${PORT}`);
  console.log(`Base URL: ${process.env.BASE_URL || "(derived from request host)"}`);
  console.log(`Google OAuth: ${isGoogleEnabled() ? "enabled" : "disabled (set GOOGLE_CLIENT_ID to enable)"}`);
});
