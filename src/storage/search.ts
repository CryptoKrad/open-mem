/**
 * Open-Mem Search Service
 *
 * Implements the 3-layer progressive disclosure search API:
 *
 *   Layer 1 — searchIndex()    → compact results (~50-100 tokens each)
 *   Layer 2 — getTimeline()    → chronological context window
 *   Layer 3 — getByIds()       → full observation details on demand
 *
 * Phase 1: FTS5 keyword search (no external deps)
 * Phase 2: QMD semantic search (via shell-out to qmd CLI)
 *
 * Security requirements:
 *  - FTS5 queries are escaped via escapeFTS5Query() before use
 *  - Project names for QMD export are validated against /^[a-zA-Z0-9_-]+$/
 *  - Shell arguments are never interpolated; argv arrays are used throughout
 *  - Export directory traversal is prevented by the project name validation
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import type { Database } from 'bun:sqlite';
import type { Observation, IndexResult } from './types.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const QMD_EXPORT_ROOT = join(homedir(), '.open-mem', 'qmd-export');

/** Safe project name — no path traversal, no shell injection */
const SAFE_PROJECT_RE = /^[a-zA-Z0-9_-]+$/;

// ─── FTS5 Query Escaping ─────────────────────────────────────────────────────

/**
 * Escape user-supplied text for safe use in an FTS5 MATCH phrase expression.
 * Special FTS5 chars — " ' * : . ( ) ^ - + — are neutralised by wrapping
 * the whole query in double-quotes after escaping internal double-quotes.
 *
 * Returns null when the query is empty (caller should skip FTS entirely).
 */
