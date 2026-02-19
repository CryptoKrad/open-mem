/**
 * C-Mem SDK Observation Compressor
 *
 * Takes a raw tool execution record and compresses it into a structured
 * Observation using the Anthropic API (claude-haiku-3-5 by default for cost).
 *
 * Features:
 * - Builds original <c-mem-compress> XML prompts
 * - Parses <memory> XML response into typed Observation
 * - Falls back to raw/type=other if LLM parse fails
 * - Exponential backoff: 1s, 2s, 4s on failure
 *
 * @module sdk/compressor
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildCompressionPrompt } from "./prompts.js";
import type { CompressedObservation, ObservationType, RawObservation } from "../types.js";

// ─── XML Parser ───────────────────────────────────────────────────────────────

/**
 * Extract the text content of a named XML element.
 * Returns the first match only. Returns empty string if not found.
 */
function extractElement(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Extract all text contents of repeated XML elements with a given tag name.
 * E.g., extractAll('<tags><tag>a</tag><tag>b</tag></tags>', 'tag') => ['a', 'b']
 */
function extractAll(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const content = match[1].trim();
    if (content) results.push(content);
  }
  return results;
}

/** Validate that a string is one of the known ObservationType values */
const VALID_TYPES = new Set<ObservationType>([
  "bugfix", "feature", "refactor", "config",
  "research", "error", "decision", "other",
]);

function parseObservationType(raw: string): ObservationType {
  const normalized = raw.toLowerCase().trim() as ObservationType;
  return VALID_TYPES.has(normalized) ? normalized : "other";
}

/**
 * Parse the LLM's <memory>...</memory> XML response into a CompressedObservation.
 * Returns null if the XML structure is missing or malformed.
 */
function parseCompressionResponse(xml: string): CompressedObservation | null {
  const memoryBlock = extractElement(xml, "memory");
  if (!memoryBlock) return null;

  const type = parseObservationType(extractElement(memoryBlock, "type"));
  const title = extractElement(memoryBlock, "title");
  const narrative = extractElement(memoryBlock, "narrative");

  if (!title || !narrative) return null;

  const filesBlock = extractElement(memoryBlock, "files");
  const files_read = extractAll(filesBlock, "read");
  const files_modified = extractAll(filesBlock, "modified");
  const tags = extractAll(extractElement(memoryBlock, "tags"), "tag");
  const facts = extractAll(extractElement(memoryBlock, "facts"), "fact");

  return { type, title, narrative, tags, facts, files_read, files_modified };
}

// ─── Retry / Backoff ──────────────────────────────────────────────────────────

/** Wait for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff delays: 1s, 2s, 4s */
const BACKOFF_DELAYS = [1_000, 2_000, 4_000];

// ─── Compressor ───────────────────────────────────────────────────────────────

/**
 * Compress a raw tool observation into a structured Observation using the LLM.
 *
 * - Uses claude-haiku-3-5 by default for cost efficiency (configurable)
 * - Retries up to 3 times with exponential backoff (1s, 2s, 4s)
 * - If all retries fail or XML parse fails, returns a best-effort raw record
 *   with type="other"
 *
 * @param raw    - The raw observation data (tool name, input, response)
 * @param apiKey - Anthropic API key (reads ANTHROPIC_API_KEY env var if omitted)
 * @param model  - Anthropic model to use (default: claude-haiku-3-5)
 * @returns CompressedObservation — never throws
 */
export async function compressObservation(
  raw: RawObservation,
  apiKey?: string,
  model = "claude-haiku-3-5"
): Promise<CompressedObservation> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });

  const prompt = buildCompressionPrompt(
    raw.tool_name,
    raw.tool_input,
    raw.tool_response,
    {
      project: raw.project,
      promptNumber: raw.prompt_number,
      userGoal: raw.user_goal,
    }
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
      const parsed = parseCompressionResponse(text);

      if (parsed) return parsed;

      // LLM returned something but parse failed — log and retry
      process.stderr.write(
        `[c-mem/compressor] Parse failed on attempt ${attempt + 1}. ` +
          `Raw response: ${text.slice(0, 200)}\n`
      );
      lastError = new Error("XML parse failed — missing <memory> structure");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(
        `[c-mem/compressor] API error on attempt ${attempt + 1}: ${lastError.message}\n`
      );
    }
  }

  // All retries exhausted — return a degraded raw record
  process.stderr.write(
    `[c-mem/compressor] Falling back to raw observation after 3 failed attempts. ` +
      `Tool: ${raw.tool_name}. Error: ${lastError?.message}\n`
  );

  return {
    type: "other",
    title: `${raw.tool_name} — session prompt #${raw.prompt_number}`,
    narrative: `Raw observation from ${raw.tool_name}. Compression failed after 3 attempts.`,
    tags: [],
    facts: [],
    files_read: [],
    files_modified: [],
  };
}
