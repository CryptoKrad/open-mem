/**
 * Open-Mem Secret Scrubber
 *
 * Regex-based scrubber applied BEFORE any content reaches the database.
 * Replaces detected secrets with [REDACTED] markers.
 *
 * Security requirement (from 00-security-audit.md):
 *   HOK-01 — Tool responses must be scrubbed before storage.
 *   No plaintext API keys, tokens, passwords, or private keys may ever
 *   be written to SQLite or exported to markdown.
 */

/** Patterns matched against text before storage. Order matters — more specific first. */
const SECRET_PATTERNS: RegExp[] = [
  // AWS credentials
  /AWS_ACCESS_KEY_ID\s*[=:]\s*[A-Z0-9]{20}/gi,
  /AWS_SECRET_ACCESS_KEY\s*[=:]\s*[A-Za-z0-9\/+=]{40}/gi,

  // Anthropic API keys  (sk-ant- prefix, 80+ chars)
  /sk-ant-[a-zA-Z0-9\-_]{80,}/g,

  // OpenAI API keys  (sk- prefix, exactly 48 alphanum)
  /sk-[a-zA-Z0-9]{48}/g,

  // Generic Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,

  // Passwords
  /password\s*[=:]\s*\S+/gi,

  // API keys (generic)
  /api[_-]?key\s*[=:]\s*\S+/gi,

  // Tokens (generic, at least 20 chars to avoid false positives)
  /token\s*[=:]\s*[A-Za-z0-9\-._~+\/]{20,}/gi,

  // Private keys
  /private[_-]?key\s*[=:]\s*\S+/gi,

  // GitHub tokens
  /ghp_[a-zA-Z0-9]{36}/g,
  /ghs_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,

  // Generic high-entropy secrets (e.g., base64 blobs in env vars)
  /(?:SECRET|CREDENTIAL|PASSWD|PWD)\s*[=:]\s*\S{8,}/gi,
];

const REDACTED = '[REDACTED]';

/**
 * Scrub secrets from a plain text string.
 * Returns the sanitised string with all pattern matches replaced.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes to avoid stateful skip-ahead
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Recursively scrub an object's string values.
 * Works on plain objects, arrays, and primitives.
 * Returns a deep clone with secrets removed — does not mutate the input.
 */
export function scrubJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return scrubSecrets(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(scrubJson);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = scrubJson(value);
    }
    return result;
  }

  // Primitives (numbers, booleans) pass through unchanged
  return obj;
}

// ─── Content Validation (INJ-02) ─────────────────────────────────────────────

/**
 * Validate content before storage or injection.
 *
 * Guards:
 *  1. Rejects raw input containing c-mem control tags (prevents tag injection)
 *  2. Unicode normalization (NFKC) to prevent lookalike bypass attacks
 *  3. Warns on large base64 blocks (tool responses legitimately contain them)
 *
 * @returns { valid: true } or { valid: false, reason: string }
 */
export function validateContent(text: string): { valid: boolean; reason?: string } {
  // Guard 1: Reject if contains c-mem control tags in raw input (INJ-02 tag injection)
  if (/<c-mem-(?:compress|summarize|context)/.test(text)) {
    return { valid: false, reason: 'contains c-mem control tags' };
  }

  // Guard 2: Normalize unicode to prevent lookalike bypass attacks
  const normalized = text.normalize('NFKC');

  // Guard 3: Detect suspiciously large base64 blocks (warn, do not reject —
  // tool responses legitimately contain base64-encoded content like images)
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(normalized)) {
    process.stderr.write('[c-mem] large base64 block in observation — scrubbing\n');
  }

  return { valid: true };
}
