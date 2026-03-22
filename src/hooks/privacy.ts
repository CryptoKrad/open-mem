/**
 * Open-Mem Privacy & Secret Scrubbing Utilities
 *
 * All content that enters Open-Mem must pass through this module before storage.
 * Secrets are stripped at the edge (in hooks) before they ever reach the DB
 * or worker. Defense in depth: worker also strips before LLM calls.
 *
 * @module hooks/privacy
 */

import { homedir } from "os";
import { basename } from "path";

// ─── Session ID Validation ────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== "string") return false;
  if (sessionId.length < 8 || sessionId.length > 128) return false;
  return SESSION_ID_PATTERN.test(sessionId);
}

// ─── Secret Scrubbing ─────────────────────────────────────────────────────────

type Replacement = string | ((substring: string, ...args: string[]) => string);

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: Replacement }> = [
  {
    pattern: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED:aws-key-id]",
  },
  {
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9+/]{40})["']?/gi,
    replacement: "aws_secret_access_key=[REDACTED:aws-secret]",
  },
  {
    pattern: /sk-ant-[A-Za-z0-9_-]{20,200}/g,
    replacement: "[REDACTED:anthropic-key]",
  },
  {
    pattern: /\bsk-(?:live|proj|test|svcacct)?[A-Za-z0-9_-]{20,200}\b/g,
    replacement: "[REDACTED:openai-key]",
  },
  {
    pattern: /\bgh(?:p|s|o|u|r)_[A-Za-z0-9]{20,255}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    pattern: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,255}\b/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    pattern: /\/\/[^\s]+:_authToken\s*=\s*\S+/g,
    replacement: "//registry.example/:_authToken=[REDACTED:npm-token]",
  },
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "Bearer [REDACTED:bearer-token]",
  },
  {
    pattern: /\b[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    pattern: /([a-z][a-z0-9+\-.]*:\/\/[^:@\s]*):([^@\s]{4,})@/gi,
    replacement: "$1:[REDACTED:url-credential]@",
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key-block]",
  },
  {
    pattern: /(?:password|passwd|secret|api[_-]?key|token|access[_-]?key|client[_-]?secret|authorization)\s*[=:]\s*["']?[^\s"',;\[\]}]{4,}["']?/gi,
    replacement: (match: string) => {
      const key = match.split(/[=:]/)[0]?.trim() || "credential";
      return `${key}=[REDACTED:credential]`;
    },
  },
  {
    pattern: /^([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|COOKIE|CREDENTIALS|AUTH)[A-Z0-9_]*)\s*=\s*["']?(?!\[REDACTED)(.{8,})["']?$/gm,
    replacement: "$1=[REDACTED:env-secret]",
  },
];

export function scrubSecrets(input: string): string {
  if (!input || typeof input !== "string") return input;

  let result = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement as string);
  }
  return result;
}

export function scrubValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return scrubSecrets(str);
}

// ─── Sensitive path / command / output detection ─────────────────────────────

const HOME_DIR = homedir().replace(/\\/g, "/").toLowerCase();
const SENSITIVE_PATH_TESTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.env(?:\.|$)/i, reason: ".env file" },
  { pattern: /(^|\/)\.openclaw(\/|$)/i, reason: "OpenClaw private state" },
  { pattern: /(^|\/)\.ssh(\/|$)/i, reason: "SSH material" },
  { pattern: /(^|\/)\.gnupg(\/|$)/i, reason: "GPG material" },
  { pattern: /(^|\/)\.aws(\/|$)/i, reason: "AWS credentials" },
  { pattern: /(^|\/)\.npmrc$/i, reason: "npm auth config" },
  { pattern: /(^|\/)\.pypirc$/i, reason: "PyPI auth config" },
  { pattern: /(^|\/)\.netrc$/i, reason: "netrc credentials" },
  { pattern: /(^|\/)\.docker\/config\.json$/i, reason: "Docker credentials" },
  { pattern: /(^|\/)auth\.token$/i, reason: "auth token file" },
  { pattern: /(^|\/)openclaw\.json$/i, reason: "OpenClaw config" },
  { pattern: /(^|\/)(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/i, reason: "SSH key material" },
  { pattern: /(^|\/)(?:credentials|config)$/i, reason: "credential file" },
];

