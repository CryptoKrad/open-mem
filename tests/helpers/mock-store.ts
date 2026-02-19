/**
 * Test helper: MockSessionStore
 *
 * A standalone in-memory implementation of ISessionStore for use in tests.
 * Mirrors the mock in src/storage/db.ts but is fully accessible for assertions.
 */

import type {
  ISessionStore,
  Session,
  Observation,
  SessionSummary,
  UserPrompt,
  QueueItem,
  QueueStatus,
} from "../../src/types.js";

export class MockSessionStore implements ISessionStore {
  readonly sessions = new Map<string, Session>();
  readonly sessionsByDbId = new Map<number, Session>();
  readonly observations = new Map<number, Observation>();
  readonly summaries = new Map<number, SessionSummary>();
  readonly userPrompts = new Map<number, UserPrompt>();
  readonly queue = new Map<number, QueueItem>();

  private _nextId = 1;
  get nextId(): number {
    return this._nextId;
  }

  private alloc(): number {
    return this._nextId++;
  }

  // ─── Sessions ───

  createSession(
    sessionId: string,
    project: string,
    firstPrompt: string
  ): number {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!.id;
    }
    const id = this.alloc();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      session_id: sessionId,
      project,
      status: "active",
      prompt_counter: 1,
      created_at: now,
      created_at_epoch: Date.now(),
    };
    this.sessions.set(sessionId, session);
    this.sessionsByDbId.set(id, session);
    this.createUserPrompt({
      session_id: sessionId,
      project,
      prompt_number: 1,
      prompt_text: firstPrompt,
      created_at: now,
      created_at_epoch: Date.now(),
    });
    return id;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getSessionById(id: number): Session | null {
    return this.sessionsByDbId.get(id) ?? null;
  }

  listSessions(project?: string, limit = 50, offset = 0): Session[] {
    let all = [...this.sessions.values()];
    if (project) all = all.filter((s) => s.project === project);
    return all.slice(offset, offset + limit);
  }

  updateSessionStatus(
    sessionId: string,
    status: "active" | "completed"
  ): void {
    const s = this.sessions.get(sessionId);
    if (s) s.status = status;
  }

  incrementPromptCounter(sessionId: string): number {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    s.prompt_counter++;
    return s.prompt_counter;
  }

  // ─── Observations ───

  createObservation(obs: Omit<Observation, "id">): number {
    const id = this.alloc();
    this.observations.set(id, { ...obs, id });
    return id;
  }

  getObservation(id: number): Observation | null {
    return this.observations.get(id) ?? null;
  }

  getObservations(
    project?: string,
    limit = 20,
    offset = 0
  ): { observations: Observation[]; total: number } {
    let all = [...this.observations.values()];
    if (project) all = all.filter((o) => o.project === project);
    all.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    return { observations: all.slice(offset, offset + limit), total: all.length };
  }

  getObservationsByIds(ids: number[]): Observation[] {
    return ids
      .map((id) => this.observations.get(id))
      .filter((o): o is Observation => o !== undefined);
  }

  getObservationsBySession(sessionId: string): Observation[] {
    return [...this.observations.values()].filter(
      (o) => o.session_id === sessionId
    );
  }

  // ─── Summaries ───

  createSummary(summary: Omit<SessionSummary, "id">): number {
    const id = this.alloc();
    this.summaries.set(id, { ...summary, id });
    return id;
  }

  getSummaries(
    project?: string,
    limit = 20,
    offset = 0
  ): { summaries: SessionSummary[]; total: number } {
    let all = [...this.summaries.values()];
    if (project) all = all.filter((s) => s.project === project);
    all.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    return { summaries: all.slice(offset, offset + limit), total: all.length };
  }

  getSummariesBySession(sessionId: string): SessionSummary[] {
    return [...this.summaries.values()].filter(
      (s) => s.session_id === sessionId
    );
  }

  // ─── User Prompts ───

  createUserPrompt(prompt: Omit<UserPrompt, "id">): number {
    const id = this.alloc();
    this.userPrompts.set(id, { ...prompt, id });
    return id;
  }

  // ─── Queue ───

  enqueueObservation(
    sessionId: string,
    toolName: string,
    toolInput: string,
    toolResponse: string
  ): number {
    const id = this.alloc();
    const item: QueueItem = {
      id,
      session_id: sessionId,
      status: "pending",
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      retry_count: 0,
      created_at_epoch: Date.now(),
    };
    this.queue.set(id, item);
    return id;
  }

  getPendingQueueItems(limit = 50): QueueItem[] {
    return [...this.queue.values()]
      .filter((i) => i.status === "pending")
      .sort((a, b) => a.created_at_epoch - b.created_at_epoch)
      .slice(0, limit);
  }

  getQueueItem(id: number): QueueItem | null {
    return this.queue.get(id) ?? null;
  }

  updateQueueStatus(
    id: number,
    status: QueueStatus,
    errorMessage?: string
  ): void {
    const item = this.queue.get(id);
    if (!item) return;
    item.status = status;
    if (errorMessage !== undefined) item.error_message = errorMessage;
    if (status === "processing") item.started_at_epoch = Date.now();
    if (status === "processed" || status === "failed")
      item.completed_at_epoch = Date.now();
  }

  getQueueCounts(): {
    pending: number;
    processing: number;
    failed: number;
    stuck: number;
  } {
    const all = [...this.queue.values()];
    const stuckCutoff = Date.now() - 5 * 60 * 1_000;
    return {
      pending: all.filter((i) => i.status === "pending").length,
      processing: all.filter((i) => i.status === "processing").length,
      failed: all.filter((i) => i.status === "failed").length,
      stuck: all.filter(
        (i) =>
          i.status === "processing" &&
          (i.started_at_epoch ?? 0) < stuckCutoff
      ).length,
    };
  }

  getStuckItems(thresholdMs: number): QueueItem[] {
    const cutoff = Date.now() - thresholdMs;
    return [...this.queue.values()].filter(
      (i) =>
        i.status === "processing" && (i.started_at_epoch ?? 0) < cutoff
    );
  }

  resetStuckItems(thresholdMs: number): number {
    const stuck = this.getStuckItems(thresholdMs);
    for (const item of stuck) {
      item.status = "pending";
      item.started_at_epoch = undefined;
    }
    return stuck.length;
  }

  incrementRetryCount(id: number): number {
    const item = this.queue.get(id);
    if (!item) return 0;
    item.retry_count++;
    return item.retry_count;
  }

  // ─── Stats ───

  getStats(project?: string): Record<string, number> {
    const obs = project
      ? [...this.observations.values()].filter((o) => o.project === project)
      : [...this.observations.values()];
    const sess = project
      ? [...this.sessions.values()].filter((s) => s.project === project)
      : [...this.sessions.values()];
    const sums = project
      ? [...this.summaries.values()].filter((s) => s.project === project)
      : [...this.summaries.values()];
    return {
      observations: obs.length,
      sessions: sess.length,
      summaries: sums.length,
      pending_queue: this.getQueueCounts().pending,
    };
  }
}
