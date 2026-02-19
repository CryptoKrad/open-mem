#!/usr/bin/env node
/**
 * Open-Mem Hook: SessionEnd
 *
 * Fires when a Claude Code / OpenClaw session closes (exit, clear, logout).
 *
 * Responsibilities:
 * - Validate session_id
 * - Fire-and-forget POST to worker /api/sessions/complete (2s timeout)
 * - Return { continue: true, suppressOutput: true }
 *
 * The worker marks the session as completed and performs any cleanup.
 * This hook is intentionally minimal — never blocks session teardown.
 *
 * @module hooks/session-end
 */

import { loadConfig, workerBaseUrl } from "../config.js";
import { isValidSessionId } from "./privacy.js";
import { readAuthToken } from "../auth/token.js";
import type { HookInput, HookOutput } from "../types.js";

const AUTH_TOKEN = readAuthToken();

// ─── Fire-and-Forget ──────────────────────────────────────────────────────────

/**
 * Notify the worker that the session has ended.
 * Uses a 2-second timeout — if the worker is down, we don't care.
 */
function postSessionComplete(
  workerUrl: string,
  payload: { session_id: string; reason?: string }
): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);

  fetch(`${workerUrl}/api/sessions/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { "Authorization": `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then(() => clearTimeout(timer))
    .catch(() => clearTimeout(timer));
  // Intentionally not awaited
}

// ─── Main Hook ────────────────────────────────────────────────────────────────

const CONTINUE_OUTPUT: HookOutput = { continue: true, suppressOutput: true };

async function main(): Promise<void> {
  let input: HookInput;

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  if (!isValidSessionId(input.session_id)) {
    process.stderr.write(
      `[c-mem/session-end] Rejected invalid session_id: "${input.session_id}"\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  try {
    const config = loadConfig();

    postSessionComplete(workerBaseUrl(config), {
      session_id: input.session_id,
      reason: input.reason,
    });
  } catch (err) {
    process.stderr.write(
      `[c-mem/session-end] Error: ${err instanceof Error ? err.message : err}\n`
    );
  }

  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[c-mem/session-end] Unhandled error: ${err}\n`);
  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
  process.exit(0);
});
