/**
 * Open-Mem Privacy & Secret Scrubbing Utilities
 *
 * All content that enters Open-Mem must pass through this module before storage.
 * Secrets are stripped at the edge (in hooks) before they ever reach the DB
 * or worker. Defense in depth: worker also strips before LLM calls.
 *
 * Security requirements applied:
 * - AWS access key values
 * - Anthropic/OpenAI API keys (sk-ant-*, sk-*, etc.)
 * - Bearer tokens in HTTP headers
 * - Password field assignments (password=, PASSWORD=, etc.)
 * - .env KEY=VALUE pairs (HIGH_ENTROPY_VALUE patterns)
 * - JWTs (header.payload.signature format)
 *
 * @module hooks/privacy
 */

// ─── Session ID Validation ────────────────────────────────────────────────────

/**
 * Regex that a valid session_id must match.
 * Accepts UUID format and extended UUID-like identifiers used by Claude Code.
 * Rejects anything containing path characters, shell metacharacters, etc.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Validate that a session_id is safe to use as a query parameter or
 * database key. Rejects path traversal characters and shell metacharacters.
 *
 * @param sessionId - Raw session_id from hook stdin
 * @returns true if the session_id is safe, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== "string") return false;
  if (sessionId.length < 8 || sessionId.length > 128) return false;
  return SESSION_ID_PATTERN.test(sessionId);
}

// ─── Secret Scrubbing ─────────────────────────────────────────────────────────

/** Replacement placeholder for scrubbed secrets */
const REDACTED = "[REDACTED]";

/**
 * Patterns and their replacement strategies.
 * Order matters: more specific patterns first (API keys before generic password= check).
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS Access Key IDs (20-char uppercase alphanumeric starting with AKIA/ASIA/AROA/AIDA)
  {
    pattern: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED:aws-key-id]",
  },
  // AWS Secret Access Key value (40-char base64-ish after "aws_secret_access_key=")
  {
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9+/]{40})["']?/gi,
    replacement: "aws_secret_access_key=[REDACTED:aws-secret]",
  },
  // Anthropic API keys — MUST be before generic credential pattern
  {
    pattern: /sk-ant-[A-Za-z0-9_-]{20,200}/g,
    replacement: "[REDACTED:anthropic-key]",
  },
  // OpenAI / generic sk- API keys — MUST be before generic credential pattern
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,200}/g,
    replacement: "[REDACTED:openai-key]",
  },
  // Generic Bearer tokens in HTTP headers
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "Bearer [REDACTED:bearer-token]",
  },
  // JWTs: three base64url segments separated by dots (each ≥10 chars)
  {
    pattern: /\b[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  // URL-embedded credentials: scheme://user:password@host
  {
    pattern: /([a-z][a-z0-9+\-.]*:\/\/[^:@\s]*):([^@\s]{4,})@/gi,
    replacement: "$1:[REDACTED:url-credential]@",
  },
  // Password / secret / token assignments: password=VALUE or PASSWORD: VALUE
  // Runs AFTER specific API key patterns to avoid double-labelling
  {
    pattern: /(?:password|passwd|secret|api_key|apikey|token)\s*[=:]\s*["']?[^\s"',;\[\]]{4,}["']?/gi,
    replacement: (match: string) => {
      const key = match.split(/[=:]/)[0].trim();
      return `${key}=[REDACTED:credential]`;
    },
  } as unknown as { pattern: RegExp; replacement: string },
  // .env style KEY=VALUE where VALUE looks like a secret (≥16 chars).
  // Excludes [ and ] so it won't match values already replaced by earlier patterns.
  {
    pattern: /^([A-Z][A-Z0-9_]{4,})\s*=\s*["']?([A-Za-z0-9+/=_\-!@#$%^&*.:,;?@]{16,})["']?$/gm,
    replacement: "$1=[REDACTED:env-secret]",
  },
];

/**
 * Scrub known secret patterns from a string.
 * Non-destructive to surrounding text — only matching substrings are replaced.
 *
 * @param input - Raw string that may contain secrets
 * @returns Scrubbed string with secrets replaced by [REDACTED:type] markers
 */
export function scrubSecrets(input: string): string {
  if (!input || typeof input !== "string") return input;

  let result = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    if (typeof replacement === "string") {
      result = result.replace(pattern, replacement);
    } else {
      // Replacement is a function (for password= pattern)
      result = result.replace(pattern, replacement as string);
    }
  }
  return result;
}

/**
 * Scrub secrets from an arbitrary value.
 * If the value is an object/array, it is JSON-serialized, scrubbed, then
 * returned as a string. If it is already a string, scrub in place.
 *
 * @param value - Any JSON-serializable value
 * @returns Scrubbed string representation
 */
export function scrubValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return scrubSecrets(str);
}

// ─── Privacy Tags ─────────────────────────────────────────────────────────────

/** Max tag replacements per call — prevents ReDoS via deeply nested tags */
const MAX_TAG_REPLACEMENTS = 100;

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const C_MEM_CONTEXT_TAG_RE = /<c-mem-context>[\s\S]*?<\/c-mem-context>/gi;

/**
 * Strip <private>...</private> and <c-mem-context>...</c-mem-context> tags
 * from a string. The latter prevents injected memory context from being
 * re-ingested as a new observation (recursion prevention).
 *
 * @param text - Input text possibly containing privacy tags
 * @returns Text with privacy tags and their content removed
 */
export function stripPrivacyTags(text: string): string {
  if (!text || typeof text !== "string") return text;

  let count = 0;
  let result = text.replace(PRIVATE_TAG_RE, () => {
    return ++count <= MAX_TAG_REPLACEMENTS ? "" : "";
  });

  count = 0;
  result = result.replace(C_MEM_CONTEXT_TAG_RE, () => {
    return ++count <= MAX_TAG_REPLACEMENTS ? "" : "";
  });

  return result.trim();
}

/**
 * Returns true if the text is entirely composed of private content —
 * i.e. it contains at least one privacy tag, and nothing remains after
 * stripping all tags and whitespace.
 *
 * Empty strings return false: they are empty, not private.
 * The caller should handle empty prompts separately.
 */
export function isFullyPrivate(text: string): boolean {
  if (!text || text.trim() === "") return false;
  const stripped = stripPrivacyTags(text).trim();
  return stripped === "";
}

// ─── Payload Size Limiter ─────────────────────────────────────────────────────

/** Maximum bytes for any single observation payload (50 KB) */
const MAX_PAYLOAD_BYTES = 50 * 1024;

/**
 * Truncate a string to the maximum allowed payload size (50 KB).
 * Appends a notice so the LLM knows content was cut.
 *
 * @param text - String to enforce size limit on
 * @returns String that is ≤ MAX_PAYLOAD_BYTES bytes (UTF-8)
 */
export function enforcePayloadLimit(text: string): string {
  const encoded = Buffer.from(text, "utf-8");
  if (encoded.byteLength <= MAX_PAYLOAD_BYTES) return text;

  const truncated = encoded.slice(0, MAX_PAYLOAD_BYTES).toString("utf-8");
  // Trim to last complete character (Buffer slice may break multi-byte chars)
  const safe = truncated.replace(/[\uFFFD\uD800-\uDFFF]+$/, "");
  return safe + "\n[...truncated: payload exceeded 50KB limit]";
}
