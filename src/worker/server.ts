/**
 * C-Mem Worker: Hono HTTP Server
 *
 * Security model (localhost-only service):
 *   - Binds ONLY to 127.0.0.1 (warns if overridden to 0.0.0.0)
 *   - Rejects all non-localhost remote addresses at middleware layer
 *   - CORS: only http://localhost:{port} and http://127.0.0.1:{port}
 *   - Request body: 100KB max
 *   - Rate limiting: 100 req/s per IP (token bucket)
 *   - Content-Type: application/json required for all POST/PUT routes
 *   - SSE: same localhost-only restriction
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { db, search, initDb } from "../storage/db.js";
import { sseManager, isLocalhost, generateClientId } from "./sse.js";
import { ObservationQueue } from "./queue.js";
import type { ObservationProcessor, QueueMessage } from "./queue.js";
import { ContextBuilder } from "./context-builder.js";
import { compressObservation } from "../sdk/compressor.js";
import { DEFAULT_CONFIG } from "../types.js";
import { ensureAuthToken, verifyBearer, TOKEN_PATH } from "../auth/token.js";
import type {
  SessionInitBody,
  ObservationBody,
  SummarizeBody,
  CompleteBody,
  BatchObservationsBody,
  QueueRecoverBody,
} from "../types.js";

// ───────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────

const PORT = parseInt(
  process.env["C_MEM_WORKER_PORT"] ?? String(DEFAULT_CONFIG.workerPort),
  10
);
const HOST = (() => {
  const h = process.env["C_MEM_WORKER_HOST"] ?? DEFAULT_CONFIG.workerHost;
  if (h === "0.0.0.0") {
    console.warn(
      "[server] WARNING: C_MEM_WORKER_HOST is set to 0.0.0.0. " +
        "This exposes the worker to the entire network with NO authentication. " +
        "This configuration is not recommended. Proceeding with 0.0.0.0."
    );
  }
  return h;
})();
const DATA_DIR = process.env["C_MEM_DATA_DIR"] ?? DEFAULT_CONFIG.dataDir;
const MAX_BODY_BYTES = DEFAULT_CONFIG.maxBodyBytes;
const RATE_LIMIT_RPS = DEFAULT_CONFIG.rateLimit;

const START_TIME = Date.now();

// Generate (or load existing) auth token at startup
const AUTH_TOKEN = ensureAuthToken();

// ───────────────────────────────────────────────────────
// Module-level singletons
// ───────────────────────────────────────────────────────

const queue = new ObservationQueue(db);
const contextBuilder = new ContextBuilder(db, {
  maxTokens: 4_000,
  maxObservations: 50,
  maxSessions: 10,
});

// ───────────────────────────────────────────────────────
// Rate Limiter (token bucket per IP)
// ───────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const rateBuckets = new Map<string, TokenBucket>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_RPS, lastRefill: now };
    rateBuckets.set(ip, bucket);
  }

  // Refill based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1_000; // seconds
  bucket.tokens = Math.min(
    RATE_LIMIT_RPS,
    bucket.tokens + elapsed * RATE_LIMIT_RPS
  );
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return true; // rate limited
  }

  bucket.tokens -= 1;
  return false;
}

// Periodically clean up old rate buckets to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.lastRefill < cutoff) rateBuckets.delete(ip);
  }
}, 60_000);

// ───────────────────────────────────────────────────────
// Hono App
// ───────────────────────────────────────────────────────

const app = new Hono();

// ─────────────────────────────────────
// Global Middleware
// ─────────────────────────────────────

/** CORS: only allow localhost origins (no wildcard) */
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null; // block requests without Origin (non-browser)
      if (
        origin === `http://localhost:${PORT}` ||
        origin === `http://127.0.0.1:${PORT}`
      ) {
        return origin;
      }
      return null; // reject everything else
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: false,
  })
);

