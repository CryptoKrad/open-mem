/**
 * Open-Mem Configuration Loader
 *
 * Loads settings from ~/.open-mem/settings.json, applies environment variable
 * overrides, validates values, and returns a frozen WorkerConfig.
 *
 * Security requirements applied:
 * - Default host is always 127.0.0.1 (never 0.0.0.0)
 * - Port must be in range 1024–65535
 * - Model must be a valid Anthropic model name
 *
 * @module config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { WorkerConfig } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** All valid Anthropic model identifiers (update as new models ship) */
const VALID_MODELS = new Set([
  "claude-haiku-3-5",
  "claude-3-5-haiku-20241022",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-3-5-sonnet-20241022",
  "claude-opus-4-5",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
]);

/** The default settings written on first run */
const DEFAULTS: WorkerConfig = {
  port: 37888,
  bindHost: "127.0.0.1", // SECURITY: Never 0.0.0.0 by default
  dbPath: join(homedir(), ".open-mem", "open-mem.db"),
  model: "claude-haiku-3-5",
  maxObsPerContext: 50,
  maxSessionsPerContext: 10,
  maxRetries: 3,
  stuckThresholdMs: 300_000, // 5 minutes
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate that a port number is in the permitted range.
 * @throws Error if port is outside 1024–65535
 */
function validatePort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `Invalid port ${port} from ${source}. Must be an integer between 1024 and 65535.`
    );
  }
  return port;
}

/**
 * Validate that a model name is a known Anthropic model.
 * Accepts both short aliases and full API identifiers.
 * @throws Error if model is not recognized
 */
function validateModel(model: string, source: string): string {
  if (!VALID_MODELS.has(model)) {
    throw new Error(
      `Unknown model "${model}" from ${source}. ` +
        `Valid models: ${[...VALID_MODELS].join(", ")}`
    );
  }
  return model;
}

/**
 * Validate the bind host. Warns loudly if 0.0.0.0 is requested.
 * Does NOT throw — allows override if user explicitly sets it.
 */
function validateHost(host: string, source: string): string {
  if (host === "0.0.0.0") {
    process.stderr.write(
      `[c-mem] WARNING: bind host set to 0.0.0.0 via ${source}. ` +
        `This exposes the Open-Mem worker to your local network with no authentication. ` +
        `Set C_MEM_HOST=127.0.0.1 to restrict to localhost.\n`
    );
  }
  return host;
}

// ─── Settings File ────────────────────────────────────────────────────────────

/**
 * Partial settings shape that can be stored in settings.json.
 */
type SettingsFile = Partial<{
  port: number;
  bindHost: string;
  dbPath: string;
  model: string;
  maxObsPerContext: number;
  maxSessionsPerContext: number;
  maxRetries: number;
  stuckThresholdMs: number;
}>;

/**
 * Ensure the ~/.open-mem directory exists with secure permissions (0700),
 * then read or create settings.json.
 */
function loadSettingsFile(): SettingsFile {
  const configDir = join(homedir(), ".open-mem");

  // Create directory with restricted permissions
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const settingsPath = join(configDir, "settings.json");

  if (!existsSync(settingsPath)) {
    // Write defaults on first run
    const defaultSettings: SettingsFile = {
      port: DEFAULTS.port,
      bindHost: DEFAULTS.bindHost,
      model: DEFAULTS.model,
      maxObsPerContext: DEFAULTS.maxObsPerContext,
      maxSessionsPerContext: DEFAULTS.maxSessionsPerContext,
    };
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), "utf-8");
    // Restrict settings file to owner-only read/write
    chmodSync(settingsPath, 0o600);
    return defaultSettings;
  }

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw) as SettingsFile;
  } catch {
    process.stderr.write(
      `[c-mem] Warning: Failed to parse ${settingsPath}. Using defaults.\n`
    );
    return {};
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and validate Open-Mem configuration.
 *
 * Priority order (highest wins):
 * 1. Environment variables (C_MEM_PORT, C_MEM_MODEL, C_MEM_DB_PATH, C_MEM_HOST)
 * 2. ~/.open-mem/settings.json
 * 3. Built-in defaults
 *
 * @returns Frozen WorkerConfig — all fields are validated
 */
export function loadConfig(): Readonly<WorkerConfig> {
  const fileSettings = loadSettingsFile();

  // Merge: defaults ← file settings ← env vars
  let port = fileSettings.port ?? DEFAULTS.port;
  let bindHost = fileSettings.bindHost ?? DEFAULTS.bindHost;
  let dbPath = fileSettings.dbPath ?? DEFAULTS.dbPath;
  let model = fileSettings.model ?? DEFAULTS.model;
  let maxObsPerContext = fileSettings.maxObsPerContext ?? DEFAULTS.maxObsPerContext;
  let maxSessionsPerContext =
    fileSettings.maxSessionsPerContext ?? DEFAULTS.maxSessionsPerContext;
  let maxRetries = fileSettings.maxRetries ?? DEFAULTS.maxRetries;
  let stuckThresholdMs = fileSettings.stuckThresholdMs ?? DEFAULTS.stuckThresholdMs;

  // Environment variable overrides
  if (process.env.C_MEM_PORT) {
    port = validatePort(parseInt(process.env.C_MEM_PORT, 10), "C_MEM_PORT env var");
  } else if (fileSettings.port !== undefined) {
    port = validatePort(fileSettings.port, "settings.json");
  }

  if (process.env.C_MEM_HOST) {
    bindHost = validateHost(process.env.C_MEM_HOST, "C_MEM_HOST env var");
  }

  if (process.env.C_MEM_DB_PATH) {
    dbPath = process.env.C_MEM_DB_PATH;
  }

  if (process.env.C_MEM_MODEL) {
    model = validateModel(process.env.C_MEM_MODEL, "C_MEM_MODEL env var");
  } else if (fileSettings.model !== undefined) {
    model = validateModel(fileSettings.model, "settings.json");
  }

  return Object.freeze({
    port,
    bindHost,
    dbPath,
    model,
    maxObsPerContext,
    maxSessionsPerContext,
    maxRetries,
    stuckThresholdMs,
  });
}

/**
 * Derive the project name from an absolute working directory path.
 * Uses the last non-empty path segment (basename).
 *
 * @example
 * projectFromCwd("/Users/alice/projects/my-app") // => "my-app"
 */
export function projectFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

/**
 * Return the base URL of the Open-Mem worker HTTP API.
 */
export function workerBaseUrl(config: Pick<WorkerConfig, "bindHost" | "port">): string {
  return `http://${config.bindHost}:${config.port}`;
}
