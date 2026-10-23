import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp-server.mjs";
import { handleUtterance } from "./orchestrator.mjs";
import { store } from "./store.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0"; // bind to 0.0.0.0 so Render can detect and route traffic
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT},http://0.0.0.0:${PORT}`).split(","));
const MCP_API_KEY = process.env.MCP_API_KEY || ""; // optional bearer auth for real deployments

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- MCP endpoint (Streamable HTTP, stateless) ------------------------------
function guard(req, res, next) {
  const origin = req.headers.origin;
  if (origin && process.env.ALLOWED_ORIGINS && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "origin not allowed" });
  if (MCP_API_KEY && req.headers.authorization !== `Bearer ${MCP_API_KEY}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/mcp", guard, async (req, res) => {
  // Stateless mode: a fresh server + transport per request, so any replica can answer any call.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
const methodNotAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// --- Simulated Alexa+ web app ------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const { text, conversationId = "demo" } = req.body || {};
  if (typeof text !== "string" || !text.trim() || text.length > 500) return res.status(400).json({ error: "text required (max 500 chars)" });
  try {
    const out = await handleUtterance({ text, conversationId, mcpUrl: `http://127.0.0.1:${PORT}/mcp` });
    res.json({ ...out, state: viewState() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ speech: "Sorry, I had trouble reaching Sentinel.", error: String(e.message || e) });
  }
});

function viewState() {
  const s = store.snapshot();
  return {
    score: store.score(), grade: store.grade(), guest: s.guestMode,
    devices: s.devices.map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, status: d.status, risk: store.riskOf(d.id) })),
    alerts: s.alerts.map((a) => ({ id: a.id, deviceId: a.deviceId, severity: a.severity, status: a.status, title: a.title })),
  };
}
app.get("/api/state", (_req, res) => res.json(viewState()));
app.post("/api/reset", (_req, res) => { store.reset(); res.json(viewState()); });
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public")));

app.listen(PORT, HOST, () => {
  console.log(`Sentinel running: web app http://${HOST}:${PORT}  |  MCP endpoint http://${HOST}:${PORT}/mcp`);
});
