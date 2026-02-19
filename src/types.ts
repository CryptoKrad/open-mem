/**
 * Open-Mem Shared Type Definitions
 *
 * NOTE (Builder B → Builder A):
 *   This file was authored by Builder B since Builder A's types.ts
 *   was not yet available. Builder A must match or extend these interfaces.
 *   Do not remove or rename any exported symbol without coordinating.
 *
 * NOTE (Builder B → Builder C):
 *   ISessionStore and ISessionSearch below are the contracts Builder C
 *   must implement in src/storage/db.ts.
 */

// ───────────────────────────────────────────────────────
// Hook I/O Types (Builder A)
// ───────────────────────────────────────────────────────

/** Input received by all Open-Mem hooks from Claude Code / OpenClaw via stdin */
export interface HookInput {
  session_id: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: string;
  cwd?: string;
  transcript_path?: string;
  [key: string]: unknown;
}

/** Output written to stdout by all Open-Mem hooks */
export interface HookOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
}

// ───────────────────────────────────────────────────────
// Worker Configuration (Builder A)
// ───────────────────────────────────────────────────────

/** Configuration shape loaded by src/config.ts */
export interface WorkerConfig {
  port: number;
  bindHost: string;
  dbPath: string;
  model: string;
  maxObsPerContext: number;
  maxSessionsPerContext: number;
  maxRetries: number;
  stuckThresholdMs: number;
}

// ───────────────────────────────────────────────────────
// Observation Type (Builder A/C shared)
// ───────────────────────────────────────────────────────

/** Controlled vocabulary for observation classification */
export type ObservationType =
  | "bugfix"
  | "feature"
  | "refactor"
  | "config"
  | "research"
  | "error"
  | "decision"
  | "other";

// ───────────────────────────────────────────────────────
// Core Domain Types
// ───────────────────────────────────────────────────────

export interface Session {
  id: number;
  session_id: string;
  /** Builder C alias for session_id (used by summarizer/prompts) */
  claude_session_id?: string;
  project: string;
  status: "active" | "completed";
  prompt_counter: number;
  created_at: string;
  created_at_epoch: number;
  completed_at?: string;
}

export interface Observation {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  tool_name: string;
  type: string; // bugfix | feature | refactor | discovery | decision | change
  title: string;
  narrative: string;
  tags: string; // JSON array
  facts: string; // JSON array
  files_read: string; // JSON array
  files_modified: string; // JSON array
  created_at: string;
  created_at_epoch: number;
}

// ───────────────────────────────────────────────────────
// Summary Types (Builder C storage shape)
// ───────────────────────────────────────────────────────

/**
 * Summary as stored in the Builder C storage layer.
 * session_id is the DB numeric FK, not the string Claude session ID.
 */
export interface Summary {
  id: number;
  session_id: number;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: number; // Unix epoch seconds
}

/** Input passed to summarizeSession() in Builder A's summarizer */
export interface SummarizeInput {
  session_id: string; // Claude session ID (string)
  project: string;
  observations: Observation[];
  prompt_number?: number;
  last_user_message?: string;
  last_assistant_message?: string;
}

export interface SessionSummary {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  request: string;
  work_done: string;
  discoveries: string;
  remaining: string;
  notes: string;
  created_at: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export type QueueStatus = "pending" | "processing" | "processed" | "failed";

export interface QueueItem {
  id: number;
  session_id: string;
  status: QueueStatus;
  tool_name: string;
  tool_input: string; // JSON string
  tool_response: string; // Truncated tool response text
  retry_count: number;
  created_at_epoch: number;
  started_at_epoch?: number;
  completed_at_epoch?: number;
  error_message?: string;
}

// ───────────────────────────────────────────────────────
// Storage Interface Contracts (Builder C implements)
// ───────────────────────────────────────────────────────

export interface ISessionStore {
  // Sessions
  createSession(
    sessionId: string,
    project: string,
    firstPrompt: string
  ): number;
  getSession(sessionId: string): Session | null;
  getSessionById(id: number): Session | null;
  listSessions(project?: string, limit?: number, offset?: number): Session[];
  updateSessionStatus(sessionId: string, status: "active" | "completed"): void;
  incrementPromptCounter(sessionId: string): number;

  // Observations
  createObservation(obs: Omit<Observation, "id">): number;
  getObservation(id: number): Observation | null;
  getObservations(
    project?: string,
    limit?: number,
    offset?: number
  ): { observations: Observation[]; total: number };
  getObservationsByIds(ids: number[]): Observation[];
  getObservationsBySession(sessionId: string): Observation[];

