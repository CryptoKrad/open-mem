/**
 * Open-Mem Storage Layer — Public API
 *
 * All exports from the storage layer flow through this file.
 * Consumers import from 'src/storage' (or the path alias).
 *
 * Exports:
 *  - db         : DbInterface singleton (lazy-initialised)
 *  - search     : SearchService instance (shares the db connection)
 *  - scrub      : scrubSecrets, scrubJson utilities
 *  - All types  : re-exported for consumers
 */

// ─── Database ─────────────────────────────────────────────────────────────────

import { getDb, CMemDb, escapeFTS5Query, _resetDbForTesting } from './db.ts';
import { SearchService } from './search.ts';
import type { DbInterface } from './db.ts';

// ─── Singleton Initialisation ─────────────────────────────────────────────────

/** Lazily-initialised database singleton */
export const db: DbInterface = new Proxy({} as DbInterface, {
  get(_target, prop) {
    return (getDb() as Record<string | symbol, unknown>)[prop];
  },
});

/** SearchService that shares the singleton db connection */
let _searchInstance: SearchService | null = null;
export function getSearch(): SearchService {
  if (!_searchInstance) {
    const rawDb = (getDb() as CMemDb).rawDb;
    _searchInstance = new SearchService(rawDb);
  }
  return _searchInstance;
}

/** Convenience alias — same object returned by getSearch() */
export const search = new Proxy({} as SearchService, {
  get(_target, prop) {
    return (getSearch() as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Secret Scrubbing ─────────────────────────────────────────────────────────

export { scrubSecrets, scrubJson } from './secrets.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  Session,
  SessionStatus,
  Observation,
  UserPrompt,
  Summary,
  QueueMessage,
  QueueMessageType,
  QueueStatus,
  IndexResult,
  ProjectStats,
} from './types.ts';

// ─── Internal helpers re-exported for testing ──────────────────────────────────

export { getDb, CMemDb, escapeFTS5Query, _resetDbForTesting, SearchService };
export type { DbInterface };
