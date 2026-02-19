/**
 * Open-Mem Database Access Layer
 *
 * Singleton SQLite connection via bun:sqlite.
 * All reads and writes go through typed methods here.
 * ALL queries use parameterized form (? placeholders) — never string interpolation.
 *
 * Security requirements applied (from 00-security-audit.md):
 *  - SQL-01: Parameterized queries everywhere
 *  - SQL-03: DB file created with 0600 permissions
 *  - DB-03: WAL mode, foreign keys enabled
 */

import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { runMigrations } from './migrations.ts';
import { scrubSecrets, scrubJson } from './secrets.ts';
import { SearchService } from './search.ts';
import { readAuthToken } from '../auth/token.ts';
import type {
  Session,
  SessionStatus,
  Observation,
  UserPrompt,
  Summary,
  QueueMessage,
  QueueMessageType,
  IndexResult,
  ProjectStats,
} from './types.ts';
// Builder-B shared types (aliased to avoid name collisions with storage/types.ts)
import type {
  ISessionStore,
  Session as BBSession,
  Observation as BBObservation,
  SessionSummary,
  UserPrompt as BBUserPrompt,
  QueueItem,
  QueueStatus as BBQueueStatus,
} from '../types.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const OPEN_MEM_DIR = join(homedir(), '.open-mem');
const DB_PATH = join(OPEN_MEM_DIR, 'open-mem.db');

/** Max payload size for queue messages (100 KB) */
const MAX_PAYLOAD_BYTES = 100 * 1024;

// ─── HMAC Helpers (INJ-04) ────────────────────────────────────────────────────

/**
 * The HMAC signing key — derived from the auth token for consistency.
 * Falls back to a stable build-time constant if token not yet created.
 */
function getHmacKey(): string {
  return readAuthToken() ?? 'c-mem-default-hmac-key-v1';
}

/**
 * Sign observation content using HMAC-SHA256.
 * Signs `compressed + "\n" + (narrative ?? "")`.
 */
function signObservation(compressed: string, narrative: string | null): string {
  return createHmac('sha256', getHmacKey())
    .update(compressed + '\n' + (narrative ?? ''))
    .digest('hex');
}

/**
 * Verify observation content integrity.
 * Returns true if the stored HMAC matches the recomputed one.
 * Uses timing-safe comparison.
 */
function verifyObservationHmac(
  compressed: string,
  narrative: string | null,
  storedHmac: string | null
): boolean {
  if (!storedHmac) return true; // graceful degradation for pre-INJ-04 rows
  const expected = signObservation(compressed, narrative);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(storedHmac));
  } catch {
    return false;
  }
}

// ─── Database Interface ───────────────────────────────────────────────────────

export interface DbInterface {
  // Sessions
  createSession(claudeSessionId: string, project: string, firstPrompt?: string): number;
  getSession(claudeSessionId: string): Session | null;
  updateSessionStatus(id: number, status: SessionStatus): void;
  incrementPromptCounter(id: number): number;

  // Observations
  insertObservation(obs: Omit<Observation, 'id' | 'created_at'>): number;
  getObservations(project: string, limit: number, offset: number): Observation[];
  getObservation(id: number): Observation | null;
  getRecentObservations(project: string, limit: number): Observation[];

  // User prompts
  insertUserPrompt(sessionId: number, promptNumber: number, prompt: string): void;

  // Summaries
  insertSummary(summary: Omit<Summary, 'id' | 'created_at'>): number;
  getRecentSummaries(project: string, limit: number): Summary[];

  // Queue
  enqueue(sessionId: number, type: QueueMessageType, payload: object): number;
  dequeue(limit: number): QueueMessage[];
  markProcessing(id: number): void;
  markProcessed(id: number): void;
  markFailed(id: number, error: string): void;
  getStuck(thresholdSeconds: number): QueueMessage[];
  getPending(): QueueMessage[];

  // Search (FTS5)
  searchFTS(query: string, project?: string, limit?: number): Observation[];

  // Stats
  getStats(): Record<string, ProjectStats>;

  // Close connection
  close(): void;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: CMemDb | null = null;

/**
 * Returns the singleton database instance, creating it on first call.
 * The database file is created at ~/.open-mem/open-mem.db with 0600 permissions.
 */
export function getDb(): DbInterface {
  if (!_db) {
    _db = new CMemDb(DB_PATH);
  }
  return _db;
}

/**
 * Reset the singleton — used in tests to get a fresh in-memory database.
 * @internal
 */
export function _resetDbForTesting(db?: Database): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  if (db) {
    _db = new CMemDb(db);
  }
}

// ─── Implementation ───────────────────────────────────────────────────────────

class CMemDb implements DbInterface {
  private readonly _db: Database;

