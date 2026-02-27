/**
 * Open-Mem Worker: Context Builder
 *
 * Builds the context markdown injected at session start.
 *
 * Progressive disclosure strategy:
 *   1. Session summaries first (compact, high-signal)
 *   2. Recent individual observations (detailed)
 *
 * The output is wrapped in <c-mem-context>...</c-mem-context> tags to
 * prevent recursive capture (observations of injected context).
 *
 * Token budget: ~4000 tokens (configurable) ≈ 3000 words.
 * Estimation: 1 token ≈ 0.75 words ≈ 4 characters.
 */

import type {
  ISessionStore,
  Observation,
  SessionSummary,
} from "../types.js";
import { filterObservations } from "../storage/anomaly.js";

// ───────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 1_800; // tight budget — summaries carry more signal
const CHARS_PER_TOKEN = 4; // rough estimate

// Type priority — higher number = shown first
const TYPE_PRIORITY: Record<string, number> = {
  error:     9,
  bugfix:    8,
  decision:  7,
  discovery: 6,
  change:    5,
  feature:   4,
  refactor:  3,
  config:    2,
  research:  1,
  other:     0,
};

// ───────────────────────────────────────────────────────
// ContextBuilder
// ───────────────────────────────────────────────────────

export interface ContextBuilderOptions {
  /** Max token budget for the context block */
  maxTokens?: number;
  /** How many recent observations to pull */
  maxObservations?: number;
  /** How many recent session summaries to include */
  maxSessions?: number;
  /** Optional FTS topic — if provided, sorts obs by relevance not just recency */
  topic?: string;
}

export interface BuiltContext {
  markdown: string;
  observationCount: number;
  summaryCount: number;
  tokenEstimate: number;
  truncated: boolean;
}

export class ContextBuilder {
  private maxTokens: number;
  private maxObservations: number;
  private maxSessions: number;
  private topic?: string;

