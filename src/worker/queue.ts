/**
 * C-Mem Worker: Async Observation Queue
 *
 * State machine: pending → processing → processed | failed
 *
 * Guarantees:
 *   - Sequential processing per session (no concurrent agents on same session)
 *   - Max 3 retry attempts with exponential backoff (2s, 4s, 8s)
 *   - Stuck detection: >5min in "processing" → mark failed
 *   - On startup: loads pending/processing items from DB and requeues
 *   - Emits events for SSE broadcast
 */

import { EventEmitter } from "events";
import type { ISessionStore, QueueItem } from "../types.js";
import { sseManager } from "./sse.js";

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

/** Raw data needed to process one queue entry */
export interface QueueMessage {
  queueId: number;
  sessionId: string;
  toolName: string;
  toolInput: string; // JSON string
  toolResult: string;
  retryCount: number;
}

/**
 * Processor callback — Builder A's compression agent implements this.
 * Returns the created observation ID on success.
 */
export type ObservationProcessor = (
  queueId: number,
  msg: QueueMessage
) => Promise<number>;

// ───────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000; // 2s, 4s, 8s
const STUCK_THRESHOLD_MS = 5 * 60 * 1_000; // 5 minutes
const STUCK_CHECK_INTERVAL_MS = 60 * 1_000; // check every minute
const POLL_INTERVAL_MS = 500; // poll for new items every 500ms

// ───────────────────────────────────────────────────────
// ObservationQueue
// ───────────────────────────────────────────────────────

export class ObservationQueue extends EventEmitter {
  /** Per-session lock: sessionId → currently processing queue ID */
  private processingBySession = new Map<string, number>();

  /** In-memory pending queue (mirrors DB state) */
  private pendingItems: QueueMessage[] = [];

  /** Whether the processing loop is running */
  private running = false;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stuckTimer: ReturnType<typeof setInterval> | null = null;

  private processor: ObservationProcessor | null = null;

  constructor(private readonly store: ISessionStore) {
    super();
  }

  // ─────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────

  /**
   * Start the processing loop. Call after DB is initialized.
   * @param processor — The AI compression function to call per item.
   */
  start(processor: ObservationProcessor): void {
    if (this.running) return;
    this.processor = processor;
    this.running = true;

    // Recover any stuck/pending items from previous run
    this.recoverFromDb();

    this.schedulePoll();
    this.startStuckDetection();

    console.log("[queue] Started");
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    this.pollTimer = null;
    this.stuckTimer = null;
    console.log("[queue] Stopped");
  }

  // ─────────────────────────────────────
  // Public API
  // ─────────────────────────────────────

  /**
   * Enqueue a new observation for async processing.
   * Returns the DB queue ID.
   */
  enqueue(
    sessionId: string,
    toolName: string,
    toolInput: unknown,
    toolResult: string,
    project = ""
  ): number {
    const inputStr = JSON.stringify(toolInput);
    // Truncate tool result to 50KB to prevent oversized payloads
    const truncated = toolResult.length > 50_000
      ? toolResult.slice(0, 50_000) + "\n[TRUNCATED]"
      : toolResult;

    const queueId = this.store.enqueueObservation(
      sessionId,
      toolName,
      inputStr,
      truncated,
      project
    );

    const msg: QueueMessage = {
      queueId,
      sessionId,
      toolName,
      toolInput: inputStr,
      toolResult: truncated,
      retryCount: 0,
    };
    this.pendingItems.push(msg);

    // Notify SSE clients
    sseManager.notifyObservationCreated({
      queueId,
      sessionId,
      project: this.getProject(sessionId),
      toolName,
    });

    // Trigger processing sooner
    if (this.running && !this.processingBySession.has(sessionId)) {
      this.processSoon();
    }

    return queueId;
  }

  /**
   * Get current queue status counts from DB.
   */
  getStatus(): {
    pending: number;
    processing: number;
    failed: number;
    stuck: number;
    inMemoryPending: number;
  } {
    const counts = this.store.getQueueCounts();
    return {
      ...counts,
      inMemoryPending: this.pendingItems.length,
    };
  }

  /**
   * Manually trigger recovery of stuck items.
   * Returns count of items reset to pending.
   */
  recoverStuck(): number {
    const count = this.store.resetStuckItems(STUCK_THRESHOLD_MS);
    if (count > 0) {
      console.log(`[queue] Manually recovered ${count} stuck item(s)`);
      this.refillFromDb();
    }
    return count;
  }

