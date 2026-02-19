/**
 * Open-Mem SQLite Schema
 *
 * All DDL statements for initialising a fresh database.
 * Executed in order by migrations.ts on startup.
 *
 * Design principles (from 00-security-audit.md + 02-storage-search.md):
 *  - WAL mode (set in db.ts on connection open)
 *  - Foreign keys enforced at connection level
 *  - FTS5 virtual tables kept in sync via INSERT/DELETE/UPDATE triggers
 *  - porter unicode61 tokenizer gives decent recall for code-related prose
 *  - All FTS5 content tables use content= (external content) to avoid
 *    duplicating data; rowid= links to the source table's primary key
 */

// ─── Core Tables ─────────────────────────────────────────────────────────────

export const SQL_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT    UNIQUE NOT NULL,
  project           TEXT    NOT NULL,
  first_prompt      TEXT,
  prompt_counter    INTEGER DEFAULT 0,
  status            TEXT    DEFAULT 'active'
                    CHECK(status IN ('active', 'summarizing', 'completed')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at      INTEGER
);
`;

export const SQL_USER_PROMPTS = `
CREATE TABLE IF NOT EXISTS user_prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  prompt        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export const SQL_OBSERVATIONS = `
CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  tool_name     TEXT    NOT NULL,
  raw_input     TEXT,
  compressed    TEXT    NOT NULL,
  obs_type      TEXT    NOT NULL DEFAULT 'other',
  title         TEXT,
  narrative     TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export const SQL_SUMMARIES = `
CREATE TABLE IF NOT EXISTS summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request      TEXT,
  investigated TEXT,
  learned      TEXT,
  completed    TEXT,
  next_steps   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export const SQL_QUEUE = `
CREATE TABLE IF NOT EXISTS queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  message_type TEXT    NOT NULL CHECK(message_type IN ('observation', 'summary')),
  payload      TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
  retry_count  INTEGER DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at   INTEGER,
  completed_at INTEGER
);
`;

// ─── Indexes ──────────────────────────────────────────────────────────────────

export const SQL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_project       ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_observations_session   ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_project   ON observations(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_status           ON queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_summaries_session      ON summaries(session_id);
`;

// ─── FTS5 Virtual Table ───────────────────────────────────────────────────────

/**
 * External-content FTS5 table backed by the observations table.
 * We index title, narrative, compressed, and tool_name.
 * porter tokenizer improves recall for English prose; unicode61 handles
 * non-ASCII characters correctly.
 */
export const SQL_FTS5_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
  title,
  narrative,
  compressed,
  tool_name,
  content=observations,
  content_rowid=id,
  tokenize='porter unicode61'
);
`;

// ─── FTS5 Sync Triggers ───────────────────────────────────────────────────────

/**
 * After INSERT on observations: add the new row to the FTS5 index.
 */
export const SQL_TRIGGER_OBS_AI = `
CREATE TRIGGER IF NOT EXISTS obs_ai
AFTER INSERT ON observations
BEGIN
  INSERT INTO obs_fts(rowid, title, narrative, compressed, tool_name)
  VALUES (new.id, new.title, new.narrative, new.compressed, new.tool_name);
END;
`;

/**
 * After DELETE on observations: remove the old row from the FTS5 index.
 * FTS5 'delete' command syntax requires the special first-column sentinel.
 */
export const SQL_TRIGGER_OBS_AD = `
CREATE TRIGGER IF NOT EXISTS obs_ad
AFTER DELETE ON observations
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, narrative, compressed, tool_name)
  VALUES ('delete', old.id, old.title, old.narrative, old.compressed, old.tool_name);
END;
`;

/**
 * After UPDATE on observations: remove the old FTS5 entry then add the new one.
 */
export const SQL_TRIGGER_OBS_AU = `
CREATE TRIGGER IF NOT EXISTS obs_au
AFTER UPDATE ON observations
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, narrative, compressed, tool_name)
  VALUES ('delete', old.id, old.title, old.narrative, old.compressed, old.tool_name);
  INSERT INTO obs_fts(rowid, title, narrative, compressed, tool_name)
  VALUES (new.id, new.title, new.narrative, new.compressed, new.tool_name);
END;
`;

// ─── Ordered DDL list (executed by migrations.ts) ────────────────────────────

/**
 * All schema statements in the order they must be executed.
 * This is the canonical reference for the v1 schema.
 */
export const SCHEMA_V1: string[] = [
  SQL_SESSIONS,
  SQL_USER_PROMPTS,
  SQL_OBSERVATIONS,
  SQL_SUMMARIES,
  SQL_QUEUE,
  SQL_INDEXES,
  SQL_FTS5_TABLE,
  SQL_TRIGGER_OBS_AI,
  SQL_TRIGGER_OBS_AD,
  SQL_TRIGGER_OBS_AU,
];
