/**
 * Open-Mem SDK Prompt Builders
 *
 * Original XML prompt templates for observation compression and session
 * summarization. These prompts are our own design — NOT copied from any
 * other memory system.
 *
 * Schema names: <c-mem-compress> and <c-mem-summarize> (unique to Open-Mem).
 *
 * @module sdk/prompts
 */

import type { Observation, Session } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Context passed alongside a raw tool execution for compression */
export interface SessionContext {
  project: string;
  promptNumber: number;
  /** The first user message that started this session */
  userGoal: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in XML content.
 * Prevents XML injection through tool inputs/outputs.
 */
function xmlEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Truncate a string to a maximum character count.
 * Appends a truncation notice if the content was cut.
 */
function truncate(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "\n[...truncated for compression]";
}

// ─── Observation Compression ──────────────────────────────────────────────────

/**
 * Build the XML prompt that instructs the LLM to compress a raw tool
 * observation into a structured Open-Mem memory record.
 *
 * The <c-mem-compress> schema is our original design.
 * Response schema: <memory> with sub-elements type, title, narrative, etc.
 *
 * @param tool_name  - Name of the tool that was invoked
 * @param tool_input - Tool parameters (will be JSON-serialized and escaped)
 * @param tool_response - Raw tool output (truncated to 8K chars, escaped)
 * @param sessionCtx - Session context for the LLM to understand intent
 * @returns Formatted prompt string ready for the Anthropic API
 */
export function buildCompressionPrompt(
  tool_name: string,
  tool_input: unknown,
  tool_response: string,
  sessionCtx: SessionContext
): string {
  const truncatedResponse = truncate(tool_response, 8_000);

  return `You are a memory compression agent for a software development assistant.

<c-mem-compress>
  <instruction>
    Analyze the tool execution below and extract the essential information as a
    structured memory record. Focus on what changed, why it matters, and what
    would be useful to recall in a future coding session.

    Rules:
    - Title must be a single scannable line (≤ 80 chars), no punctuation at end
    - Narrative must be 2–3 sentences maximum
    - Facts are discrete, atomic statements (each ≤ 50 words)
    - Tags come from this fixed vocabulary: problem-solution, gotcha, pattern,
      trade-off, discovery, config-change, api-usage, data-model, dependency,
      performance, security, test, refactor
    - Type must be exactly one of: bugfix, feature, refactor, config, research,
      error, decision, other
    - If the tool output is trivial (e.g. a simple file read with no changes),
      set type to "other" and keep narrative brief
    - If no files were read or modified, leave those elements empty
  </instruction>

  <tool_execution>
    <tool>${xmlEscape(tool_name)}</tool>
    <input>${xmlEscape(tool_input)}</input>
    <output>${xmlEscape(truncatedResponse)}</output>
  </tool_execution>

  <session>
    <project>${xmlEscape(sessionCtx.project)}</project>
    <prompt_number>${sessionCtx.promptNumber}</prompt_number>
    <user_goal>${xmlEscape(sessionCtx.userGoal)}</user_goal>
  </session>
</c-mem-compress>

Respond with ONLY this XML structure — no explanation, no markdown fences:

<memory>
  <type>bugfix|feature|refactor|config|research|error|decision|other</type>
  <title>One-line scannable title here</title>
  <narrative>2-3 sentence explanation of what happened and why it matters.</narrative>
  <tags>
    <tag>tag-name</tag>
  </tags>
  <facts>
    <fact>Atomic factual statement.</fact>
  </facts>
  <files>
    <read>/path/to/file</read>
    <modified>/path/to/file</modified>
  </files>
</memory>`;
}

// ─── Session Summarization ────────────────────────────────────────────────────

/**
 * Format a subset of observations as compact XML for the summary prompt.
 * Takes the most recent N observations to keep tokens reasonable.
 */
function formatObservationsForSummary(observations: Observation[], maxItems = 30): string {
  const recent = observations.slice(-maxItems);
  if (recent.length === 0) return "  <obs>No observations recorded.</obs>";

  return recent
    .map(
      (o) =>
        `  <obs id="${o.id}" type="${xmlEscape(o.type)}" title="${xmlEscape(o.title)}" />`
    )
    .join("\n");
}

/**
 * Build the XML prompt that instructs the LLM to generate a structured
 * session summary from observations and the final conversation turn.
 *
 * The <c-mem-summarize> schema is our original design.
 * Response schema: <session_summary> with sub-elements.
 *
 * @param session       - The session record (for project name / prompt count)
 * @param observations  - All compressed observations for this session
 * @param lastUser      - Last user message in the conversation
 * @param lastAssistant - Last assistant response in the conversation
 * @returns Formatted prompt string ready for the Anthropic API
 */
export function buildSummaryPrompt(
  session: Pick<Session, "claude_session_id" | "project" | "prompt_counter">,
  observations: Observation[],
  lastUser?: string,
  lastAssistant?: string
): string {
  const truncatedUser = lastUser ? truncate(lastUser, 2_000) : "Not available";
  const truncatedAssistant = lastAssistant
    ? truncate(lastAssistant, 3_000)
    : "Not available";

  return `You are a session summarization agent for a software development assistant.

<c-mem-summarize>
  <instruction>
    Generate a structured summary of this coding session that will be injected
    as context at the start of future sessions. Be specific and actionable.

    Rules:
    - request: What the user asked for (1–2 sentences)
    - investigated: What files, systems, or concepts were explored
    - learned: Key discoveries — bugs found, patterns identified, gotchas
    - completed: Work that was definitively finished (be specific)
    - next_steps: Concrete tasks that remain (use imperative: "Fix X", "Add Y")
    - Keep each field to 3–5 sentences maximum
    - If a field has nothing to report, write "None"
  </instruction>

  <session>
    <project>${xmlEscape(session.project)}</project>
    <session_id>${xmlEscape(session.claude_session_id)}</session_id>
    <total_prompts>${session.prompt_counter}</total_prompts>
    <observation_count>${observations.length}</observation_count>
  </session>

  <observations>
${formatObservationsForSummary(observations)}
  </observations>

  <conversation>
    <last_user>${xmlEscape(truncatedUser)}</last_user>
    <last_assistant>${xmlEscape(truncatedAssistant)}</last_assistant>
  </conversation>
</c-mem-summarize>

Respond with ONLY this XML structure — no explanation, no markdown fences:

<session_summary>
  <request>What the user originally asked for.</request>
  <investigated>What was explored and examined.</investigated>
  <learned>Key discoveries from this session.</learned>
  <completed>Work that was definitively finished.</completed>
  <next_steps>Concrete remaining tasks.</next_steps>
</session_summary>`;
}