const SENSITIVE_COMMAND_TESTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\s)(?:env|printenv)(\s|$)/i, reason: "environment dump" },
  { pattern: /(^|\s)set(\s|$)/i, reason: "shell environment dump" },
  { pattern: /cat\s+[^\n]*\.env(\.|\s|$)/i, reason: ".env read" },
  { pattern: /cat\s+[^\n]*auth\.token(\s|$)/i, reason: "token file read" },
  { pattern: /cat\s+[^\n]*openclaw\.json(\s|$)/i, reason: "OpenClaw config read" },
  { pattern: /security\s+find-(?:generic|internet)-password/i, reason: "macOS keychain read" },
  { pattern: /op\s+(?:read|item|get)/i, reason: "1Password secret read" },
  { pattern: /pass\s+/i, reason: "password store read" },
  { pattern: /gpg\s+.*(?:--decrypt|-d)/i, reason: "secret decryption" },
  { pattern: /aws\s+configure\s+(?:get|export-credentials)/i, reason: "AWS credential read" },
  { pattern: /(?:^|\s)(?:vault|doppler)\s+(?:read|secrets|kv)/i, reason: "secret manager read" },
];

function normalizePathCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const expanded = trimmed.startsWith("~/")
    ? `${homedir().replace(/\\/g, "/")}/${trimmed.slice(2)}`
    : trimmed;
  return expanded.replace(/\\/g, "/").toLowerCase();
}

export function detectSensitivePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = normalizePathCandidate(value);
  if (!candidate) return null;

  for (const test of SENSITIVE_PATH_TESTS) {
    if (test.pattern.test(candidate)) return test.reason;
  }

  if (candidate.startsWith(HOME_DIR) && /(\/|^)(?:\.openclaw|\.ssh|\.gnupg|\.aws)(\/|$)/i.test(candidate)) {
    return "private home-directory secret";
  }

  const base = basename(candidate);
  if (/^\.env(?:\..+)?$/i.test(base)) return ".env file";
  return null;
}

export function findSensitivePathInValue(value: unknown): string | null {
  if (typeof value === "string") {
    return detectSensitivePath(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSensitivePathInValue(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:^|_)(?:path|file|files|cwd|outPath|filePath|paths|source|target|destination)$/i.test(key)) {
      const found = findSensitivePathInValue(nested);
      if (found) return found;
    }
  }
  return null;
}

export function detectSensitiveCommand(command: string): string | null {
  if (!command || typeof command !== "string") return null;
  const scrubbed = command.trim();
  if (!scrubbed) return null;
  for (const test of SENSITIVE_COMMAND_TESTS) {
    if (test.pattern.test(scrubbed)) return test.reason;
  }
  return null;
}

export function detectSensitiveOutput(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return "private key block";
  if (/Bearer\s+[A-Za-z0-9\-._~+/]+=*/i.test(text)) return "bearer token";
  if (/\bgh(?:p|s|o|u|r)_[A-Za-z0-9]{20,255}\b/.test(text)) return "GitHub token";
  if (/\bgithub_pat_[A-Za-z0-9_]{40,255}\b/.test(text)) return "GitHub token";
  if (/\bsk-ant-[A-Za-z0-9_-]{20,200}\b/.test(text)) return "Anthropic key";
  if (/\bsk-(?:live|proj|test|svcacct)?[A-Za-z0-9_-]{20,200}\b/.test(text)) return "API key";
  if (/\b[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}\b/.test(text)) return "JWT";

  const secretAssignments = text.match(/^[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|COOKIE|AUTH)[A-Z0-9_]*\s*=.+$/gm);
  if (secretAssignments && secretAssignments.length >= 2) return "secret-bearing env dump";

  return null;
}

// ─── Privacy Tags ─────────────────────────────────────────────────────────────

const MAX_TAG_REPLACEMENTS = 100;
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const C_MEM_CONTEXT_TAG_RE = /<c-mem-context>[\s\S]*?<\/c-mem-context>/gi;

export function stripPrivacyTags(text: string): string;
export function stripPrivacyTags(text: null | undefined): null | undefined;
export function stripPrivacyTags(text: string | null | undefined): string | null | undefined {
  if (!text || typeof text !== "string") return text;

  let count = 0;
  let result = text.replace(PRIVATE_TAG_RE, () => (++count <= MAX_TAG_REPLACEMENTS ? "" : ""));

  count = 0;
  result = result.replace(C_MEM_CONTEXT_TAG_RE, () => (++count <= MAX_TAG_REPLACEMENTS ? "" : ""));

  return result.trim();
}

export function isFullyPrivate(text: string): boolean {
  if (!text || text.trim() === "") return false;
  const stripped = stripPrivacyTags(text).trim();
  return stripped === "";
}

// ─── Payload Size Limiter ─────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 50 * 1024;

export function enforcePayloadLimit(text: string): string {
  const encoded = Buffer.from(text, "utf-8");
  if (encoded.byteLength <= MAX_PAYLOAD_BYTES) return text;

  const truncated = encoded.slice(0, MAX_PAYLOAD_BYTES).toString("utf-8");
  const safe = truncated.replace(/[\uFFFD\uD800-\uDFFF]+$/, "");
  return safe + "\n[...truncated: payload exceeded 50KB limit]";
}
