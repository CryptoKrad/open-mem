/**
 * Open-Mem Migration Runner
 *
 * Applies schema migrations in order on database startup.
 * Each migration has a version number and SQL body.
 * Idempotent: migrations already recorded in the `migrations` table are skipped.
 *
 * The migration table itself is created here before any migrations run,
 * so this module bootstraps a completely empty database correctly.
 */

import type { Database } from 'bun:sqlite';
import { SCHEMA_V1 } from './schema.ts';

// ─── Migration Record ─────────────────────────────────────────────────────────

export interface Migration {
  version: number;
  description: string;
  sql: string[];
}

// ─── Bootstrap: create the migrations tracking table ─────────────────────────

const SQL_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// ─── Migration Definitions ────────────────────────────────────────────────────

/**
 * All migrations in ascending version order.
 * To add a new migration: append an entry with the next version number.
 * NEVER edit an existing migration that has already been applied in production.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: sessions, user_prompts, observations, summaries, queue, FTS5',
    sql: SCHEMA_V1,
  },
  {
    version: 2,
    description: 'Add hmac column to observations for content integrity (INJ-04)',
    sql: [
      `ALTER TABLE observations ADD COLUMN hmac TEXT;`,
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all pending migrations against the given database connection.
 * Creates the migrations table if it does not exist.
 * Each migration is applied in a single transaction for atomicity.
 *
 * @param db - Open bun:sqlite Database instance
 */
export function runMigrations(db: Database): void {
  // Always create the migrations table first (idempotent)
  db.run(SQL_MIGRATIONS_TABLE);

  // Fetch already-applied versions
  const applied = new Set<number>(
    (db.query('SELECT version FROM migrations ORDER BY version ASC').all() as { version: number }[])
      .map((r) => r.version),
  );

  // Apply each migration that hasn't been recorded yet
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue; // Already applied — skip
    }

    // Run migration SQL inside a transaction so it's all-or-nothing
    const applyMigration = db.transaction(() => {
      for (const statement of migration.sql) {
        const trimmed = statement.trim();
        if (trimmed.length === 0) continue;
        db.run(trimmed);
      }
      // Record successful application
      db.run('INSERT INTO migrations (version) VALUES (?)', [migration.version]);
    });

    try {
      applyMigration();
    } catch (err) {
      throw new Error(
        `Migration v${migration.version} failed: ${migration.description}\n` +
          String(err),
      );
    }
  }
}