/** Localhost-only guard — reject all non-127.0.0.1 / ::1 requests */
app.use("*", async (c, next) => {
  const remote =
    c.req.raw.headers.get("x-forwarded-for") ??
    // Bun exposes this on the request in some versions
    (c.req.raw as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ??
    "127.0.0.1"; // default: assume localhost (we rely on port binding)

  if (HOST !== "0.0.0.0" && !isLocalhost(remote)) {
    console.warn(`[server] Rejected non-localhost request from: ${remote}`);
    return c.json({ error: "Forbidden: localhost only" }, 403);
  }

  // Rate limiting
  if (isRateLimited(remote)) {
    return c.json({ error: "Too Many Requests" }, 429);
  }

  await next();
});

/** Request body size limit — reject > 100KB */
app.use("*", async (c, next) => {
  const contentLength = c.req.raw.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return c.json({ error: "Request body too large (max 100KB)" }, 413);
  }
  await next();
});

/** Bearer token auth — applies to all routes except GET /health */
app.use("*", async (c, next) => {
  // Health check is always accessible (for monitoring/hook bootstrap)
  if (c.req.path === "/health") return next();
  // Verify bearer token
  if (!verifyBearer(c.req.header("Authorization"), AUTH_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

/** JSON Content-Type enforcement for POST routes */
app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return c.json(
        { error: "Content-Type must be application/json" },
        415
      );
    }
  }
  await next();
});

app.use("/sessions/*", async (c, next) => {
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return c.json(
        { error: "Content-Type must be application/json" },
        415
      );
    }
  }
  await next();
});

// ─────────────────────────────────────
// P0: GET /health
// ─────────────────────────────────────

app.get("/health", (c) => {
  const uptime = (Date.now() - START_TIME) / 1_000;
  const queueStatus = queue.getStatus();
  return c.json({
    status: "ok",
    uptime,
    port: PORT,
    tokenPath: TOKEN_PATH,
    queue: {
      pending: queueStatus.pending,
      processing: queueStatus.processing,
      failed: queueStatus.failed,
      stuck: queueStatus.stuck,
    },
  });
});

// ─────────────────────────────────────
// P0: GET /api/context
// ─────────────────────────────────────

app.get("/api/context", (c) => {
  const project = c.req.query("project");
  if (!project) {
    return c.json({ error: "project query param is required" }, 400);
  }

  const result = contextBuilder.build(project);
  return c.text(result.markdown, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "X-Token-Estimate": String(result.tokenEstimate),
    "X-Observation-Count": String(result.observationCount),
    "X-Summary-Count": String(result.summaryCount),
    "X-Truncated": String(result.truncated),
  });
});

// ─────────────────────────────────────
// P0: POST /api/observations
// ─────────────────────────────────────

app.post("/api/observations", async (c) => {
  let body: ObservationBody;
  try {
    body = await parseJsonBody<ObservationBody>(c.req.raw, MAX_BODY_BYTES);
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }

  if (!body.tool_name || typeof body.tool_name !== "string") {
    return c.json({ error: "tool_name is required" }, 400);
  }
  // Accept both tool_response (canonical) and tool_result (legacy alias)
  const toolResponseText = body.tool_response ?? body.tool_result;
  if (toolResponseText === undefined || toolResponseText === null) {
    return c.json({ error: "tool_response is required" }, 400);
  }

  // Derive session_id from correlation_id or generate one
  // For standalone observation POSTs, we need a session_id in the body
  // Accept it under session_id key as well
  const extBody = body as ObservationBody & { session_id?: string; project?: string };
  const sessionId = extBody.session_id ?? body.correlation_id ?? "default";
  const project = extBody.project ?? "";

  const queueId = queue.enqueue(
    sessionId,
    body.tool_name,
    body.tool_input,
    String(toolResponseText),
    project
  );

  return c.json({ success: true, queued: true, queue_id: queueId }, 202);
});

// ─────────────────────────────────────
// P0: POST /api/sessions/init
// ─────────────────────────────────────

app.post("/api/sessions/init", async (c) => {
  let body: SessionInitBody & { session_id?: string };
  try {
    body = await parseJsonBody<SessionInitBody & { session_id?: string }>(
      c.req.raw,
      MAX_BODY_BYTES
    );
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }

  if (!body.project || typeof body.project !== "string") {
    return c.json({ error: "project is required" }, 400);
  }
  if (!body.userPrompt || typeof body.userPrompt !== "string") {
    return c.json({ error: "userPrompt is required" }, 400);
  }
  if (!body.session_id || typeof body.session_id !== "string") {
    return c.json({ error: "session_id is required" }, 400);
  }

  const dbId = db.createSession(
    body.session_id,
    body.project,
    body.userPrompt
  );

  return c.json({ success: true, session_id: body.session_id, db_id: dbId });
});