function escapeFTS5(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  // Double any internal double-quotes per FTS5 phrase escape rules
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/**
 * Build an FTS5 prefix query for a single keyword token.
 * Used internally for prefix/autocomplete-style search.
 */
function escapeFTS5Prefix(token: string): string | null {
  const trimmed = token.trim().replace(/['"*:()\^.+\-]/g, ' ').trim();
  if (!trimmed) return null;
  // Each space-separated word becomes a separate prefix token
  return trimmed
    .split(/\s+/)
    .map((w) => `${w}*`)
    .join(' ');
}

// ─── Search Service ───────────────────────────────────────────────────────────

export class SearchService {
  private readonly _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  // ─── Phase 1: FTS5 Keyword Search ────────────────────────────────────────

  /**
   * Keyword search using FTS5 MATCH.
   * Returns full Observation records ranked by BM25 relevance.
   */
  searchKeyword(query: string, project?: string, limit = 20): Observation[] {
    const safeQuery = escapeFTS5(query);
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

  /**
   * Filter observations by obs_type. No FTS involved — pure indexed lookup.
   */
  searchByType(type: string, project?: string, limit = 50): Observation[] {
    if (project) {
      return this._db.query<Observation, [string, string, number]>(
        `SELECT o.*
         FROM observations o
         JOIN sessions s ON s.id = o.session_id
         WHERE o.obs_type = ?
           AND s.project = ?
         ORDER BY o.created_at DESC
         LIMIT ?`,
      ).all(type, project, limit);
    }

    return this._db.query<Observation, [string, number]>(
      `SELECT o.*
       FROM observations o
       WHERE o.obs_type = ?
       ORDER BY o.created_at DESC
       LIMIT ?`,
    ).all(type, limit);
  }

  /**
   * Filter observations by a created_at date range (Unix epoch seconds).
   * Both `from` and `to` are inclusive.
   */
  searchByDateRange(from: number, to: number, project?: string): Observation[] {
    if (project) {
      return this._db.query<Observation, [number, number, string]>(
        `SELECT o.*
         FROM observations o
         JOIN sessions s ON s.id = o.session_id
         WHERE o.created_at >= ?
           AND o.created_at <= ?
           AND s.project = ?
         ORDER BY o.created_at ASC`,
      ).all(from, to, project);
    }

    return this._db.query<Observation, [number, number]>(
      `SELECT o.*
       FROM observations o
       WHERE o.created_at >= ?
         AND o.created_at <= ?
       ORDER BY o.created_at ASC`,
    ).all(from, to);
  }

  /**
   * Layer 2 — Timeline window around a specific observation ID.
   * Returns up to `windowSize` observations before AND after the anchor.
   * Results are ordered chronologically (oldest → newest).
   */
  getTimeline(observationId: number, windowSize = 5): Observation[] {
    const anchor = this._db.query<{ session_id: number; created_at: number }, [number]>(
      'SELECT session_id, created_at FROM observations WHERE id = ?',
    ).get(observationId);

    if (!anchor) return [];

    const before = this._db.query<Observation, [number, number, number]>(
      `SELECT * FROM observations
       WHERE session_id = ?
         AND created_at <= ?
         AND id != ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(anchor.session_id, anchor.created_at, observationId, windowSize);

    const after = this._db.query<Observation, [number, number, number]>(
      `SELECT * FROM observations
       WHERE session_id = ?
         AND created_at >= ?
         AND id != ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(anchor.session_id, anchor.created_at, observationId, windowSize);

    // Anchor itself
    const anchorRow = this._db.query<Observation, [number]>(
      'SELECT * FROM observations WHERE id = ?',
    ).get(observationId);

    // Combine: before (reversed to chronological) + anchor + after
    const combined: Observation[] = [
      ...before.reverse(),
      ...(anchorRow ? [anchorRow] : []),
      ...after,
    ];

    return combined;
  }

  // ─── Layer 1: Compact Index ────────────────────────────────────────────────

  /**
   * Layer 1 search — returns compact index results (~50-100 tokens each).
   * Each result contains only: id, title, obs_type, created_at, session_id.
   * Callers use these lightweight results to decide which IDs to fetch in full.
   */
  searchIndex(query: string, project?: string): IndexResult[] {
    const safeQuery = escapeFTS5(query);
    if (!safeQuery) return [];

    if (project) {
      return this._db.query<IndexResult, [string, string]>(
        `SELECT o.id, o.title, o.obs_type, o.created_at, o.session_id
         FROM obs_fts
         JOIN observations o ON o.id = obs_fts.rowid
         JOIN sessions s     ON s.id = o.session_id
         WHERE obs_fts MATCH ?
           AND s.project = ?
         ORDER BY rank
         LIMIT 50`,
      ).all(safeQuery, project);
    }

    return this._db.query<IndexResult, [string]>(
      `SELECT o.id, o.title, o.obs_type, o.created_at, o.session_id
       FROM obs_fts
       JOIN observations o ON o.id = obs_fts.rowid
       WHERE obs_fts MATCH ?
       ORDER BY rank
       LIMIT 50`,
    ).all(safeQuery);
  }

  // ─── Layer 3: Fetch by IDs ─────────────────────────────────────────────────

  /**
   * Layer 3 — Fetch full observation details for a list of IDs.
   * Uses a prepared query with individual ID parameters to avoid any
   * risk of SQL injection through dynamic IN-clause construction.
   *
   * For large ID lists (>50) consider paginating through getObservation().
   */
  getByIds(ids: number[]): Observation[] {
    if (ids.length === 0) return [];

    // Build a safe parameterized IN clause: (?, ?, ..., ?)
    const placeholders = ids.map(() => '?').join(', ');
    // Cast is necessary because bun:sqlite query typing doesn't accept spread arrays
    return this._db.query<Observation, number[]>(
      `SELECT * FROM observations
       WHERE id IN (${placeholders})
       ORDER BY created_at ASC`,
    ).all(...ids);
  }

  // ─── Phase 2: QMD Semantic Search ─────────────────────────────────────────

  /**
   * Export observations for a project as markdown files into the QMD export
   * directory, then trigger `qmd update && qmd embed` to index them.
   *
   * Files are written to: ~/.open-mem/qmd-export/{project}/{id}-{slug}.md
   * with YAML frontmatter for QMD metadata.
   *
   * Security: project name must match /^[a-zA-Z0-9_-]+$/ to prevent traversal.
   */
  exportToQMD(project: string, observations: Observation[]): void {
    validateProjectName(project);

    const exportDir = join(QMD_EXPORT_ROOT, project);
    mkdirSync(exportDir, { recursive: true, mode: 0o700 });

    for (const obs of observations) {
      const slug = slugify(obs.title ?? obs.tool_name, obs.id);
      const filename = `${obs.id}-${slug}.md`;
      const filePath = join(exportDir, filename);

      const date = new Date(obs.created_at * 1000).toISOString().slice(0, 10);
      const content = [
        '---',
        `id: ${obs.id}`,
        `type: ${obs.obs_type}`,
        `tool: ${obs.tool_name}`,
        `date: ${date}`,
        `project: ${project}`,
        '---',
        '',
        `# ${obs.title ?? obs.tool_name}`,
        '',
        obs.narrative ? `${obs.narrative}\n` : '',
        obs.compressed ? `## Details\n\n${obs.compressed}\n` : '',
      ].join('\n');

      writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    }

    // Trigger QMD indexing — non-fatal if qmd is not installed
    const collectionName = `c-mem-${project}`;

    const updateResult = spawnSync('qmd', ['update'], { encoding: 'utf-8' });
    if (updateResult.error) {
      console.warn('[Open-Mem] qmd update failed (QMD not installed?):', updateResult.error.message);
      return;
    }

    const embedResult = spawnSync('qmd', ['embed', '-c', collectionName], {
      encoding: 'utf-8',
    });
    if (embedResult.error) {
      console.warn('[Open-Mem] qmd embed failed:', embedResult.error.message);
    }
  }

  /**
   * Semantic search via QMD.
   * Shells out to: qmd query '<query>' -c c-mem-{project}
   * Parses the output to extract matching observation IDs.
   *
   * Returns an array of observation IDs (parsed from QMD result lines).
   * Callers should use getByIds() to fetch full records.
   *
   * Security: query and project are passed as argv elements, never interpolated.
   */
  searchSemantic(query: string, project?: string): number[] {
    const args: string[] = ['query', query];
    if (project) {
      validateProjectName(project);
      args.push('-c', `c-mem-${project}`);
    }

    const result = spawnSync('qmd', args, { encoding: 'utf-8' });
    if (result.error || result.status !== 0) {
      // QMD unavailable — graceful degradation: return empty
      return [];
    }

    // Parse QMD output: each line may contain a file path like
    // ~/.open-mem/qmd-export/{project}/{id}-{slug}.md
    const idSet = new Set<number>();
    const stdout = result.stdout ?? '';
    for (const line of stdout.split('\n')) {
      const match = line.match(/\/(\d+)-[^/]+\.md/);
      if (match) {
        const id = parseInt(match[1], 10);
        if (!isNaN(id)) idSet.add(id);
      }
    }
    return Array.from(idSet);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate a project name for safe use in file system paths.
 * Rejects anything with characters that could enable path traversal.
 */
function validateProjectName(project: string): void {
  if (!SAFE_PROJECT_RE.test(project)) {
    throw new Error(
      `Invalid project name "${project}". ` +
        'Project names must match /^[a-zA-Z0-9_-]+$/ (no slashes, dots, or spaces).',
    );
  }
}

/**
 * Convert a title + id into a safe file-system slug.
 * Keeps only alphanumeric, hyphens, underscores; truncates at 60 chars.
 */
function slugify(title: string, id: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || String(id);
}
