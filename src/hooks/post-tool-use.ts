#!/usr/bin/env node
/**
 * Open-Mem Hook: PostToolUse
 *
 * Higher-signal, lower-risk capture policy:
 * - Skip known meta/noise tools
 * - Block sensitive paths / commands / outputs before they leave the hook
 * - Strip secrets from tool_input AND tool_response
 * - Summarize mutation tools instead of storing raw diffs
 * - Summarize read operations instead of shipping raw file contents
 * - Prefer build/test/lint/error exec output over trivial acknowledgements
 *
 * @module hooks/post-tool-use
 */

import { loadConfig, projectFromCwd, workerBaseUrl } from "../config.js";
import { readAuthToken } from "../auth/token.js";
import {
  isValidSessionId,
  scrubSecrets,
  scrubValue,
  stripPrivacyTags,
  enforcePayloadLimit,
  detectSensitiveCommand,
  detectSensitiveOutput,
  findSensitivePathInValue,
} from "./privacy.js";
import type { HookInput, HookOutput } from "../types.js";

const AUTH_TOKEN = readAuthToken();

const SKIP_TOOLS = new Set([
  "todowrite",
  "askuserquestion",
  "listmcpresourcestool",
  "slashcommand",
  "skill",
  "memory_search",
  "memory_get",
  "session_status",
  "tts",
  "canvas",
  "sessions_list",
  "sessions_history",
  "subagents",
]);

const MUTATION_TOOLS = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "write",
  "apply_patch",
]);

const EXEC_TOOLS = new Set(["bash", "exec", "shell"]);
const READ_TOOLS = new Set(["read"]);
const WEB_FETCH_TOOLS = new Set(["web_fetch", "fetch", "curl"]);

const CONTINUE_OUTPUT: HookOutput = { continue: true, suppressOutput: true };
const TRIVIAL_RESPONSE_RE = /^(?:ok|done|success|true|\{\}|\[\]|null|undefined)?$/i;
const HIGH_SIGNAL_EXEC_RE = /\b(?:test|tests|lint|build|compile|deploy|migration|migrate|benchmark|typecheck|check|pytest|jest|vitest|cargo\s+test|cargo\s+build|npm\s+(?:run\s+)?(?:test|lint|build)|pnpm\s+(?:run\s+)?(?:test|lint|build)|yarn\s+(?:test|lint|build)|bun\s+(?:test|run\s+(?:test|lint|build))|tsc\b|eslint\b|ruff\b|mypy\b|gradle\b|mvn\b|make\b)/i;
const FAILURE_RE = /\b(?:error|failed|failure|exception|traceback|panic|cannot|unable to|forbidden|unauthorized|not found)\b/i;
const FETCH_NOISE_RE = /\b(?:403|404|401|access denied|forbidden|cloudflare|just a moment|enable javascript|captcha|rate limited)\b/i;

