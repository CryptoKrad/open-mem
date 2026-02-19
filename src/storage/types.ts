/**
 * Open-Mem Storage Types
 * Core data types for the storage layer.
 * These are the database record shapes — not the full shared/interfaces.ts contracts.
 */

// ─── Session ────────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'summarizing' | 'completed';

export interface Session {
  id: number;
  claude_session_id: string;
  project: string;
  first_prompt: string | null;
  prompt_counter: number;
  status: SessionStatus;
  created_at: number; // Unix epoch seconds
  completed_at: number | null;
}

// ─── Observation ─────────────────────────────────────────────────────────────

export interface Observation {
  id: number;
  session_id: number;
  prompt_number: number;
  tool_name: string;
  raw_input: string | null; // scrubbed before storage
  compressed: string;
  obs_type: string;
  title: string | null;
  narrative: string | null;
  created_at: number; // Unix epoch seconds
  hmac: string | null; // HMAC-SHA256 signature for integrity (INJ-04)
}

// ─── User Prompt ─────────────────────────────────────────────────────────────

export interface UserPrompt {
  id: number;
  session_id: number;
  prompt_number: number;
  prompt: string;
  created_at: number;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface Summary {
  id: number;
  session_id: number;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: number;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export type QueueMessageType = 'observation' | 'summary';
export type QueueStatus = 'pending' | 'processing' | 'processed' | 'failed';

export interface QueueMessage {
  id: number;
  session_id: number;
  message_type: QueueMessageType;
  payload: string; // JSON string
  status: QueueStatus;
  retry_count: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** Compact search result returned from Layer 1 of the progressive disclosure API */
export interface IndexResult {
  id: number;
  title: string | null;
  obs_type: string;
  created_at: number;
  session_id: number;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface ProjectStats {
  observations: number;
  summaries: number;
  sessions: number;
}
