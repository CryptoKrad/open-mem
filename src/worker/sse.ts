/**
 * C-Mem Worker: Server-Sent Events (SSE) Manager
 *
 * Security:
 *   - Only serves clients from 127.0.0.1 or ::1
 *   - No wildcard CORS
 *   - Auto-cleanup on disconnect
 *
 * Events emitted:
 *   observation-created     → raw observation queued
 *   observation-processed   → AI compression finished
 *   session-summary-created → session summary ready
 *   user-prompt-created     → new user prompt stored
 */

import { EventEmitter } from "events";

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

export type SseEventName =
  | "observation-created"
  | "observation-processed"
  | "session-summary-created"
  | "user-prompt-created"
  | "ping";

export interface SseClient {
  id: string;
  // Hono streaming controller
  write: (data: string) => void | Promise<void>;
  close: () => void;
  remoteAddress: string;
}

interface SseEvent {
  event: SseEventName;
  data: unknown;
  id?: string;
}

// ───────────────────────────────────────────────────────
// SSE Manager
// ───────────────────────────────────────────────────────

export class SseManager extends EventEmitter {
  /** clientId → SseClient */
  private clients = new Map<string, SseClient>();

  /** Keep-alive ping interval handle */
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  private static PING_INTERVAL_MS = 30_000;

  constructor() {
    super();
    this.startPingLoop();
  }

  // ─────────────────────────────────────
  // Client lifecycle
  // ─────────────────────────────────────

  /**
   * Register an SSE client.
   * Returns false if the remote address is not localhost (reject).
   */
  addClient(client: SseClient): boolean {
    if (!isLocalhost(client.remoteAddress)) {
      console.warn(
        `[sse] Rejected non-localhost SSE client: ${client.remoteAddress}`
      );
      client.close();
      return false;
    }

    this.clients.set(client.id, client);
    console.log(
      `[sse] Client connected: ${client.id} (${this.clients.size} total)`
    );
    return true;
  }

  removeClient(clientId: string): void {
    const had = this.clients.delete(clientId);
    if (had) {
      console.log(
        `[sse] Client disconnected: ${clientId} (${this.clients.size} remaining)`
      );
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // ─────────────────────────────────────
  // Broadcasting
  // ─────────────────────────────────────

  /** Broadcast an event to all connected clients */
  broadcast(event: SseEvent): void {
    const payload = formatSse(event);
    const dead: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        const result = client.write(payload);
        if (result instanceof Promise) {
          result.catch(() => dead.push(id));
        }
      } catch {
        dead.push(id);
      }
    }

    // Clean up dead clients
    for (const id of dead) {
      this.removeClient(id);
    }
  }

  /** Emit observation-created and broadcast to SSE clients */
  notifyObservationCreated(data: {
    queueId: number;
    sessionId: string;
    project: string;
    toolName: string;
  }): void {
    this.emit("observation-created", data);
    this.broadcast({
      event: "observation-created",
      data,
      id: String(data.queueId),
    });
  }

  /** Emit observation-processed and broadcast */
  notifyObservationProcessed(data: {
    observationId: number;
    queueId: number;
    sessionId: string;
    project: string;
    title: string;
    kind: string;
  }): void {
    this.emit("observation-processed", data);
    this.broadcast({
      event: "observation-processed",
      data,
      id: String(data.observationId),
    });
  }

  /** Emit session-summary-created and broadcast */
  notifySummaryCreated(data: {
    summaryId: number;
    sessionId: string;
    project: string;
    request: string;
  }): void {
    this.emit("session-summary-created", data);
    this.broadcast({
      event: "session-summary-created",
      data,
      id: String(data.summaryId),
    });
  }

  /** Emit user-prompt-created and broadcast */
  notifyPromptCreated(data: {
    promptId: number;
    sessionId: string;
    project: string;
    promptNumber: number;
  }): void {
    this.emit("user-prompt-created", data);
    this.broadcast({
      event: "user-prompt-created",
      data,
      id: String(data.promptId),
    });
  }

  // ─────────────────────────────────────
  // Keep-alive
  // ─────────────────────────────────────

  private startPingLoop(): void {
    this.pingInterval = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast({ event: "ping", data: { ts: Date.now() } });
      }
    }, SseManager.PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {}
    }
    this.clients.clear();
  }
}

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

/** Format a server-sent event frame */
export function formatSse(event: SseEvent): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.event}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  lines.push(""); // blank line terminates the event
  lines.push("");
  return lines.join("\n");
}

/** Check whether a remote address is localhost */
export function isLocalhost(addr: string): boolean {
  // Strip ::ffff: prefix for IPv4-mapped IPv6 addresses
  const normalized = addr.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

/** Generate a random client ID */
export function generateClientId(): string {
  return `sse-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ───────────────────────────────────────────────────────
// Singleton
// ───────────────────────────────────────────────────────

export const sseManager = new SseManager();