  // Summaries
  createSummary(summary: Omit<SessionSummary, "id">): number;
  getSummaries(
    project?: string,
    limit?: number,
    offset?: number
  ): { summaries: SessionSummary[]; total: number };
  getSummariesBySession(sessionId: string): SessionSummary[];

  // User prompts
  createUserPrompt(prompt: Omit<UserPrompt, "id">): number;

  // Queue
  enqueueObservation(
    sessionId: string,
    toolName: string,
    toolInput: string,
    toolResponse: string
  ): number;
  getPendingQueueItems(limit?: number): QueueItem[];
  getQueueItem(id: number): QueueItem | null;
  updateQueueStatus(
    id: number,
    status: QueueStatus,
    errorMessage?: string
  ): void;
  getQueueCounts(): {
    pending: number;
    processing: number;
    failed: number;
    stuck: number;
  };
  getStuckItems(thresholdMs: number): QueueItem[];
  resetStuckItems(thresholdMs: number): number;
  incrementRetryCount(id: number): number;

  // Stats
  getStats(project?: string): Record<string, number>;
}

export interface SearchFilters {
  project?: string;
  type?: string;
  dateStart?: number;
  dateEnd?: number;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  id: number;
  title: string;
  type: string;
  project: string;
  created_at_epoch: number;
  rank: number;
  snippet?: string;
}

export interface ContextResult {
  markdown: string;
  observationCount: number;
  summaryCount: number;
  tokenEstimate: number;
}

export interface ISessionSearch {
  searchObservations(
    query: string,
    filters?: SearchFilters
  ): SearchResult[];
  searchSummaries(query: string, filters?: SearchFilters): SearchResult[];
  getRecentContext(
    project: string,
    limit: number,
    sessionCount: number
  ): ContextResult;
}

// ───────────────────────────────────────────────────────
// SDK / Compression Interface (Builder A implements)
// ───────────────────────────────────────────────────────

export interface RawObservation {
  tool_name: string;
  tool_input: unknown;
  tool_response: string;
  project: string;
  prompt_number: number;
  user_goal: string;
}

export interface CompressedObservation {
  type: string;
  title: string;
  narrative: string;
  tags: string[];
  facts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface LastMessages {
  last_user?: string;
  last_assistant?: string;
}

export interface ICompressionAgent {
  compressObservation(raw: RawObservation): Promise<CompressedObservation>;
  summarizeSession(
    sessionId: string,
    observations: Observation[],
    lastMessages: LastMessages
  ): Promise<SessionSummary>;
}

// ───────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────

export interface CMemConfig {
  workerPort: number;
  workerHost: string;
  dataDir: string;
  model: string;
  contextObservations: number;
  contextSessions: number;
  skipTools: Set<string>;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  stuckThresholdMs: number;
  maxRetries: number;
  maxBodyBytes: number;
  rateLimit: number; // req/s per IP
}

export const DEFAULT_CONFIG: CMemConfig = {
  workerPort: 37888,
  workerHost: "127.0.0.1",
  dataDir: `${process.env["HOME"] ?? "/tmp"}/.open-mem`,
  model: "claude-sonnet-4-5",
  contextObservations: 50,
  contextSessions: 10,
  skipTools: new Set([
    "TodoWrite",
    "AskUserQuestion",
    "SlashCommand",
    "ListMcpResourcesTool",
  ]),
  logLevel: "INFO",
  stuckThresholdMs: 5 * 60 * 1000, // 5 minutes
  maxRetries: 3,
  maxBodyBytes: 100 * 1024, // 100KB
  rateLimit: 100,
};

// ───────────────────────────────────────────────────────
// HTTP API Request / Response shapes
// ───────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  uptime: number;
  port: number;
  tokenPath?: string;
  queue?: {
    pending: number;
    processing: number;
    failed: number;
    stuck: number;
  };
}

export interface SessionInitBody {
  project: string;
  userPrompt: string;
  promptNumber?: number;
}

export interface ObservationBody {
  tool_name: string;
  tool_input: unknown;
  /** Canonical field name for the tool response text */
  tool_response?: string;
  /** Legacy alias accepted for backward compatibility */
  tool_result?: string;
  correlation_id?: string;
}

export interface SummarizeBody {
  last_user_message?: string;
  last_assistant_message?: string;
}

export interface CompleteBody {
  reason?: string;
}

export interface BatchObservationsBody {
  ids: number[];
  orderBy?: "date_asc" | "date_desc";
  limit?: number;
}

export interface QueueRecoverBody {
  sessionId?: string; // optional: recover only for a specific session
}