function postObservation(
  workerUrl: string,
  payload: {
    session_id: string;
    tool_name: string;
    tool_input: unknown;
    tool_response: string;
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
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then(() => clearTimeout(timer))
    .catch(() => clearTimeout(timer));
}

function normalizeToolName(toolName: string | undefined): string {
  return (toolName ?? "").trim().toLowerCase();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function primaryPath(input: unknown): string | undefined {
  const obj = asObject(input);
  for (const key of ["file_path", "filePath", "path", "target", "source", "cwd"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(obj.paths) && typeof obj.paths[0] === "string") return obj.paths[0];
  return undefined;
}

function commandText(input: unknown): string {
  if (typeof input === "string") return input;
  const obj = asObject(input);
  if (typeof obj.command === "string") return obj.command;
  if (Array.isArray(obj.command)) return obj.command.map((part) => String(part)).join(" ");
  if (typeof obj.cmd === "string") return obj.cmd;
  return "";
}

function summarizeInput(toolName: string, input: unknown): unknown {
  const lower = normalizeToolName(toolName);
  const obj = asObject(input);
  const path = primaryPath(input);

  if (READ_TOOLS.has(lower)) {
    return path ? { path } : { action: "read" };
  }

  if (MUTATION_TOOLS.has(lower)) {
    const summary: Record<string, unknown> = {};
    if (path) summary.path = path;
    if (typeof obj.content === "string") summary.content_bytes = Buffer.byteLength(obj.content, "utf-8");
    if (typeof obj.new_string === "string") summary.new_bytes = Buffer.byteLength(obj.new_string, "utf-8");
    if (typeof obj.old_string === "string") summary.old_bytes = Buffer.byteLength(obj.old_string, "utf-8");
    if (Array.isArray(obj.edits)) summary.edit_count = obj.edits.length;
    return summary;
  }

  if (EXEC_TOOLS.has(lower)) {
    const command = commandText(input);
    return command ? { command } : obj;
  }

  if (WEB_FETCH_TOOLS.has(lower)) {
    return typeof obj.url === "string" ? { url: obj.url } : obj;
  }

  return input;
}

function summarizeResponse(toolName: string, input: unknown, response: string): string {
  const lower = normalizeToolName(toolName);
  const path = primaryPath(input);
  const trimmed = response.trim();

  if (READ_TOOLS.has(lower)) {
    const location = path ?? "a file";
    if (FAILURE_RE.test(trimmed)) return trimmed;
    return `Read ${location}. Raw file contents omitted from memory capture.`;
  }

  if (MUTATION_TOOLS.has(lower)) {
    if (trimmed && !TRIVIAL_RESPONSE_RE.test(trimmed)) return trimmed;
    return `Updated ${path ?? "a file"} via ${toolName}.`;
  }

  if (WEB_FETCH_TOOLS.has(lower) && FETCH_NOISE_RE.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function shouldSkipForNoise(toolName: string, input: unknown, response: string): string | null {
  const lower = normalizeToolName(toolName);
  const trimmed = response.trim();

  if (SKIP_TOOLS.has(lower)) return "explicit skip-list tool";
  if (toolName === "git_commit" && TRIVIAL_RESPONSE_RE.test(trimmed)) return "trivial git commit ack";

  if (WEB_FETCH_TOOLS.has(lower) && FETCH_NOISE_RE.test(trimmed)) {
    return "web fetch noise";
  }

  if (READ_TOOLS.has(lower) && !FAILURE_RE.test(trimmed)) {
    return "raw read output";
  }

  if (EXEC_TOOLS.has(lower)) {
    const command = commandText(input);
    const interesting = HIGH_SIGNAL_EXEC_RE.test(command) || FAILURE_RE.test(trimmed);
    if (!interesting && (TRIVIAL_RESPONSE_RE.test(trimmed) || trimmed.length < 40)) {
      return "low-signal exec output";
    }
  }

  if (!MUTATION_TOOLS.has(lower) && TRIVIAL_RESPONSE_RE.test(trimmed)) {
    return "trivial response";
  }

  if (/^[\[{]/.test(trimmed) && trimmed.length > 3_000 && !FAILURE_RE.test(trimmed)) {
    return "large raw JSON blob";
  }

  return null;
}

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
      `[c-mem/post-tool-use] Rejected invalid session_id: "${input.session_id}"\n`
    );
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const toolName = input.tool_name ?? "";
  if (SKIP_TOOLS.has(normalizeToolName(toolName))) {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const pathReason = findSensitivePathInValue(input.tool_input);
  if (pathReason) {
    process.stderr.write(`[c-mem/post-tool-use] Skipping sensitive path capture (${pathReason}) for ${toolName}\n`);
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const command = commandText(input.tool_input);
  const commandReason = command ? detectSensitiveCommand(command) : null;
  if (commandReason) {
    process.stderr.write(`[c-mem/post-tool-use] Skipping sensitive command capture (${commandReason}) for ${toolName}\n`);
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const safeInput = summarizeInput(toolName, input.tool_input ?? {});
  const inputText = stripPrivacyTags(scrubSecrets(scrubValue(safeInput)));

  const rawResponse = stripPrivacyTags(scrubSecrets(String(input.tool_response ?? "")));
  const responseReason = detectSensitiveOutput(rawResponse);
  if (responseReason) {
    process.stderr.write(`[c-mem/post-tool-use] Skipping sensitive output capture (${responseReason}) for ${toolName}\n`);
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const summarizedResponse = summarizeResponse(toolName, input.tool_input ?? {}, rawResponse);
  const noiseReason = shouldSkipForNoise(toolName, input.tool_input ?? {}, summarizedResponse);
  if (noiseReason) {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  const boundedInput = enforcePayloadLimit(inputText);
  const boundedResponse = enforcePayloadLimit(summarizedResponse);
  if (!boundedResponse.trim()) {
    process.stdout.write(JSON.stringify(CONTINUE_OUTPUT) + "\n");
    return;
  }

  try {
    const config = loadConfig();
    const project = projectFromCwd(input.cwd ?? "");

    let payloadInput: unknown = safeInput;
    const trimmedInput = boundedInput.trim();
    if (trimmedInput.startsWith("{") || trimmedInput.startsWith("[")) {
      try {
        payloadInput = JSON.parse(trimmedInput);
      } catch {
        payloadInput = boundedInput;
      }
    } else if (trimmedInput) {
      payloadInput = boundedInput;
    }

    postObservation(workerBaseUrl(config), {
      session_id: input.session_id,
      tool_name: toolName,
      tool_input: payloadInput,
      tool_response: boundedResponse,
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
