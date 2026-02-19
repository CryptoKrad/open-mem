#!/usr/bin/env node
/**
 * C-Mem Hook: SessionStart
 *
 * Fires when Claude Code / OpenClaw starts a session (startup, /clear, compact).
 * Fetches recent context from the C-Mem worker and returns it as
 * additionalContext for silent injection into Claude's context window.
 *
 * Graceful degradation: if the worker is down, returns empty context — the
 * session starts normally without historical memory.
 *
 * Security:
 * - Validates session_id format before use
 * - Worker URL always uses 127.0.0.1 (never user-supplied hostname)
 * - 5-second request timeout with single retry
 *
 * @module hooks/session-start
 */

import { loadConfig, projectFromCwd, workerBaseUrl } from "../config.js";
import { isValidSessionId } from "./privacy.js";
import { readAuthToken } from "../auth/token.js";
import type { HookInput, HookOutput } from "../types.js";

// Cache auth token at startup
const AUTH_TOKEN = readAuthToken();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch context markdown from the worker with a timeout and single retry.
 *
 * @param url     - Worker context endpoint
 * @param timeout - Milliseconds before aborting (default 5000)
 * @returns Formatted context markdown or empty string on failure
 */
async function fetchContextWithRetry(url: string, timeout = 5_000): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {};
      if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const response = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(timer);

      if (!response.ok) {
        process.stderr.write(
          `[c-mem/session-start] Worker returned ${response.status} on attempt ${attempt + 1}\n`
        );
        continue;
      }

      const text = await response.text();
      return text;
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[c-mem/session-start] Fetch failed on attempt ${attempt + 1}: ${msg}\n`
      );
      // Brief pause before retry
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }

  return "";
}

// ─── Main Hook ────────────────────────────────────────────────────────────────

/**
 * SessionStart hook entry point.
 * Reads HookInput from stdin, fetches context, writes HookOutput to stdout.
 */
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
    // If we can't read stdin, emit empty context and exit cleanly
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "",
      },
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  // Validate session_id
  if (!isValidSessionId(input.session_id)) {
    process.stderr.write(
      `[c-mem/session-start] Invalid session_id format: "${input.session_id}". Skipping.\n`
    );
    const output: HookOutput = {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  const config = loadConfig();
  const project = projectFromCwd(input.cwd ?? "");
  const baseUrl = workerBaseUrl(config);
  const contextUrl = `${baseUrl}/api/context?project=${encodeURIComponent(project)}&limit=${config.maxObsPerContext}`;

  const additionalContext = await fetchContextWithRetry(contextUrl, 5_000);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[c-mem/session-start] Unhandled error: ${err}\n`);
  // Always exit clean — never block Claude Code
  const fallback: HookOutput = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
  };
  process.stdout.write(JSON.stringify(fallback) + "\n");
  process.exit(0);
});