// ─────────────────────────────────────
// P0: POST /api/sessions/summarize
// ─────────────────────────────────────

app.post("/api/sessions/summarize", async (c) => {
  let body: SummarizeBody & { session_id?: string };
  try {
    body = await parseJsonBody<SummarizeBody & { session_id?: string }>(
      c.req.raw,
      MAX_BODY_BYTES
    );
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }

  if (!body.session_id) {
    return c.json({ error: "session_id is required" }, 400);
  }

  const session = db.getSession(body.session_id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Summarization is handled by Builder A's compression agent.
  // We emit an event that the compression agent listens to.
  sseManager.emit("summarize-requested", {
    sessionId: body.session_id,
    lastUserMessage: body.last_user_message,
    lastAssistantMessage: body.last_assistant_message,
  });

  return c.json({ success: true, summary_queued: true });
});

// ─────────────────────────────────────
// P0: POST /api/sessions/complete
// ─────────────────────────────────────

app.post("/api/sessions/complete", async (c) => {
  let body: CompleteBody & { session_id?: string };
  try {
    body = await parseJsonBody<CompleteBody & { session_id?: string }>(
      c.req.raw,
      MAX_BODY_BYTES
    );
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }

  if (!body.session_id) {
    return c.json({ error: "session_id is required" }, 400);
  }

  db.updateSessionStatus(body.session_id, "completed");

  return c.json({ success: true, completed: true });
});

// ─────────────────────────────────────
// P0: GET /api/search
// ─────────────────────────────────────

app.get("/api/search", (c) => {
  const q = c.req.query("q") ?? c.req.query("query") ?? "";
  if (!q) {
    return c.json({ error: "q query param is required" }, 400);
  }

  const project = c.req.query("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

  const results = search.searchObservations(q, { project, limit, offset });

  return c.json({
    results,
    total: results.length,
    hasMore: results.length === limit,
  });
});

// ─────────────────────────────────────
// P0: GET /api/observations
// ─────────────────────────────────────

app.get("/api/observations", (c) => {
  const project = c.req.query("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

  const { observations, total } = db.getObservations(project, limit, offset);
  return c.json({
    observations,
    total,
    hasMore: offset + observations.length < total,
  });
});

// ─────────────────────────────────────
// P0: GET /api/sessions
// ─────────────────────────────────────

app.get("/api/sessions", (c) => {
  const project = c.req.query("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

  const sessions = db.listSessions(project, limit, offset);
  return c.json({ sessions });
});

// ─────────────────────────────────────
// P0: GET /api/stats
// ─────────────────────────────────────

app.get("/api/stats", (c) => {
  const project = c.req.query("project");
  const stats = db.getStats(project);
  return c.json({ stats, project: project ?? "all" });
});

// ─────────────────────────────────────
// P0: GET /stream — SSE (localhost only)
// ─────────────────────────────────────

app.get("/stream", (c) => {
  // Extra localhost check for SSE
  const remote =
    (c.req.raw as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ??
    "127.0.0.1";

  if (!isLocalhost(remote)) {
    return c.json({ error: "SSE stream: localhost only" }, 403);
  }

  // Auth check for SSE (middleware already ran, but explicit for clarity)
  if (!verifyBearer(c.req.header("Authorization"), AUTH_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return streamSSE(c, async (stream) => {
    const clientId = generateClientId();

    const client = {
      id: clientId,
      write: (data: string) => stream.write(data),
      close: () => stream.close(),
      remoteAddress: remote,
    };

    const accepted = sseManager.addClient(client);
    if (!accepted) {
      await stream.close();
      return;
    }

    // Keep the connection open until client disconnects
    // streamSSE auto-closes when the generator returns
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        sseManager.removeClient(clientId);
        resolve();
      });
    });
  });
});

// ─────────────────────────────────────
// P1: GET /api/observation/:id
// ─────────────────────────────────────

app.get("/api/observation/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const obs = db.getObservation(id);
  if (!obs) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(obs);
});

// ─────────────────────────────────────
// P1: POST /api/observations/batch
// ─────────────────────────────────────

app.post("/api/observations/batch", async (c) => {
  let body: BatchObservationsBody;
  try {
    body = await parseJsonBody<BatchObservationsBody>(c.req.raw, MAX_BODY_BYTES);
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }

  if (!Array.isArray(body.ids)) {
    return c.json({ error: "ids must be an array" }, 400);
  }

  const ids = body.ids
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 200); // cap at 200

  const observations = db.getObservationsByIds(ids);
  return c.json({ observations });
});

// ─────────────────────────────────────
// P1: GET /api/queue
// ─────────────────────────────────────

app.get("/api/queue", (c) => {
  const status = queue.getStatus();
  return c.json(status);
});

// ─────────────────────────────────────
// P1: POST /api/queue/recover
// ─────────────────────────────────────

app.post("/api/queue/recover", async (c) => {
  let body: QueueRecoverBody = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text) as QueueRecoverBody;
  } catch {}

  const recovered = queue.recoverStuck();
  return c.json({ success: true, recovered });
});