  // ─────────────────────────────────────
  // Processing Loop
  // ─────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.processBatch().finally(() => this.schedulePoll());
    }, POLL_INTERVAL_MS);
  }

  private processSoon(): void {
    // Cancel current poll and start immediately
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.processBatch().finally(() => this.schedulePoll());
  }

  private async processBatch(): Promise<void> {
    if (!this.running || !this.processor) return;

    // Get items not already locked by session
    const available = this.pendingItems.filter(
      (item) => !this.processingBySession.has(item.sessionId)
    );

    // Launch processing for each available session (sequential within session)
    const promises: Promise<void>[] = [];
    for (const item of available) {
      if (!this.processingBySession.has(item.sessionId)) {
        // Remove from pending list
        const idx = this.pendingItems.indexOf(item);
        if (idx !== -1) this.pendingItems.splice(idx, 1);

        promises.push(this.processItem(item));
      }
    }

    await Promise.allSettled(promises);
  }

  private async processItem(msg: QueueMessage): Promise<void> {
    if (!this.processor) return;

    // Acquire session lock
    this.processingBySession.set(msg.sessionId, msg.queueId);
    this.store.updateQueueStatus(msg.queueId, "processing");

    try {
      const observationId = await this.processor(msg.queueId, msg);

      // Success
      this.store.updateQueueStatus(msg.queueId, "processed");
      this.emit("observation-processed", {
        observationId,
        queueId: msg.queueId,
        sessionId: msg.sessionId,
      });

      sseManager.notifyObservationProcessed({
        observationId,
        queueId: msg.queueId,
        sessionId: msg.sessionId,
        project: this.getProject(msg.sessionId),
        title: "",
        kind: "",
      });
    } catch (err) {
      await this.handleProcessingError(msg, err);
    } finally {
      // Release session lock
      this.processingBySession.delete(msg.sessionId);
    }
  }

  private async handleProcessingError(
    msg: QueueMessage,
    err: unknown
  ): Promise<void> {
    const errMsg = err instanceof Error ? err.message : String(err);
    const newRetryCount = this.store.incrementRetryCount(msg.queueId);

    if (newRetryCount >= MAX_RETRIES) {
      // Permanently failed
      this.store.updateQueueStatus(msg.queueId, "failed", errMsg);
      console.error(
        `[queue] Item ${msg.queueId} permanently failed after ${newRetryCount} attempts: ${errMsg}`
      );
      this.emit("item-failed", { queueId: msg.queueId, error: errMsg });
    } else {
      // Retry with exponential backoff
      const delayMs = BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1);
      console.warn(
        `[queue] Item ${msg.queueId} failed (attempt ${newRetryCount}/${MAX_RETRIES}), retrying in ${delayMs}ms: ${errMsg}`
      );
      this.store.updateQueueStatus(msg.queueId, "pending");

      setTimeout(() => {
        const retryMsg: QueueMessage = {
          ...msg,
          retryCount: newRetryCount,
        };
        this.pendingItems.push(retryMsg);
        if (this.running) this.processSoon();
      }, delayMs);
    }
  }

  // ─────────────────────────────────────
  // Stuck Detection
  // ─────────────────────────────────────

  private startStuckDetection(): void {
    this.stuckTimer = setInterval(() => {
      const stuck = this.store.getStuckItems(STUCK_THRESHOLD_MS);
      if (stuck.length > 0) {
        console.error(
          `[queue] STUCK DETECTION: ${stuck.length} item(s) have been processing for >5min`
        );
        for (const item of stuck) {
          console.error(
            `  → Queue ID ${item.id} (session: ${item.session_id}, tool: ${item.tool_name})`
          );
          // Mark as failed and release
          this.store.updateQueueStatus(
            item.id,
            "failed",
            "Stuck: exceeded 5min processing timeout"
          );
          this.processingBySession.delete(item.session_id);
          this.emit("item-stuck", { queueId: item.id });
        }
      }
    }, STUCK_CHECK_INTERVAL_MS);
  }

  // ─────────────────────────────────────
  // DB Recovery
  // ─────────────────────────────────────

  /**
   * On startup: load all pending/processing items from DB into memory queue.
   * Processing items are reset to pending (assumed crashed mid-flight).
   */
  private recoverFromDb(): void {
    // Reset stuck processing items from previous run
    const recovered = this.store.resetStuckItems(0); // threshold 0 = all processing items
    if (recovered > 0) {
      console.log(
        `[queue] Recovered ${recovered} in-progress item(s) from previous run`
      );
    }

    this.refillFromDb();
  }

  private refillFromDb(): void {
    const items = this.store.getPendingQueueItems(200);
    for (const item of items) {
      const msg: QueueMessage = {
        queueId: item.id,
        sessionId: item.session_id,
        toolName: item.tool_name,
        toolInput: item.tool_input,
        toolResult: item.tool_response,
        retryCount: item.retry_count,
      };
      // Avoid duplicates
      if (!this.pendingItems.some((p) => p.queueId === msg.queueId)) {
        this.pendingItems.push(msg);
      }
    }

    if (items.length > 0) {
      console.log(`[queue] Loaded ${items.length} pending item(s) from DB`);
    }
  }

  // ─────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────

  /** Retrieve project for a session (best effort, returns empty string if not found) */
  private getProject(sessionId: string): string {
    try {
      return this.store.getSession(sessionId)?.project ?? "";
    } catch {
      return "";
    }
  }
}
