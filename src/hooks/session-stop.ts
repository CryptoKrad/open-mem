#!/usr/bin/env node
/**
 * Open-Mem Hook: Stop (session pause / user stops prompting)
 *
 * Fires when Claude Code finishes responding and the session is paused.
 * Can fire multiple times per session (each pause is a checkpoint).
 *
 * Responsibilities:
 * - Parse transcript JSONL to extract last user + assistant messages
 * - Strip <c-mem-context> tags from assistant message (recursion prevention)
 * - Fire-and-forget POST to worker /api/sessions/summarize (2s timeout)
 * - Return { continue: true, suppressOutput: true }
 *
 * @module hooks/session-stop
 */

import { readFileSync, existsSync } from "fs";
import { loadConfig, projectFromCwd, workerBaseUrl } from "../config.js";
import { isValidSessionId, stripPrivacyTags } from "./privacy.js";
import { readAuthToken } from "../auth/token.js";
import type { HookInput, HookOutput } from "../types.js";

const AUTH_TOKEN = readAuthToken();

// ─── Transcript Parsing ───────────────────────────────────────────────────────

/**
 * A single entry in the transcript JSONL file.
 * Only the fields we care about are typed.
 */
interface TranscriptEntry {
  type: "user" | "assistant" | "system" | string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Extract the string content from a Claude message content field.
 * Handles both simple string content and content block arrays.
 */
function extractContentText(
  content: string | Array<{ type: string; text?: string }> | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Parse a transcript JSONL file and return the last user and assistant messages.
 * Skips <system-reminder> blocks in assistant messages.
 *
 * @param transcriptPath - Absolute path to the JSONL transcript file
 * @returns { lastUser, lastAssistant } — either may be undefined if not found
 */
function parseTranscript(transcriptPath: string): {
  lastUser?: string;
  lastAssistant?: string;
} {
  if (!existsSync(transcriptPath)) {
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return {};
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      const role = entry.type ?? entry.message?.role;
      const content =
        entry.content ?? entry.message?.content;

      const text = extractContentText(
        typeof content === "string" || Array.isArray(content) ? content : undefined
      ).trim();

      if (!text) continue;

      if (role === "user") {
        lastUser = text;
      } else if (role === "assistant") {
        // Strip <system-reminder> and <c-mem-context> blocks (recursion prevention)
        const stripped = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
          .replace(/<c-mem-context>[\s\S]*?<\/c-mem-context>/gi, "")
          .trim();
        if (stripped) lastAssistant = stripped;
      }
    } catch {
      // Malformed JSONL line — skip and continue
    }
  }

  return { lastUser, lastAssistant };
}

// ─── Fire-and-Forget ──────────────────────────────────────────────────────────

function postSummarize(
  workerUrl: string,
  payload: {
    session_id: string;
    project: string;
    last_user_message?: string;
    last_assistant_message?: string;
  }
): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);

  fetch(`${workerUrl}/api/sessions/summarize`, {
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
      `[c-mem/session-stop] Rejected invalid session_id: "${input.session_id}"\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  try {
    const config = loadConfig();
    const project = projectFromCwd(input.cwd ?? "");

    // Parse transcript for last conversation turn
    const transcriptPath = input.transcript_path ?? "";
    const { lastUser, lastAssistant } = transcriptPath
      ? parseTranscript(transcriptPath)
      : {};

    // Strip privacy tags from extracted messages
    const cleanUser = lastUser ? stripPrivacyTags(lastUser) : undefined;
    const cleanAssistant = lastAssistant ? stripPrivacyTags(lastAssistant) : undefined;

    postSummarize(workerBaseUrl(config), {
      session_id: input.session_id,
      project,
      last_user_message: cleanUser,
      last_assistant_message: cleanAssistant,
    });
  } catch (err) {
    process.stderr.write(
      `[c-mem/session-stop] Error: ${err instanceof Error ? err.message : err}\n`
    );
  }

  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[c-mem/session-stop] Unhandled error: ${err}\n`);
  process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
  process.exit(0);
});
