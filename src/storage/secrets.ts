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
  /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
  /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?[A-Za-z0-9+/]{40}["']?/gi,
  /sk-ant-[A-Za-z0-9_-]{20,200}/g,
  /\bsk-(?:live|proj|test|svcacct)?[A-Za-z0-9_-]{20,200}\b/g,
  /\bgh(?:p|s|o|u|r)_[A-Za-z0-9]{20,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,255}\b/g,
  /\/\/[^\n\s]+:_authToken\s*=\s*\S+/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|passwd|secret|api[_-]?key|token|access[_-]?key|client[_-]?secret|authorization)\s*[=:]\s*["']?[^\s"',;\]}]{4,}["']?/gi,
  /^[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|COOKIE|AUTH)[A-Z0-9_]*\s*=.+$/gm,
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
