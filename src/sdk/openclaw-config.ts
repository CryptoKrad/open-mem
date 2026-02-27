/**
 * OpenClaw Config Reader
 *
 * Reads Anthropic API key and model config from OpenClaw's local config file
 * (~/.openclaw/openclaw.json) as a zero-config fallback for the compressor.
 *
 * This lets Open-Mem piggyback on whatever key OpenClaw has configured,
 * without needing its own ANTHROPIC_API_KEY env var.
 *
 * @module sdk/openclaw-config
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface OpenClawAnthropicConfig {
  /** Set when key is a standard sk-ant-api* key — passed as x-api-key */
  apiKey?: string;
  /** Set when key is an OAuth oat* token — passed as Authorization: Bearer */
  authToken?: string;
  haikuModelId: string;
}

/** Cached config — read once per process lifetime */
let cached: OpenClawAnthropicConfig | null | undefined = undefined;

/**
 * Load Anthropic config from ~/.openclaw/openclaw.json.
 * Returns null if the file is missing, malformed, or has no Anthropic provider.
 * Result is cached after first successful read.
 */
export function loadOpenClawConfig(): OpenClawAnthropicConfig | null {
  if (cached !== undefined) return cached;

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    const providers = (config?.models as Record<string, unknown>)
      ?.providers as Record<string, unknown> | undefined;
    const anthropic = providers?.anthropic as Record<string, unknown> | undefined;
    const apiKey = anthropic?.apiKey as string | undefined;

    if (!apiKey || !apiKey.startsWith("sk-")) {
      process.stderr.write(
        "[c-mem/openclaw-config] No valid Anthropic API key found in ~/.openclaw/openclaw.json\n"
      );
      cached = null;
      return null;
    }

    // Find haiku model ID from the models list
    const models = anthropic?.models as Array<{ id: string }> | undefined;
    const haikuModel = models?.find((m) => m.id.includes("haiku"));
    // OAuth tokens only accept new-style model IDs (no date suffix for haiku-4-5)
    // claude-3-5-haiku-20241022 returns 404 via OAuth; claude-haiku-4-5 works
    const rawId = haikuModel?.id ?? "claude-haiku-4-5";
    const haikuModelId = rawId === "claude-3-5-haiku-20241022" ? "claude-haiku-4-5" : rawId;

    // oat01 tokens use Authorization: Bearer (OAuth flow)
    // Standard sk-ant-api* keys use x-api-key
    const isOAuth = apiKey.includes("oat");
    cached = isOAuth
      ? { authToken: apiKey, haikuModelId }
      : { apiKey, haikuModelId };

    process.stderr.write(
      `[c-mem/openclaw-config] Loaded Anthropic config from OpenClaw ` +
        `(auth: ${isOAuth ? "Bearer/OAuth" : "x-api-key"}, model: ${haikuModelId})\n`
    );
    return cached;
  } catch (err) {
    process.stderr.write(
      `[c-mem/openclaw-config] Failed to read ~/.openclaw/openclaw.json: ${err}\n`
    );
    cached = null;
    return null;
  }
}
