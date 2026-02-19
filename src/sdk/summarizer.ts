/**
 * Open-Mem SDK Session Summarizer
 *
 * Generates a structured session summary from accumulated observations
 * and the final conversation turn. Uses the Anthropic API with the
 * <c-mem-summarize> XML prompt schema.
 *
 * @module sdk/summarizer
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildSummaryPrompt } from "./prompts.js";
import type { Observation, Session, Summary, SummarizeInput } from "../types.js";

// ─── XML Parser ───────────────────────────────────────────────────────────────

/**
 * Extract the text content of a named XML element (first match).
 */
function extractElement(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Parse the LLM's <session_summary> XML response into a partial Summary.
 * Returns null if the required elements are missing.
 */
function parseSummaryResponse(
  xml: string,
  sessionDbId: number
): Omit<Summary, "id" | "created_at"> | null {
  const summaryBlock = extractElement(xml, "session_summary");
  if (!summaryBlock) return null;

  const request = extractElement(summaryBlock, "request");
  const investigated = extractElement(summaryBlock, "investigated");
  const learned = extractElement(summaryBlock, "learned");
  const completed = extractElement(summaryBlock, "completed");
  const next_steps = extractElement(summaryBlock, "next_steps");

  // Require at minimum a request field
  if (!request) return null;

  return {
    session_id: sessionDbId,
    request,
    investigated: investigated || "None",
    learned: learned || "None",
    completed: completed || "None",
    next_steps: next_steps || "None",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BACKOFF_DELAYS = [1_000, 2_000, 4_000];

// ─── Summarizer ───────────────────────────────────────────────────────────────

/**
 * Generate a structured session summary from observations and conversation.
 *
 * - Uses the configured Anthropic model (caller passes model to allow
 *   cost-optimized or higher-quality summarization per configuration)
 * - Retries up to 3 times with exponential backoff
 * - Returns a best-effort fallback if all retries fail
 *
 * @param input   - Session data including observations and last messages
 * @param sessionDbId - Database primary key of the session (for foreign key)
 * @param apiKey  - Anthropic API key (falls back to ANTHROPIC_API_KEY env var)
 * @param model   - Anthropic model to use for summarization
 * @returns Partial Summary object (caller adds id + created_at before DB insert)
 */
export async function summarizeSession(
  input: SummarizeInput,
  sessionDbId: number,
  apiKey?: string,
  model = "claude-haiku-3-5"
): Promise<Omit<Summary, "id" | "created_at">> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });

  // Build a minimal Session shape for the prompt builder
  const sessionShape: Pick<Session, "claude_session_id" | "project" | "prompt_counter"> =
    {
      claude_session_id: input.session_id,
      project: input.project,
      prompt_counter: input.prompt_number ?? input.observations.length,
    };

  const prompt = buildSummaryPrompt(
    sessionShape,
    input.observations,
    input.last_user_message,
    input.last_assistant_message
  );

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_DELAYS[attempt - 1]);
    }

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const text =
        response.content[0]?.type === "text" ? response.content[0].text : "";
      const parsed = parseSummaryResponse(text, sessionDbId);

      if (parsed) return parsed;

      process.stderr.write(
        `[c-mem/summarizer] Parse failed on attempt ${attempt + 1}. ` +
          `Raw: ${text.slice(0, 200)}\n`
      );
      lastError = new Error("XML parse failed — missing <session_summary> structure");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(
        `[c-mem/summarizer] API error on attempt ${attempt + 1}: ${lastError.message}\n`
      );
    }
  }

  // Graceful fallback summary
  process.stderr.write(
    `[c-mem/summarizer] Returning fallback summary after 3 failed attempts. ` +
      `Session: ${input.session_id}\n`
  );

  return {
    session_id: sessionDbId,
    request: input.last_user_message?.slice(0, 200) ?? "Unknown request",
    investigated: "Summary generation failed — see observations for details",
    learned: "None",
    completed: `${input.observations.length} observations captured`,
    next_steps: "None",
  };
}
