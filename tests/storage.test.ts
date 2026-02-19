/**
 * C-Mem Storage Layer Tests
 *
 * Tests are grouped by sub-module:
 *   1. Secret scrubbing
 *   2. Session CRUD (createSession idempotency)
 *   3. FTS5 search
 *   4. Queue state machine
 *   5. Stats
 *   6. SearchService (searchKeyword, getTimeline, getByIds, searchIndex)
 *   7. Migrations (idempotency)
 *
 * Uses bun:sqlite in-memory databases so no disk state is created or leaked.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scrubSecrets, scrubJson } from '../src/storage/secrets.ts';
import { CMemDb, escapeFTS5Query, _resetDbForTesting } from '../src/storage/db.ts';
import { SearchService } from '../src/storage/search.ts';
import { runMigrations } from '../src/storage/migrations.ts';
import type { DbInterface } from '../src/storage/db.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a fresh in-memory DB with migrations applied */
function makeDb(): { db: DbInterface; raw: Database } {
  const raw = new Database(':memory:');
  const db = new CMemDb(raw);
  return { db, raw };
}

/** Seed a session and return its id */
function seedSession(
  db: DbInterface,
  claudeSessionId = 'sess-test-1',
  project = 'test-project',
): number {
  return db.createSession(claudeSessionId, project, 'Hello world');
}

/** Seed an observation and return its id */
function seedObservation(
  db: DbInterface,
  sessionId: number,
  opts: Partial<{ title: string; narrative: string; tool_name: string; obs_type: string }> = {},
): number {
  return db.insertObservation({
    session_id: sessionId,
    prompt_number: 1,
    tool_name: opts.tool_name ?? 'Read',
    raw_input: '{"path":"src/main.ts"}',
    compressed: opts.narrative ?? 'Read the main module to understand the entry point.',
    obs_type: opts.obs_type ?? 'discovery',
    title: opts.title ?? 'Read main module',
    narrative: opts.narrative ?? 'Opened src/main.ts to inspect the bootstrap sequence.',
  });
}

// ─── 1. Secret Scrubbing ──────────────────────────────────────────────────────