// ─────────────────────────────────────
// 404 fallthrough
// ─────────────────────────────────────

app.all("*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

// ───────────────────────────────────────────────────────
// Startup
// ───────────────────────────────────────────────────────

initDb(DATA_DIR);

// ─────────────────────────────────────────────────────────────────────────────
// Step 4a: Wire Builder A's compressor to the queue processor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real queue processor — calls Builder A's LLM compressor and stores
 * the resulting observation via Builder C's storage layer.
 *
 * Graceful degradation: if ANTHROPIC_API_KEY is absent or compression fails,
 * stores a passthrough observation so the lifecycle still completes.
 */
const compressionProcessor: ObservationProcessor = async (
  _queueId: number,
  msg: QueueMessage
): Promise<number> => {
  const session = db.getSession(msg.sessionId);
  const project = session?.project ?? "unknown";
  const promptNumber = session?.prompt_counter ?? 0;

  let kind = "other";
  let title = `${msg.toolName} — passthrough`;
  let narrative = msg.toolResult.slice(0, 2_000);
  let tags: string[] = [msg.toolName];
  let facts: string[] = [];
  let files_read: string[] = [];
  let files_modified: string[] = [];

  // Try LLM compression only if API key is available
  if (process.env["ANTHROPIC_API_KEY"]) {
    try {
      let toolInput: unknown;
      try {
        toolInput = JSON.parse(msg.toolInput);
      } catch {
        toolInput = msg.toolInput;
      }

      const compressed = await compressObservation({
        tool_name: msg.toolName,
        tool_input: toolInput,
        tool_response: msg.toolResult,
        project,
        prompt_number: promptNumber,
        user_goal: "",
      });

      kind = compressed.type ?? "other";
      title = compressed.title;
      narrative = compressed.narrative;
      tags = compressed.tags;
      facts = compressed.facts;
      files_read = compressed.files_read;
      files_modified = compressed.files_modified;
    } catch (err) {
      console.warn(
        `[queue] LLM compression failed for item ${_queueId}, using passthrough: ${err}`
      );
    }
  }

  const obsId = db.createObservation({
    session_id: msg.sessionId,
    project,
    prompt_number: promptNumber,
    tool_name: msg.toolName,
    type: kind,
    title,
    narrative,
    tags: JSON.stringify(tags),
    facts: JSON.stringify(facts),
    files_read: JSON.stringify(files_read),
    files_modified: JSON.stringify(files_modified),
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
  });

  console.log(
    `[queue] Processed item ${_queueId} → observation ${obsId} (session: ${msg.sessionId})`
  );
  return obsId;
};

queue.start(compressionProcessor);

// Graceful shutdown
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown(): void {
  console.log("[server] Shutting down...");
  queue.stop();
  sseManager.stop();
  process.exit(0);
}

// Start server
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});

console.log(`[server] C-Mem worker listening on http://${HOST}:${PORT}`);
console.log(`[server] Data directory: ${DATA_DIR}`);

export { app, queue, contextBuilder };
export default server;

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

/** Parse JSON body with size enforcement */
async function parseJsonBody<T>(
  req: Request,
  maxBytes: number
): Promise<T> {
  // Read as text first to enforce size
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error(`Request body too large (max ${maxBytes} bytes)`);
  }
  return JSON.parse(text) as T;
}