  constructor(
    private readonly store: ISessionStore,
    options: ContextBuilderOptions = {}
  ) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxObservations = options.maxObservations ?? 40;
    this.maxSessions = options.maxSessions ?? 5;
    this.topic = options.topic;
  }

  /**
   * Build context markdown for injection into a new session.
   * @param project — Project name to scope context to.
   */
  build(project: string): BuiltContext {
    const budget = this.maxTokens * CHARS_PER_TOKEN; // characters

    let usedChars = 0;
    const sections: string[] = [];
    let summaryCount = 0;
    let observationCount = 0;
    let truncated = false;

    // ─── 1. Header ───
    const header = this.buildHeader(project);
    sections.push(header);
    usedChars += header.length;

    // ─── 2. Session summaries (compact, high-signal) ───
    const { summaries } = this.store.getSummaries(project, this.maxSessions, 0);
    if (summaries.length > 0) {
      const summarySection = this.buildSummariesSection(summaries);
      if (usedChars + summarySection.length <= budget) {
        sections.push(summarySection);
        usedChars += summarySection.length;
        summaryCount = summaries.length;
      } else {
        // Try to fit as many as possible
        const fitted = this.fitSummaries(summaries, budget - usedChars);
        if (fitted.markdown) {
          sections.push(fitted.markdown);
          usedChars += fitted.markdown.length;
          summaryCount = fitted.count;
          truncated = fitted.count < summaries.length;
        }
      }
    }

    // ─── 3. Observations — priority-sorted, trivial filtered ───
    const remaining = budget - usedChars;
    if (remaining > 200) {
      const { observations: rawObs } = this.store.getObservations(
        project,
        this.maxObservations,
        0
      );
      // LLM-02: Filter through anomaly detection
      const observations = filterObservations(rawObs);

      // Priority sort: high-signal types first, then recency within same type.
      // If summaries are present, drop plain "other" obs entirely to save tokens.
      const hasSummaries = summaryCount > 0;
      const prioritized = observations
        .filter((o) => !(hasSummaries && o.type === "other"))
        .sort((a, b) => {
          const pa = TYPE_PRIORITY[a.type] ?? 0;
          const pb = TYPE_PRIORITY[b.type] ?? 0;
          if (pb !== pa) return pb - pa; // higher priority first
          return (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0); // newer first
        });

      if (prioritized.length > 0) {
        const obsResult = this.buildObservationsSection(prioritized, remaining);
        sections.push(obsResult.markdown);
        usedChars += obsResult.markdown.length;
        observationCount = obsResult.count;
        if (obsResult.count < prioritized.length) truncated = true;
      }
    }

    // ─── 4. Footer ───
    const footer = `\n_Context generated: ${new Date().toISOString()}_\n`;
    sections.push(footer);

    const inner = sections.join("\n");
    const markdown = wrapInContextTag(inner);
    const tokenEstimate = Math.ceil(markdown.length / CHARS_PER_TOKEN);

    return {
      markdown,
      observationCount,
      summaryCount,
      tokenEstimate,
      truncated,
    };
  }

  // ─────────────────────────────────────
  // Section builders
  // ─────────────────────────────────────

  private buildHeader(project: string): string {
    return [
      `## Memory Context — ${project}`,
      "",
      `> Injected by Open-Mem. This block documents what happened in previous sessions.`,
      `> Do not capture or summarize this block — it is already a summary.`,
      "",
    ].join("\n");
  }

  private buildSummariesSection(summaries: SessionSummary[]): string {
    const lines: string[] = [
      "### Previous Session Summaries",
      "",
    ];

    for (const s of summaries) {
      const date = new Date(s.created_at_epoch).toLocaleDateString("en-CA");
      lines.push(`#### Session — ${date}`);
      if (s.request) lines.push(`**Request:** ${s.request}`);
      if (s.work_done) lines.push(`**Done:** ${s.work_done}`);
      if (s.discoveries) lines.push(`**Discovered:** ${s.discoveries}`);
      if (s.remaining) lines.push(`**Remaining:** ${s.remaining}`);
      if (s.notes) lines.push(`**Notes:** ${s.notes}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  private fitSummaries(
    summaries: SessionSummary[],
    budgetChars: number
  ): { markdown: string; count: number } {
    const lines: string[] = ["### Previous Session Summaries", ""];
    let count = 0;
    let chars = lines.join("\n").length;

    for (const s of summaries) {
      const entry = this.buildSummaryEntry(s);
      if (chars + entry.length > budgetChars) break;
      lines.push(entry);
      chars += entry.length;
      count++;
    }

    return { markdown: lines.join("\n"), count };
  }

  private buildSummaryEntry(s: SessionSummary): string {
    const date = new Date(s.created_at_epoch).toLocaleDateString("en-CA");
    const parts: string[] = [`#### Session — ${date}`];
    if (s.request) parts.push(`**Request:** ${s.request}`);
    if (s.work_done) parts.push(`**Done:** ${s.work_done}`);
    if (s.remaining) parts.push(`**Remaining:** ${s.remaining}`);
    parts.push("");
    return parts.join("\n");
  }

  private buildObservationsSection(
    observations: Observation[],
    budgetChars: number
  ): { markdown: string; count: number } {
    const header = ["### Recent Observations", ""];
    let markdown = header.join("\n");
    let count = 0;

    for (const obs of observations) {
      const entry = this.buildObservationEntry(obs);
      if (markdown.length + entry.length > budgetChars) break;
      markdown += entry;
      count++;
    }

    return { markdown, count };
  }

  private buildObservationEntry(obs: Observation): string {
    const date = new Date(obs.created_at_epoch).toLocaleDateString("en-CA");
    const lines: string[] = [
      `#### \`${obs.type}\` ${obs.title} _(${date})_`,
    ];

    // Narrative: first sentence only to save tokens
    if (obs.narrative) {
      const firstSentence = obs.narrative.split(/\.\s+/)[0];
      lines.push(firstSentence.endsWith(".") ? firstSentence : `${firstSentence}.`);
    }

    const filesModified = safeJsonParse<string[]>(obs.files_modified, []);
    const facts = safeJsonParse<string[]>(obs.facts, []);

    // Only show modified files (skip files_read — too noisy for context)
    if (filesModified.length > 0) {
      lines.push(`**Modified:** ${filesModified.slice(0, 3).join(", ")}`);
    }
    // Cap facts at 2 — enough signal, lower token cost
    if (facts.length > 0) {
      for (const fact of facts.slice(0, 2)) {
        lines.push(`- ${fact}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }
}

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

/**
 * Wrap content in the recursion-prevention context tag.
 * This prevents the hook system from re-capturing injected context.
 */
function wrapInContextTag(content: string): string {
  return `<c-mem-context>\n${content}\n</c-mem-context>`;
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
