#!/usr/bin/env bun
/**
 * C-Mem Hook: UserPromptSubmit
 *
 * Fires when the user submits a prompt in a Claude Code / OpenClaw session.
 *
 * Responsibilities:
 * - Validate session_id
 * - Strip secrets and <private> tags from the prompt
 * - INSERT OR IGNORE session into DB (idempotent session creation)
 * - Increment prompt_counter
 * - Save user_prompt to DB
 * - Fire-and-forget POST to worker /api/sessions/init (2s timeout)
 * - Return { continue: true, suppressOutput: true }
 *
 * Uses bun:sqlite for direct DB writes to minimize latency.
 * ALL DB writes use parameterized queries — no string interpolation.
 *
 * @module hooks/user-prompt
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { loadConfig, projectFromCwd, workerBaseUrl } from "../config.js";
import { readAuthToken } from "../auth/token.js";

const AUTH_TOKEN = readAuthToken();
import {
  isValidSessionId,
  scrubSecrets,
  stripPrivacyTags,
  isFullyPrivate,
} from "./privacy.js";
import type { HookInput, HookOutput } from "../types.js";

// ─── DB Helpers ───────────────────────────────────────────────────────────────

/**
 * Open (or create) the C-Mem SQLite database.
 * Enables WAL mode and foreign keys for data integrity.
 * All DB operations use parameterized queries.
 */
function openDb(dbPath: string): Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 3000");

  // Ensure sessions table exists (minimal bootstrap — full schema owned by Builder C)
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claude_session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      prompt_counter INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL REFERENCES sessions(id),
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

/**
 * Idempotently create a session row.
 * Returns the DB primary key (id) for the session.
 *
 * @param db        - Open SQLite connection
 * @param sessionId - External session identifier (already validated)
 * @param project   - Project name from cwd
 */
function upsertSession(db: Database, sessionId: string, project: string): number {
  const now = new Date().toISOString();

  // INSERT OR IGNORE — safe to call repeatedly for the same session
  db.run(
    "INSERT OR IGNORE INTO sessions (claude_session_id, project, status, prompt_counter, created_at) VALUES (?, ?, 'active', 0, ?)",
    [sessionId, project, now]
  );

  const row = db.query<{ id: number }, [string]>(
    "SELECT id FROM sessions WHERE claude_session_id = ?"
  ).get(sessionId);

  if (!row) throw new Error(`Session lookup failed for session_id: ${sessionId}`);
  return row.id;
}

/**
 * Increment the session prompt_counter and return the new value.
 */
function incrementPromptCounter(db: Database, sessionDbId: number): number {
  db.run(
    "UPDATE sessions SET prompt_counter = prompt_counter + 1 WHERE id = ?",
    [sessionDbId]
  );

  const row = db.query<{ prompt_counter: number }, [number]>(
    "SELECT prompt_counter FROM sessions WHERE id = ?"
  ).get(sessionDbId);

  return row?.prompt_counter ?? 1;
}

/**
 * Save the cleaned prompt text to the user_prompts table.
 */
function savePrompt(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  promptText: string
): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at) VALUES (?, ?, ?, ?)",
    [sessionDbId, promptNumber, promptText, now]
  );
}

// ─── Fire-and-Forget HTTP ─────────────────────────────────────────────────────

/**
 * Notify the worker about a new session/prompt — fire and forget.
 * If the worker is down or slow, we don't care. Returns immediately.
 */
function notifyWorker(
  workerUrl: string,
  sessionId: string,
  sessionDbId: number,
  project: string,
  userPrompt: string,
  promptNumber: number
): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);

  fetch(`${workerUrl}/api/sessions/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { "Authorization": `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ sessionId, sessionDbId, project, userPrompt, promptNumber }),
    signal: controller.signal,
  })
    .then(() => clearTimeout(timer))
    .catch(() => clearTimeout(timer));
  // Intentionally not awaited
}

// ─── Main Hook ────────────────────────────────────────────────────────────────

const CONTINUE_OUTPUT: HookOutput = { continue: true, suppressOutput: true };

async function main(): Promise<void> {
  let input: HookInput;

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  // Validate session_id — reject malformed identifiers early
  if (!isValidSessionId(input.session_id)) {
    process.stderr.write(
      `[c-mem/user-prompt] Rejected invalid session_id: "${input.session_id}"\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const rawPrompt = input.prompt ?? "";

  // Strip privacy tags first, then scrub secrets
  const strippedPrompt = stripPrivacyTags(rawPrompt);

  // If prompt was entirely private, skip — don't store anything
  if (isFullyPrivate(rawPrompt) || strippedPrompt.trim() === "") {
    process.stderr.write(
      `[c-mem/user-prompt] Fully private prompt — skipping storage.\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const cleanPrompt = scrubSecrets(strippedPrompt);

  try {
    const config = loadConfig();
    const project = projectFromCwd(input.cwd ?? "");
    const db = openDb(config.dbPath);

    const sessionDbId = upsertSession(db, input.session_id, project);
    const promptNumber = incrementPromptCounter(db, sessionDbId);
    savePrompt(db, sessionDbId, promptNumber, cleanPrompt);

    db.close();

    // Fire-and-forget worker notification
    notifyWorker(
      workerBaseUrl(config),
      input.session_id,
      sessionDbId,
      project,
      cleanPrompt,
      promptNumber
    );
  } catch (err) {
    process.stderr.write(
      `[c-mem/user-prompt] DB error: ${err instanceof Error ? err.message : err}\n`
    );
    // Never block the session — return continue even on error
  }

  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[c-mem/user-prompt] Unhandled error: ${err}\n`);
  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
  process.exit(0);
});
