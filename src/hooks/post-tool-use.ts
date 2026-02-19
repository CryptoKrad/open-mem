#!/usr/bin/env node
/**
 * Open-Mem Hook: PostToolUse
 *
 * Fires after Claude Code / OpenClaw executes a tool successfully.
 * This is the highest-frequency hook — it fires once per tool call.
 *
 * Responsibilities:
 * - Check skip list (low-value tools that add noise)
 * - Strip secrets from tool_input AND tool_response
 * - Strip <private> and <c-mem-context> tags
 * - Enforce 50KB payload size limit
 * - Fire-and-forget POST to worker /api/observations (2s timeout)
 * - Return { continue: true, suppressOutput: true }
 *
 * Design goal: ≤20ms total execution (validate → scrub → POST → return).
 * The AI compression happens asynchronously in the worker.
 *
 * @module hooks/post-tool-use
 */

import { loadConfig, projectFromCwd, workerBaseUrl } from "../config.js";
import { readAuthToken } from "../auth/token.js";

const AUTH_TOKEN = readAuthToken();
import {
  isValidSessionId,
  scrubSecrets,
  scrubValue,
  stripPrivacyTags,
  enforcePayloadLimit,
} from "./privacy.js";
import type { HookInput, HookOutput } from "../types.js";

// ─── Skip List ────────────────────────────────────────────────────────────────

/**
 * Tools whose observations are not worth compressing.
 * These generate noise and waste LLM API calls.
 */
const SKIP_TOOLS = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "SlashCommand",
  "Skill",
]);

// ─── Fire-and-Forget ──────────────────────────────────────────────────────────

/**
 * POST an observation to the worker — fire and forget.
 * Hard 2-second timeout. Never throws.
 */
function postObservation(
  workerUrl: string,
  payload: {
    session_id: string;
    tool_name: string;
    tool_input_json: string;
    tool_response_text: string;
    project: string;
    cwd: string;
  }
): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);

  fetch(`${workerUrl}/api/observations`, {
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

  // 1. Validate session_id
  if (!isValidSessionId(input.session_id)) {
    process.stderr.write(
      `[c-mem/post-tool-use] Rejected invalid session_id: "${input.session_id}"\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  // 2. Check skip list
  const toolName = input.tool_name ?? "";
  if (SKIP_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  // 3. Strip privacy tags and scrub secrets from tool_input
  const rawInputStr = scrubValue(input.tool_input ?? {});
  const cleanInput = stripPrivacyTags(scrubSecrets(rawInputStr));

  // 4. Strip privacy tags and scrub secrets from tool_response
  const rawResponse = input.tool_response ?? "";
  const cleanResponse = stripPrivacyTags(scrubSecrets(rawResponse));

  // 5. Enforce 50KB payload limit
  const safeInput = enforcePayloadLimit(cleanInput);
  const safeResponse = enforcePayloadLimit(cleanResponse);

  try {
    const config = loadConfig();
    const project = projectFromCwd(input.cwd ?? "");

    postObservation(workerBaseUrl(config), {
      session_id: input.session_id,
      tool_name: toolName,
      tool_input_json: safeInput,
      tool_response_text: safeResponse,
      project,
      cwd: input.cwd ?? "",
    });
  } catch (err) {
    process.stderr.write(
      `[c-mem/post-tool-use] Error: ${err instanceof Error ? err.message : err}\n`
    );
  }

  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[c-mem/post-tool-use] Unhandled error: ${err}\n`);
  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
  process.exit(0);
});