  /**
   * Construct with either a path (production) or an existing Database (testing).
   */
  constructor(pathOrDb: string | Database) {
    if (typeof pathOrDb === 'string') {
      // Ensure the data directory exists with restricted permissions
      if (!existsSync(OPEN_MEM_DIR)) {
        mkdirSync(OPEN_MEM_DIR, { recursive: true, mode: 0o700 });
      }

      this._db = new Database(pathOrDb, { create: true });

      // Restrict file permissions to owner read/write only (SEC-03)
      try {
        chmodSync(pathOrDb, 0o600);
      } catch {
        // May fail if file was just created on some platforms; non-fatal
      }
    } else {
      // In-memory or pre-created database (used in tests)
      this._db = pathOrDb;
    }

    // Essential SQLite pragmas
    this._db.run('PRAGMA journal_mode=WAL');
    this._db.run('PRAGMA foreign_keys=ON');
    this._db.run('PRAGMA synchronous=NORMAL');
    this._db.run('PRAGMA cache_size=-16000'); // 16 MB page cache

    // Apply all schema migrations
    runMigrations(this._db);
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Create a new session record.
   * Idempotent: uses INSERT OR IGNORE so calling twice with the same
   * claude_session_id is safe and returns the existing row's id.
   */
  createSession(claudeSessionId: string, project: string, firstPrompt?: string): number {
    const scrubbedPrompt = firstPrompt ? scrubSecrets(firstPrompt) : null;
    this._db.run(
      `INSERT OR IGNORE INTO sessions (claude_session_id, project, first_prompt)
       VALUES (?, ?, ?)`,
      [claudeSessionId, project, scrubbedPrompt],
    );
    const row = this._db.query<{ id: number }, [string]>(
      'SELECT id FROM sessions WHERE claude_session_id = ?',
    ).get(claudeSessionId);
    if (!row) throw new Error(`Failed to create or retrieve session: ${claudeSessionId}`);
    return row.id;
  }

  getSession(claudeSessionId: string): Session | null {
    return this._db.query<Session, [string]>(
      'SELECT * FROM sessions WHERE claude_session_id = ?',
    ).get(claudeSessionId) ?? null;
  }

  updateSessionStatus(id: number, status: SessionStatus): void {
    const completedAt = status === 'completed' ? Math.floor(Date.now() / 1000) : null;
    this._db.run(
      'UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?',
      [status, completedAt, id],
    );
  }

  /** Increment prompt_counter atomically and return the new value. */
  incrementPromptCounter(id: number): number {
    this._db.run(
      'UPDATE sessions SET prompt_counter = prompt_counter + 1 WHERE id = ?',
      [id],
    );
    const row = this._db.query<{ prompt_counter: number }, [number]>(
      'SELECT prompt_counter FROM sessions WHERE id = ?',
    ).get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return row.prompt_counter;
  }

  // ─── Observations ──────────────────────────────────────────────────────────

  insertObservation(obs: Omit<Observation, 'id' | 'created_at'>): number {
    // Scrub secrets from both raw_input and compressed text before storage
    const scrubbedRaw = obs.raw_input ? scrubSecrets(obs.raw_input) : null;
    const scrubbedCompressed = scrubSecrets(obs.compressed);
    const scrubbedNarrative = obs.narrative ? scrubSecrets(obs.narrative) : null;

    // HMAC sign the observation content for integrity verification (INJ-04)
    const hmac = signObservation(scrubbedCompressed, scrubbedNarrative);

    const result = this._db.run(
      `INSERT INTO observations
         (session_id, prompt_number, tool_name, raw_input, compressed, obs_type, title, narrative, hmac)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        obs.session_id,
        obs.prompt_number,
        obs.tool_name,
        scrubbedRaw,
        scrubbedCompressed,
        obs.obs_type,
        obs.title ?? null,
        scrubbedNarrative,
        hmac,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getObservations(project: string, limit: number, offset: number): Observation[] {
    const rows = this._db.query<Observation, [string, number, number]>(
      `SELECT o.*
       FROM observations o
       JOIN sessions s ON s.id = o.session_id
       WHERE s.project = ?
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(project, limit, offset);

    // HMAC verification (INJ-04) — warn on tamper, don't throw (graceful degradation)
    for (const row of rows) {
      if (!verifyObservationHmac(row.compressed, row.narrative, row.hmac)) {
        process.stderr.write(
          `[c-mem] HMAC verification failed for observation id=${row.id} — possible tampering\n`
        );
      }
    }
    return rows;
  }

  getObservation(id: number): Observation | null {
    const row = this._db.query<Observation, [number]>(
      'SELECT * FROM observations WHERE id = ?',
    ).get(id) ?? null;

    if (row && !verifyObservationHmac(row.compressed, row.narrative, row.hmac)) {
      process.stderr.write(
        `[c-mem] HMAC verification failed for observation id=${row.id} — possible tampering\n`
      );
    }
    return row;
  }

  getRecentObservations(project: string, limit: number): Observation[] {
    return this._db.query<Observation, [string, number]>(
      `SELECT o.*
       FROM observations o
       JOIN sessions s ON s.id = o.session_id
       WHERE s.project = ?
       ORDER BY o.created_at DESC
       LIMIT ?`,
    ).all(project, limit);
  }

  // ─── User Prompts ──────────────────────────────────────────────────────────

  insertUserPrompt(sessionId: number, promptNumber: number, prompt: string): void {
    const scrubbedPrompt = scrubSecrets(prompt);
    this._db.run(
      `INSERT INTO user_prompts (session_id, prompt_number, prompt)
       VALUES (?, ?, ?)`,
      [sessionId, promptNumber, scrubbedPrompt],
    );
  }

  // ─── Summaries ─────────────────────────────────────────────────────────────

  insertSummary(summary: Omit<Summary, 'id' | 'created_at'>): number {
    const result = this._db.run(
      `INSERT INTO summaries (session_id, request, investigated, learned, completed, next_steps)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        summary.session_id,
        summary.request ?? null,
        summary.investigated ?? null,
        summary.learned ?? null,
        summary.completed ?? null,
        summary.next_steps ?? null,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getRecentSummaries(project: string, limit: number): Summary[] {
    return this._db.query<Summary, [string, number]>(
      `SELECT su.*
       FROM summaries su
       JOIN sessions s ON s.id = su.session_id
       WHERE s.project = ?
       ORDER BY su.created_at DESC
       LIMIT ?`,
    ).all(project, limit);
  }

  // ─── Queue ─────────────────────────────────────────────────────────────────

  /**
   * Add a message to the processing queue.
   * Validates payload JSON and enforces the 100 KB size limit.
   */
  enqueue(sessionId: number, type: QueueMessageType, payload: object): number {
    // Scrub secrets from the payload before enqueueing
    const scrubbedPayload = scrubJson(payload);
    const json = JSON.stringify(scrubbedPayload);

    // Validate payload size (SEC requirement: max 100 KB)
    const byteLength = Buffer.byteLength(json, 'utf-8');
    if (byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `Queue payload exceeds maximum size: ${byteLength} bytes (max ${MAX_PAYLOAD_BYTES})`,
      );
    }

    // Validate JSON is parseable (defensive round-trip check)
    try {
      JSON.parse(json);
    } catch {
      throw new Error('Queue payload is not valid JSON');
    }

    const result = this._db.run(
      `INSERT INTO queue (session_id, message_type, payload)
       VALUES (?, ?, ?)`,
      [sessionId, type, json],
    );
    return Number(result.lastInsertRowid);
  }

  /** Fetch up to `limit` pending messages, oldest first. */
  dequeue(limit: number): QueueMessage[] {
    return this._db.query<QueueMessage, [number]>(
      `SELECT * FROM queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(limit);
  }

  markProcessing(id: number): void {
    this._db.run(
      `UPDATE queue
       SET status = 'processing', started_at = unixepoch()
       WHERE id = ?`,
      [id],
    );
  }

  markProcessed(id: number): void {
    this._db.run(
      `UPDATE queue
       SET status = 'processed', completed_at = unixepoch()
       WHERE id = ?`,
      [id],
    );
  }

  markFailed(id: number, error: string): void {
    this._db.run(
      `UPDATE queue
       SET status = 'failed',
           error = ?,
           retry_count = retry_count + 1,
           completed_at = unixepoch()
       WHERE id = ?`,
      [error, id],
    );
  }

  /**
   * Return queue messages that have been in 'processing' state longer than
   * `thresholdSeconds` without completing — likely crashed mid-process.
   */
  getStuck(thresholdSeconds: number): QueueMessage[] {
    return this._db.query<QueueMessage, [number]>(
      `SELECT * FROM queue
       WHERE status = 'processing'
         AND started_at IS NOT NULL
         AND (unixepoch() - started_at) >= ?
       ORDER BY started_at ASC`,
    ).all(thresholdSeconds);
  }

  getPending(): QueueMessage[] {
    return this._db.query<QueueMessage, []>(
      `SELECT * FROM queue
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    ).all();
  }

  // ─── FTS5 Search ───────────────────────────────────────────────────────────

  /**
   * Full-text keyword search over observations using the FTS5 index.
   * The query string is sanitised before being used in a MATCH expression
   * to prevent FTS5 syntax injection.
   *
   * Optionally scoped to a specific project. Results are ranked by BM25
   * relevance (lower rank value = better match in SQLite FTS5).
   */
  searchFTS(query: string, project?: string, limit = 20): Observation[] {
    const safeQuery = escapeFTS5Query(query);
    if (!safeQuery) return [];

    if (project) {
      return this._db.query<Observation, [string, string, number]>(
        `SELECT o.*
         FROM obs_fts
         JOIN observations o ON o.id = obs_fts.rowid
         JOIN sessions s     ON s.id = o.session_id
         WHERE obs_fts MATCH ?
           AND s.project = ?
         ORDER BY rank
         LIMIT ?`,
      ).all(safeQuery, project, limit);
    }

    return this._db.query<Observation, [string, number]>(
      `SELECT o.*
       FROM obs_fts
       JOIN observations o ON o.id = obs_fts.rowid
       WHERE obs_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ).all(safeQuery, limit);
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Return per-project counts for observations, summaries, and sessions.
   * Keys are project names; missing projects return zeroed counts.
   */
  getStats(): Record<string, ProjectStats> {
    const obsCounts = this._db.query<{ project: string; count: number }, []>(
      `SELECT s.project, COUNT(o.id) AS count
       FROM sessions s
       LEFT JOIN observations o ON o.session_id = s.id
       GROUP BY s.project`,
    ).all();

    const sumCounts = this._db.query<{ project: string; count: number }, []>(
      `SELECT s.project, COUNT(su.id) AS count
       FROM sessions s
       LEFT JOIN summaries su ON su.session_id = s.id
       GROUP BY s.project`,
    ).all();

    const sesCounts = this._db.query<{ project: string; count: number }, []>(
      `SELECT project, COUNT(id) AS count
       FROM sessions
       GROUP BY project`,
    ).all();

    // Merge into a single result object
    const stats: Record<string, ProjectStats> = {};

    const ensureProject = (p: string) => {
      if (!stats[p]) stats[p] = { observations: 0, summaries: 0, sessions: 0 };
    };

    for (const row of obsCounts) {
      ensureProject(row.project);
      stats[row.project].observations = row.count;
    }
    for (const row of sumCounts) {
      ensureProject(row.project);
      stats[row.project].summaries = row.count;
    }
    for (const row of sesCounts) {
      ensureProject(row.project);
      stats[row.project].sessions = row.count;
    }

    return stats;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this._db.close();
  }

  /**
   * Expose the raw bun:sqlite handle for use in search.ts.
   * @internal
   */
  get rawDb(): Database {
    return this._db;
  }
}

// ─── FTS5 Query Sanitisation ─────────────────────────────────────────────────

/**
 * Escape user-supplied text before using it as an FTS5 MATCH expression.
 *
 * FTS5 special characters that could cause syntax errors or injection:
 *   "  '  *  :  .  (  )  ^  -  +  NOT  AND  OR
 *
 * Strategy: wrap the entire query in double-quotes (phrase mode) after
 * escaping any internal double-quotes by doubling them.
 * This gives us exact-phrase matching which is safe and predictable.
 * For more advanced queries, callers should use the search service methods
 * in search.ts which provide controlled boolean/prefix modes.
 *
 * Returns null if the query is empty after stripping whitespace.
 */
export function escapeFTS5Query(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Escape internal double-quotes by doubling them (FTS5 phrase escape rule)
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/** The singleton database instance. Call getDb() to initialise lazily. */
export { getDb as createDb };

// Export the concrete class for testing
export { CMemDb };

// ═══════════════════════════════════════════════════════════════════════════════
// ISessionStore Adapter (formerly src/storage/compat.ts)
//
// Bridges CMemDb's DbInterface → the worker's ISessionStore contract.
// Exported as `db`, `search`, `initDb`, `_resetCompatForTesting` so
// server.ts can import from this file directly.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getRawDb(): Database {
  const d = getDb() as CMemDb;
  return d.rawDb;
}

function _epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function _mapSession(s: {
  id: number;
  claude_session_id: string;
  project: string;
  status: string;
  prompt_counter: number;
  created_at: number;
  completed_at: number | null;
}): BBSession {
  return {
    id: s.id,
    session_id: s.claude_session_id,
    claude_session_id: s.claude_session_id,
    project: s.project,
    status: s.status === "summarizing" ? "active" : (s.status as "active" | "completed"),
    prompt_counter: s.prompt_counter,
    created_at: _epochToIso(s.created_at),
    created_at_epoch: s.created_at * 1000,
    completed_at: s.completed_at ? _epochToIso(s.completed_at) : undefined,
  };
}

function _mapObservation(
  o: {
    id: number;
    session_id: number;
    prompt_number: number;
    tool_name: string;
    obs_type: string;
    title: string | null;
    narrative: string | null;
    compressed: string;
    created_at: number;
  },
  project: string,
  sessionStrId: string
): BBObservation {
  let tags: string[] = [];
  let facts: string[] = [];
  let files_read: string[] = [];
  let files_modified: string[] = [];
  try {
    const parsed = JSON.parse(o.compressed) as Record<string, unknown>;
    tags = (parsed.tags as string[]) ?? [];
    facts = (parsed.facts as string[]) ?? [];
    files_read = (parsed.files_read as string[]) ?? [];
    files_modified = (parsed.files_modified as string[]) ?? [];
  } catch {
    // compressed is a narrative string, not JSON — that's OK
  }

  return {
    id: o.id,
    session_id: sessionStrId,
    project,
    prompt_number: o.prompt_number,
    tool_name: o.tool_name,
    type: o.obs_type,
    title: o.title ?? `${o.tool_name} observation`,
    narrative: o.narrative ?? o.compressed,
    tags: JSON.stringify(tags),
    facts: JSON.stringify(facts),
    files_read: JSON.stringify(files_read),
    files_modified: JSON.stringify(files_modified),
    created_at: _epochToIso(o.created_at),
    created_at_epoch: o.created_at * 1000,
  };
}

function _mapQueueItem(row: {
  id: number;
  session_id: number;
  payload: string;
  status: string;
  retry_count: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  claude_session_id?: string;
}): QueueItem {
  let toolName = "unknown";
  let toolInput = "{}";
  let toolResult = "";
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    toolName = (payload.toolName as string) ?? "unknown";
    toolInput = (payload.toolInput as string) ?? "{}";
    toolResult = (payload.toolResult as string) ?? "";
  } catch { /* ignore */ }

  return {
    id: row.id,
    session_id: row.claude_session_id ?? String(row.session_id),
    status: row.status as BBQueueStatus,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResult,
    retry_count: row.retry_count,
    created_at_epoch: row.created_at * 1000,
    started_at_epoch: row.started_at ? row.started_at * 1000 : undefined,
    completed_at_epoch: row.completed_at ? row.completed_at * 1000 : undefined,
    error_message: row.error ?? undefined,
  };
}

// ─── Adapter Implementation ───────────────────────────────────────────────────

class DbAdapter implements ISessionStore {
  constructor(private readonly inner: DbInterface) {}

  // ─── Sessions ─────────────────────────────────────────────────────────────

  createSession(sessionId: string, project: string, firstPrompt: string): number {
    return this.inner.createSession(sessionId, project, firstPrompt);
  }

  getSession(sessionId: string): BBSession | null {
    const s = this.inner.getSession(sessionId);
    if (!s) return null;
    return _mapSession(s as Parameters<typeof _mapSession>[0]);
  }

  getSessionById(id: number): BBSession | null {
    const row = _getRawDb()
      .query<{
        id: number;
        claude_session_id: string;
        project: string;
        status: string;
        prompt_counter: number;
        created_at: number;
        completed_at: number | null;
      }, [number]>(
        "SELECT * FROM sessions WHERE id = ?"
      )
      .get(id);
    return row ? _mapSession(row) : null;
  }

  listSessions(project?: string, limit = 20, offset = 0): BBSession[] {
    if (project) {
      const rows = _getRawDb()
        .query<{
          id: number;
          claude_session_id: string;
          project: string;
          status: string;
          prompt_counter: number;
          created_at: number;
          completed_at: number | null;
        }, [string, number, number]>(
          "SELECT * FROM sessions WHERE project = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        .all(project, limit, offset);
      return rows.map(_mapSession);
    }
    const rows = _getRawDb()
      .query<{
        id: number;
        claude_session_id: string;
        project: string;
        status: string;
        prompt_counter: number;
        created_at: number;
        completed_at: number | null;
      }, [number, number]>(
        "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(limit, offset);
    return rows.map(_mapSession);
  }

  updateSessionStatus(sessionId: string, status: "active" | "completed"): void {
    const session = this.inner.getSession(sessionId);
    if (session) {
      this.inner.updateSessionStatus(session.id, status);
    }
  }

  incrementPromptCounter(sessionId: string): number {
    const session = this.inner.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.inner.incrementPromptCounter(session.id);
  }

  // ─── Observations ─────────────────────────────────────────────────────────

  createObservation(obs: Omit<BBObservation, "id">): number {
    const session = this.inner.getSession(obs.session_id);
    const sessionDbId = session?.id ?? 0;

    const safeNarrative = scrubSecrets(obs.narrative);
    const safeTitle = scrubSecrets(obs.title);

    const compressed = JSON.stringify({
      type: obs.type,
      tags: JSON.parse(obs.tags || "[]") as string[],
      facts: JSON.parse(obs.facts || "[]") as string[],
      files_read: JSON.parse(obs.files_read || "[]") as string[],
      files_modified: JSON.parse(obs.files_modified || "[]") as string[],
      narrative: safeNarrative,
    });

    return this.inner.insertObservation({
      session_id: sessionDbId,
      prompt_number: obs.prompt_number,
      tool_name: obs.tool_name,
      raw_input: null,
      compressed,
      obs_type: obs.type,
      title: safeTitle,
      narrative: safeNarrative,
    });
  }

  getObservation(id: number): BBObservation | null {
    const o = this.inner.getObservation(id);
    if (!o) return null;
    const session = this.getSessionById(o.session_id as unknown as number);
    return _mapObservation(
      o as Parameters<typeof _mapObservation>[0],
      session?.project ?? "",
      session?.session_id ?? String(o.session_id)
    );
  }

  getObservations(
    project?: string,
    limit = 20,
    offset = 0
  ): { observations: BBObservation[]; total: number } {
    const rows = this.inner.getObservations(project ?? "", limit, offset);
    const sessionCache = new Map<number, { project: string; session_id: string }>();
    const mapped = (rows as Parameters<typeof _mapObservation>[0][]).map((o) => {
      let meta = sessionCache.get(o.session_id as unknown as number);
      if (!meta) {
        const s = this.getSessionById(o.session_id as unknown as number);
        meta = { project: s?.project ?? project ?? "", session_id: s?.session_id ?? "" };
        sessionCache.set(o.session_id as unknown as number, meta);
      }
      return _mapObservation(o, meta.project, meta.session_id);
    });

    const totalRow = _getRawDb()
      .query<{ count: number }, [string] | []>(
        project
          ? "SELECT COUNT(o.id) as count FROM observations o JOIN sessions s ON s.id = o.session_id WHERE s.project = ?"
          : "SELECT COUNT(*) as count FROM observations"
      )
      .get(...(project ? [project] : []) as [] | [string]);

    return { observations: mapped, total: totalRow?.count ?? mapped.length };
  }

  getObservationsByIds(ids: number[]): BBObservation[] {
    if (ids.length === 0) return [];
    return ids
      .map((id) => this.getObservation(id))
      .filter((o): o is BBObservation => o !== null);
  }

  getObservationsBySession(sessionId: string): BBObservation[] {
    const session = this.inner.getSession(sessionId);
    if (!session) return [];
    const rows = _getRawDb()
      .query<Parameters<typeof _mapObservation>[0], [number]>(
        "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at DESC"
      )
      .all(session.id);
    return rows.map((o) =>
      _mapObservation(o, session.project, session.claude_session_id)
    );
  }

  // ─── Summaries ────────────────────────────────────────────────────────────

  createSummary(summary: Omit<SessionSummary, "id">): number {
    const session = this.inner.getSession(summary.session_id);
    const sessionDbId = session?.id ?? 0;
    return this.inner.insertSummary({
      session_id: sessionDbId,
      request: summary.request,
      investigated: summary.discoveries,
      learned: summary.work_done,
      completed: summary.work_done,
      next_steps: summary.remaining,
    });
  }

  getSummaries(
    project?: string,
    limit = 20,
    offset = 0
  ): { summaries: SessionSummary[]; total: number } {
    const rows = this.inner.getRecentSummaries(project ?? "", limit + offset);
    const sliced = rows.slice(offset, offset + limit);
    const mapped = sliced.map((s) => this._mapSummaryToSessionSummary(s));
    return { summaries: mapped, total: rows.length };
  }

  getSummariesBySession(sessionId: string): SessionSummary[] {
    const session = this.inner.getSession(sessionId);
    if (!session) return [];
    const rows = _getRawDb()
      .query<{
        id: number;
        session_id: number;
        request: string | null;
        investigated: string | null;
        learned: string | null;
        completed: string | null;
        next_steps: string | null;
        created_at: number;
      }, [number]>(
        "SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC"
      )
      .all(session.id);
    return rows.map((s) =>
      this._mapSummaryToSessionSummary({
        ...s,
        project: session.project,
        claude_session_id: session.claude_session_id,
      })
    );
  }

  private _mapSummaryToSessionSummary(s: {
    id: number;
    session_id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    created_at: number;
    project?: string;
    claude_session_id?: string;
  }): SessionSummary {
    let project = s.project ?? "";
    let sessionStrId = s.claude_session_id ?? "";
    if (!project || !sessionStrId) {
      const session = this.getSessionById(s.session_id);
      project = session?.project ?? "";
      sessionStrId = session?.session_id ?? "";
    }
    return {
      id: s.id,
      session_id: sessionStrId,
      project,
      prompt_number: 0,
      request: s.request ?? "",
      work_done: s.learned ?? s.completed ?? "",
      discoveries: s.investigated ?? "",
      remaining: s.next_steps ?? "",
      notes: "",
      created_at: _epochToIso(s.created_at),
      created_at_epoch: s.created_at * 1000,
    };
  }

  // ─── User Prompts ─────────────────────────────────────────────────────────

  createUserPrompt(prompt: Omit<BBUserPrompt, "id">): number {
    const session = this.inner.getSession(prompt.session_id);
    const sessionDbId = session?.id ?? 0;
    this.inner.insertUserPrompt(sessionDbId, prompt.prompt_number, prompt.prompt_text);
    const row = _getRawDb()
      .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
      .get();
    return row?.id ?? 0;
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  enqueueObservation(
    sessionId: string,
    toolName: string,
    toolInput: string,
    toolResponse: string,
    project = ""
  ): number {
    let session = this.inner.getSession(sessionId);
    if (!session) {
      // Auto-create a lightweight session so the FK constraint is satisfied.
      this.inner.createSession(sessionId, project, undefined);
      session = this.inner.getSession(sessionId);
    } else if (project && !session.project) {
      // Backfill project if session existed but had no project set
      _getRawDb().run(
        "UPDATE sessions SET project = ? WHERE claude_session_id = ?",
        [project, sessionId]
      );
    }
    const sessionDbId = session?.id ?? 0;
    return this.inner.enqueue(sessionDbId, "observation", {
      toolName,
      toolInput,
      toolResult: toolResponse,  // stored as toolResult in payload JSON for backward compat
    });
  }

  getPendingQueueItems(limit = 50): QueueItem[] {
    const rows = _getRawDb()
      .query<{
        id: number;
        session_id: number;
        payload: string;
        status: string;
        retry_count: number;
        created_at: number;
        started_at: number | null;
        completed_at: number | null;
        error: string | null;
        claude_session_id: string;
      }, [number]>(
        `SELECT q.*, s.claude_session_id
         FROM queue q
         JOIN sessions s ON s.id = q.session_id
         WHERE q.status = 'pending'
         ORDER BY q.created_at ASC
         LIMIT ?`
      )
      .all(limit);
    return rows.map(_mapQueueItem);
  }

  getQueueItem(id: number): QueueItem | null {
    const row = _getRawDb()
      .query<{
        id: number;
        session_id: number;
        payload: string;
        status: string;
        retry_count: number;
        created_at: number;
        started_at: number | null;
        completed_at: number | null;
        error: string | null;
        claude_session_id: string;
      }, [number]>(
        `SELECT q.*, s.claude_session_id
         FROM queue q
         JOIN sessions s ON s.id = q.session_id
         WHERE q.id = ?`
      )
      .get(id);
    return row ? _mapQueueItem(row) : null;
  }

  updateQueueStatus(id: number, status: BBQueueStatus, errorMessage?: string): void {
    const rawDb = _getRawDb();
    if (status === "processing") {
      rawDb.run(
        "UPDATE queue SET status = 'processing', started_at = unixepoch() WHERE id = ?",
        [id]
      );
    } else if (status === "processed") {
      rawDb.run(
        "UPDATE queue SET status = 'processed', completed_at = unixepoch() WHERE id = ?",
        [id]
      );
    } else if (status === "failed") {
      rawDb.run(
        "UPDATE queue SET status = 'failed', error = ?, completed_at = unixepoch() WHERE id = ?",
        [errorMessage ?? "Unknown error", id]
      );
    } else if (status === "pending") {
      rawDb.run(
        "UPDATE queue SET status = 'pending', started_at = NULL WHERE id = ?",
        [id]
      );
    }
  }

  getQueueCounts(): { pending: number; processing: number; failed: number; stuck: number } {
    const rawDb = _getRawDb();
    const getCount = (where: string, params: unknown[] = []) => {
      const row = rawDb
        .query<{ count: number }, unknown[]>(`SELECT COUNT(*) as count FROM queue WHERE ${where}`)
        .get(...params);
      return row?.count ?? 0;
    };
    const stuckThresholdSec = 300;
    return {
      pending: getCount("status = 'pending'"),
      processing: getCount("status = 'processing'"),
      failed: getCount("status = 'failed'"),
      stuck: getCount(
        "status = 'processing' AND started_at IS NOT NULL AND (unixepoch() - started_at) >= ?",
        [stuckThresholdSec]
      ),
    };
  }

  getStuckItems(thresholdMs: number): QueueItem[] {
    const thresholdSec = Math.floor(thresholdMs / 1000);
    const rows = _getRawDb()
      .query<{
        id: number;
        session_id: number;
        payload: string;
        status: string;
        retry_count: number;
        created_at: number;
        started_at: number | null;
        completed_at: number | null;
        error: string | null;
        claude_session_id: string;
      }, [number]>(
        `SELECT q.*, s.claude_session_id
         FROM queue q
         JOIN sessions s ON s.id = q.session_id
         WHERE q.status = 'processing'
           AND q.started_at IS NOT NULL
           AND (unixepoch() - q.started_at) >= ?
         ORDER BY q.started_at ASC`
      )
      .all(thresholdSec);
    return rows.map(_mapQueueItem);
  }

  resetStuckItems(thresholdMs: number): number {
    const thresholdSec = Math.floor(thresholdMs / 1000);
    const result = _getRawDb().run(
      `UPDATE queue
       SET status = 'pending', started_at = NULL
       WHERE status = 'processing'
         AND started_at IS NOT NULL
         AND (unixepoch() - started_at) >= ?`,
      [thresholdSec]
    );
    return result.changes;
  }

  incrementRetryCount(id: number): number {
    _getRawDb().run(
      "UPDATE queue SET retry_count = retry_count + 1 WHERE id = ?",
      [id]
    );
    const row = _getRawDb()
      .query<{ retry_count: number }, [number]>(
        "SELECT retry_count FROM queue WHERE id = ?"
      )
      .get(id);
    return row?.retry_count ?? 0;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  getStats(project?: string): Record<string, number> {
    const all = this.inner.getStats();
    if (project) {
      const stats = all[project] ?? { observations: 0, summaries: 0, sessions: 0 };
      return {
        observations: stats.observations,
        summaries: stats.summaries,
        sessions: stats.sessions,
        pending_queue: this.getQueueCounts().pending,
      };
    }
    let observations = 0, summaries = 0, sessions = 0;
    for (const s of Object.values(all)) {
      observations += s.observations;
      summaries += s.summaries;
      sessions += s.sessions;
    }
    return {
      observations,
      summaries,
      sessions,
      pending_queue: this.getQueueCounts().pending,
    };
  }
}

// ─── Adapter + Search Singletons ──────────────────────────────────────────────

let _adapterInstance: DbAdapter | null = null;

function getAdapter(): DbAdapter {
  if (!_adapterInstance) {
    _adapterInstance = new DbAdapter(getDb());
  }
  return _adapterInstance;
}

/**
 * Initialize the database adapter for the given data directory.
 * Called by server.ts at startup.
 */
export function initDb(_dataDir: string): void {
  getAdapter(); // trigger lazy init
}

/**
 * Reset DB for testing — re-exposes Builder C's reset with adapter cleanup.
 * @internal
 */
export function _resetCompatForTesting(rawDb?: Database): void {
  _adapterInstance = null;
  _searchInstance = null;
  _resetDbForTesting(rawDb);
}

/**
 * The singleton ISessionStore adapter — wraps CMemDb.
 * Import this as `db` in server.ts and queue.ts.
 */
export const db: ISessionStore = new Proxy({} as ISessionStore, {
  get(_target, prop) {
    return (getAdapter() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Search Adapter ───────────────────────────────────────────────────────────

export class SearchAdapter {
  private readonly svc: SearchService;

  constructor(rawDb: Database) {
    this.svc = new SearchService(rawDb);
  }

  searchObservations(
    query: string,
    filters?: { project?: string; limit?: number; offset?: number }
  ): Array<{
    id: number;
    title: string;
    type: string;
    project: string;
    created_at_epoch: number;
    rank: number;
    snippet?: string;
  }> {
    const rawResults = this.svc.searchKeyword(
      query,
      filters?.project,
      filters?.limit ?? 20
    );
    return rawResults.map((o, idx) => ({
      id: o.id,
      title: o.title ?? "",
      type: o.obs_type,
      project: filters?.project ?? "",
      created_at_epoch: o.created_at * 1000,
      rank: idx,
      snippet: o.narrative?.slice(0, 200) ?? o.compressed?.slice(0, 200),
    }));
  }

  searchSummaries(
    _query: string,
    _filters?: { project?: string; limit?: number }
  ): Array<{
    id: number;
    title: string;
    type: string;
    project: string;
    created_at_epoch: number;
    rank: number;
  }> {
    return [];
  }

  searchKeyword(query: string, project?: string, limit = 20) {
    return this.svc.searchKeyword(query, project, limit);
  }

  searchByType(type: string, project?: string, limit = 20) {
    return this.svc.searchByType(type, project, limit);
  }

  searchIndex(query: string, project?: string, limit = 20) {
    return this.svc.searchIndex(query, project, limit);
  }

  getByIds(ids: number[]) {
    return this.svc.getByIds(ids);
  }

  getTimeline(id: number, window = 5) {
    return this.svc.getTimeline(id, window);
  }
}

let _searchInstance: SearchAdapter | null = null;

/**
 * The singleton search adapter.
 * Import this as `search` in server.ts.
 */
export const search = new Proxy({} as SearchAdapter, {
  get(_target, prop) {
    if (!_searchInstance) {
      const rawDb = (getDb() as CMemDb).rawDb;
      _searchInstance = new SearchAdapter(rawDb);
    }
    return (_searchInstance as unknown as Record<string | symbol, unknown>)[prop];
  },
});