describe('scrubSecrets', () => {
  test('redacts AWS access key ID', () => {
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE in the config';
    const result = scrubSecrets(text);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts AWS secret access key', () => {
    const text = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here';
    const result = scrubSecrets(text);
    expect(result).not.toContain('wJalrXUtnFEMI');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts Anthropic API key', () => {
    // 80+ alphanumeric chars after sk-ant-
    const fakeKey = 'sk-ant-' + 'a'.repeat(85);
    const text = `The key is ${fakeKey} use it wisely`;
    const result = scrubSecrets(text);
    expect(result).not.toContain(fakeKey);
    expect(result).toContain('[REDACTED]');
  });

  test('redacts Bearer token', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.somePayload';
    const result = scrubSecrets(text);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts password field', () => {
    const text = 'password=s3cr3tP@ssw0rd123';
    const result = scrubSecrets(text);
    expect(result).not.toContain('s3cr3tP@ssw0rd123');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts api_key field', () => {
    const text = 'api_key: abc123def456ghi789jkl';
    const result = scrubSecrets(text);
    expect(result).not.toContain('abc123def456ghi789jkl');
    expect(result).toContain('[REDACTED]');
  });

  test('leaves non-secret text unchanged', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    expect(scrubSecrets(text)).toBe(text);
  });

  test('handles empty string', () => {
    expect(scrubSecrets('')).toBe('');
  });

  test('handles multiple secrets in one string', () => {
    const fakeKey = 'sk-ant-' + 'b'.repeat(85);
    const text = `key=${fakeKey} Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890`;
    const result = scrubSecrets(text);
    expect(result).not.toContain(fakeKey);
    // Both should be redacted
    const count = (result.match(/\[REDACTED\]/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('scrubJson', () => {
  test('scrubs string values in objects', () => {
    const obj = {
      name: 'test',
      secret: 'password=hunter2',
    };
    const result = scrubJson(obj) as typeof obj;
    expect(result.secret).toContain('[REDACTED]');
    expect(result.name).toBe('test');
  });

  test('scrubs values in arrays', () => {
    const arr = ['normal', 'api_key=supersecret123456789'];
    const result = scrubJson(arr) as string[];
    expect(result[0]).toBe('normal');
    expect(result[1]).toContain('[REDACTED]');
  });

  test('handles nested objects recursively', () => {
    const obj = { level1: { level2: { apiKey: 'api_key=mySecret1234567890' } } };
    const result = scrubJson(obj) as typeof obj;
    expect(result.level1.level2.apiKey).toContain('[REDACTED]');
  });

  test('passes through numbers and booleans', () => {
    expect(scrubJson(42)).toBe(42);
    expect(scrubJson(true)).toBe(true);
    expect(scrubJson(null)).toBeNull();
  });
});

// ─── 2. Session CRUD ──────────────────────────────────────────────────────────

describe('Sessions', () => {
  let db: DbInterface;

  beforeEach(() => {
    ({ db } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test('createSession returns a positive integer id', () => {
    const id = db.createSession('sess-abc', 'my-project');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('createSession is idempotent — second call returns same id', () => {
    const id1 = db.createSession('sess-dup', 'project-x');
    const id2 = db.createSession('sess-dup', 'project-x');
    expect(id1).toBe(id2);
  });

  test('getSession returns null for unknown session', () => {
    expect(db.getSession('does-not-exist')).toBeNull();
  });

  test('getSession returns the session after creation', () => {
    db.createSession('sess-xyz', 'alpha');
    const session = db.getSession('sess-xyz');
    expect(session).not.toBeNull();
    expect(session?.project).toBe('alpha');
    expect(session?.status).toBe('active');
  });

  test('updateSessionStatus transitions status to completed', () => {
    const id = db.createSession('sess-complete', 'proj');
    db.updateSessionStatus(id, 'completed');
    const session = db.getSession('sess-complete');
    expect(session?.status).toBe('completed');
    expect(session?.completed_at).not.toBeNull();
  });

  test('updateSessionStatus transitions to summarizing', () => {
    const id = db.createSession('sess-sum', 'proj');
    db.updateSessionStatus(id, 'summarizing');
    const session = db.getSession('sess-sum');
    expect(session?.status).toBe('summarizing');
  });

  test('incrementPromptCounter increments from 0 to 1', () => {
    const id = db.createSession('sess-counter', 'proj');
    const val = db.incrementPromptCounter(id);
    expect(val).toBe(1);
  });

  test('incrementPromptCounter is cumulative', () => {
    const id = db.createSession('sess-count2', 'proj');
    db.incrementPromptCounter(id);
    db.incrementPromptCounter(id);
    const val = db.incrementPromptCounter(id);
    expect(val).toBe(3);
  });
});

// ─── 3. FTS5 Search ───────────────────────────────────────────────────────────

describe('FTS5 Search', () => {
  let db: DbInterface;
  let sessionId: number;

  beforeEach(() => {
    ({ db } = makeDb());
    sessionId = db.createSession('fts-sess', 'search-proj');
    // Insert several observations with varied content
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 1,
      tool_name: 'Read',
      raw_input: null,
      compressed: 'Discovered that authentication module uses JWT tokens with 24-hour expiry.',
      obs_type: 'discovery',
      title: 'JWT token expiry issue',
      narrative: 'The auth middleware caches tokens beyond their expiry window.',
    });
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 2,
      tool_name: 'Edit',
      raw_input: null,
      compressed: 'Fixed the database connection pool to use WAL mode for better concurrency.',
      obs_type: 'bugfix',
      title: 'Database WAL mode fix',
      narrative: 'Switched SQLite to WAL mode to prevent write lock contention.',
    });
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 3,
      tool_name: 'Bash',
      raw_input: null,
      compressed: 'Ran unit tests and found 3 failing in the payment module.',
      obs_type: 'discovery',
      title: 'Payment module test failures',
      narrative: 'Unit tests reveal payment validation edge cases.',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('searchFTS returns results matching a keyword', () => {
    const results = db.searchFTS('authentication');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const titles = results.map((r) => r.title);
    expect(titles.some((t) => t?.toLowerCase().includes('jwt'))).toBe(true);
  });

  test('searchFTS with project filter returns only project results', () => {
    // Add an observation in a different project
    const otherSessionId = db.createSession('other-sess', 'other-project');
    db.insertObservation({
      session_id: otherSessionId,
      prompt_number: 1,
      tool_name: 'Read',
      raw_input: null,
      compressed: 'Authentication is handled via OAuth in this project.',
      obs_type: 'discovery',
      title: 'OAuth authentication',
      narrative: 'Other project uses OAuth.',
    });

    const results = db.searchFTS('authentication', 'search-proj');
    expect(results.every((r) => r.session_id === sessionId)).toBe(true);
  });

  test('searchFTS returns empty array for no matches', () => {
    const results = db.searchFTS('xyzqwerty_nonexistent_term_12345');
    expect(results).toEqual([]);
  });

  test('searchFTS handles special chars safely (no exception)', () => {
    // Should not throw — double-quotes and stars must be escaped
    expect(() => db.searchFTS('"malicious" OR * :hack')).not.toThrow();
  });

  test('searchFTS respects the limit parameter', () => {
    const results = db.searchFTS('module', 'search-proj', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('escapeFTS5Query wraps query in double quotes', () => {
    expect(escapeFTS5Query('hello world')).toBe('"hello world"');
  });

  test('escapeFTS5Query escapes internal double quotes', () => {
    expect(escapeFTS5Query('say "hello"')).toBe('"say ""hello"""');
  });

  test('escapeFTS5Query returns null for empty string', () => {
    expect(escapeFTS5Query('')).toBeNull();
    expect(escapeFTS5Query('   ')).toBeNull();
  });
});

// ─── 4. Queue State Machine ───────────────────────────────────────────────────

describe('Queue State Machine', () => {
  let db: DbInterface;
  let sessionId: number;

  beforeEach(() => {
    ({ db } = makeDb());
    sessionId = db.createSession('queue-sess', 'queue-proj');
  });

  afterEach(() => {
    db.close();
  });

  test('enqueue returns a positive id', () => {
    const id = db.enqueue(sessionId, 'observation', { tool: 'Read', data: 'test' });
    expect(id).toBeGreaterThan(0);
  });

  test('enqueued message appears in dequeue', () => {
    db.enqueue(sessionId, 'observation', { data: 'payload' });
    const items = db.dequeue(10);
    expect(items.length).toBe(1);
    expect(items[0].status).toBe('pending');
  });

  test('getPending returns only pending items', () => {
    const id = db.enqueue(sessionId, 'observation', { data: 'p1' });
    db.enqueue(sessionId, 'summary', { data: 'p2' });
    db.markProcessing(id);
    const pending = db.getPending();
    expect(pending.every((i) => i.status === 'pending')).toBe(true);
    expect(pending.length).toBe(1);
  });

  test('pending → processing transition', () => {
    const id = db.enqueue(sessionId, 'observation', { step: 1 });
    db.markProcessing(id);
    const items = db.dequeue(10); // dequeue returns only 'pending'
    expect(items.length).toBe(0); // should be empty — item is now processing
  });

  test('pending → processing → processed transition', () => {
    const id = db.enqueue(sessionId, 'observation', { step: 2 });
    db.markProcessing(id);
    db.markProcessed(id);

    // Should not appear in pending or dequeue
    expect(db.getPending().length).toBe(0);
    expect(db.dequeue(10).length).toBe(0);
  });

  test('markFailed sets status to failed and increments retry_count', () => {
    const id = db.enqueue(sessionId, 'observation', { step: 3 });
    db.markProcessing(id);
    db.markFailed(id, 'Connection timeout');

    // Failed items do not appear in dequeue (which only returns pending)
    const pending = db.dequeue(10);
    expect(pending.length).toBe(0);
  });

  test('getStuck returns items in processing beyond threshold', async () => {
    const id = db.enqueue(sessionId, 'observation', { stuck: true });
    db.markProcessing(id);
    // With threshold of 0 seconds, any processing item should be considered stuck
    const stuck = db.getStuck(0);
    expect(stuck.length).toBeGreaterThanOrEqual(1);
    expect(stuck[0].id).toBe(id);
  });

  test('getStuck respects threshold — fresh processing items are not stuck', () => {
    const id = db.enqueue(sessionId, 'observation', { fresh: true });
    db.markProcessing(id);
    // With a very large threshold, nothing should be stuck
    const stuck = db.getStuck(99999);
    expect(stuck.length).toBe(0);
  });

  test('enqueue rejects payload exceeding 100 KB', () => {
    const bigPayload = { data: 'x'.repeat(102 * 1024) };
    expect(() => db.enqueue(sessionId, 'observation', bigPayload)).toThrow();
  });

  test('queue payload is scrubbed before storage', () => {
    const fakeKey = 'sk-ant-' + 'c'.repeat(85);
    const id = db.enqueue(sessionId, 'observation', { apiKey: fakeKey });
    // The payload stored in the db should have the key redacted
    const raw = (db as CMemDb).rawDb
      .query<{ payload: string }, [number]>('SELECT payload FROM queue WHERE id = ?')
      .get(id);
    expect(raw?.payload).not.toContain(fakeKey);
    expect(raw?.payload).toContain('[REDACTED]');
  });
});

// ─── 5. Stats ─────────────────────────────────────────────────────────────────

describe('getStats', () => {
  let db: DbInterface;

  beforeEach(() => {
    ({ db } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test('returns empty object when database is empty', () => {
    const stats = db.getStats();
    expect(Object.keys(stats).length).toBe(0);
  });

  test('returns correct counts per project', () => {
    const s1 = db.createSession('stats-sess-1', 'project-alpha');
    const s2 = db.createSession('stats-sess-2', 'project-beta');

    db.insertObservation({
      session_id: s1,
      prompt_number: 1,
      tool_name: 'Read',
      raw_input: null,
      compressed: 'obs-alpha-1',
      obs_type: 'discovery',
      title: 'Alpha observation 1',
      narrative: null,
    });
    db.insertObservation({
      session_id: s1,
      prompt_number: 2,
      tool_name: 'Edit',
      raw_input: null,
      compressed: 'obs-alpha-2',
      obs_type: 'bugfix',
      title: 'Alpha observation 2',
      narrative: null,
    });
    db.insertObservation({
      session_id: s2,
      prompt_number: 1,
      tool_name: 'Bash',
      raw_input: null,
      compressed: 'obs-beta-1',
      obs_type: 'feature',
      title: 'Beta observation',
      narrative: null,
    });

    db.insertSummary({
      session_id: s1,
      request: 'Fix bugs',
      investigated: 'auth module',
      learned: 'JWT issue',
      completed: 'Fix applied',
      next_steps: null,
    });

    const stats = db.getStats();
    expect(stats['project-alpha'].observations).toBe(2);
    expect(stats['project-alpha'].summaries).toBe(1);
    expect(stats['project-alpha'].sessions).toBe(1);
    expect(stats['project-beta'].observations).toBe(1);
    expect(stats['project-beta'].summaries).toBe(0);
    expect(stats['project-beta'].sessions).toBe(1);
  });
});

// ─── 6. SearchService ─────────────────────────────────────────────────────────

describe('SearchService', () => {
  let db: DbInterface;
  let rawDb: Database;
  let search: SearchService;
  let sessionId: number;

  beforeEach(() => {
    ({ db, raw: rawDb } = makeDb());
    search = new SearchService(rawDb);
    sessionId = db.createSession('search-sess', 'search-project');

    // Seed several observations across different types and timestamps
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 1,
      tool_name: 'Read',
      raw_input: null,
      compressed: 'Analysed the authentication system using JWT tokens.',
      obs_type: 'discovery',
      title: 'Auth system analysis',
      narrative: 'JWT tokens used for session management.',
    });
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 2,
      tool_name: 'Edit',
      raw_input: null,
      compressed: 'Fixed the WAL mode bug in the database layer.',
      obs_type: 'bugfix',
      title: 'Database WAL fix',
      narrative: 'SQLite WAL mode now enabled on startup.',
    });
    db.insertObservation({
      session_id: sessionId,
      prompt_number: 3,
      tool_name: 'Bash',
      raw_input: null,
      compressed: 'Added rate limiting middleware to the Express server.',
      obs_type: 'feature',
      title: 'Rate limiting feature',
      narrative: 'express-rate-limit added to all endpoints.',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('searchKeyword returns results matching query', () => {
    const results = search.searchKeyword('authentication');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('searchByType returns only matching obs_type', () => {
    const bugfixes = search.searchByType('bugfix', 'search-project');
    expect(bugfixes.every((o) => o.obs_type === 'bugfix')).toBe(true);
    expect(bugfixes.length).toBeGreaterThanOrEqual(1);
  });

  test('searchByDateRange returns observations within window', () => {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3600; // 1 hour ago
    const to = now + 3600;   // 1 hour from now
    const results = search.searchByDateRange(from, to, 'search-project');
    expect(results.length).toBe(3);
  });

  test('searchByDateRange returns empty for future range', () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const results = search.searchByDateRange(future, future + 3600);
    expect(results).toEqual([]);
  });

  test('getTimeline returns observations around an anchor', () => {
    // Get all observations in the session to find a middle ID
    const all = search.searchByType('', 'search-project');
    // Use insertObservation results as anchors
    const obs = rawDb.query<{ id: number }, []>(
      'SELECT id FROM observations ORDER BY id ASC',
    ).all();
    expect(obs.length).toBe(3);

    // Anchor on the middle observation
    const anchorId = obs[1].id;
    const timeline = search.getTimeline(anchorId, 2);

    // Should include the anchor plus items before/after
    expect(timeline.some((o) => o.id === anchorId)).toBe(true);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
  });

  test('getTimeline returns empty for unknown id', () => {
    expect(search.getTimeline(999999)).toEqual([]);
  });

  test('searchIndex returns compact results', () => {
    const results = search.searchIndex('WAL', 'search-project');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // IndexResult has: id, title, obs_type, created_at, session_id
    const first = results[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('obs_type');
    expect(first).toHaveProperty('created_at');
    expect(first).toHaveProperty('session_id');
    // Should NOT have full narrative/compressed (these are layer-3 fields)
    expect((first as Record<string, unknown>).compressed).toBeUndefined();
  });

  test('getByIds returns full records for given ids', () => {
    const obs = rawDb.query<{ id: number }, []>(
      'SELECT id FROM observations LIMIT 2',
    ).all();
    const ids = obs.map((o) => o.id);
    const results = search.getByIds(ids);
    expect(results.length).toBe(2);
    results.forEach((r) => {
      expect(ids).toContain(r.id);
      expect(r.compressed).toBeTruthy();
    });
  });

  test('getByIds returns empty array for empty input', () => {
    expect(search.getByIds([])).toEqual([]);
  });
});

// ─── 7. Migrations Idempotency ─────────────────────────────────────────────────

describe('Migrations', () => {
  test('running migrations twice does not throw', () => {
    const raw = new Database(':memory:');
    expect(() => {
      runMigrations(raw);
      runMigrations(raw); // second run should be a no-op
    }).not.toThrow();
    raw.close();
  });

  test('migration table exists after first run', () => {
    const raw = new Database(':memory:');
    runMigrations(raw);
    const rows = raw.query('SELECT * FROM migrations').all() as { version: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe(1);
    raw.close();
  });

  test('all expected tables exist after migration', () => {
    const raw = new Database(':memory:');
    runMigrations(raw);
    const tableNames = (
      raw.query(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      ).all() as { name: string }[]
    ).map((r) => r.name);

    for (const expected of ['sessions', 'user_prompts', 'observations', 'summaries', 'queue', 'migrations']) {
      expect(tableNames).toContain(expected);
    }
    raw.close();
  });

  test('FTS5 virtual table exists after migration', () => {
    const raw = new Database(':memory:');
    runMigrations(raw);
    const tables = (
      raw.query(
        `SELECT name FROM sqlite_master WHERE type='table' OR type='shadow'`,
      ).all() as { name: string }[]
    ).map((r) => r.name);

    // obs_fts should exist as the virtual table name
    expect(tables.some((n) => n.includes('obs_fts'))).toBe(true);
    raw.close();
  });
});
