/**
 * Open-Mem Auth Token System
 *
 * Generates a persistent HMAC-safe random token on first run and stores it
 * at ~/.open-mem/auth.token with 0600 permissions.
 *
 * All HTTP endpoints (except GET /health) require:
 *   Authorization: Bearer <token>
 *
 * Security: AUTH-01, AUTH-02, AUTH-03
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export const TOKEN_PATH = join(
  process.env['C_MEM_DATA_DIR'] ?? join(process.env['HOME'] ?? '/tmp', '.open-mem'),
  'auth.token'
);

/**
 * Generate and persist a token on first run.
 * Returns the existing token if already created.
 */
export function ensureAuthToken(): string {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, 'utf-8').trim();
  }

  // Ensure directory exists
  const dir = dirname(TOKEN_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    // Non-fatal — file was written with correct mode above
  }

  console.error(`[c-mem] Auth token created at ${TOKEN_PATH}`);
  return token;
}

/**
 * Timing-safe Bearer token verification.
 * Returns false if header is absent, malformed, or token doesn't match.
 */
export function verifyBearer(authHeader: string | undefined | null, expectedToken: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken));
  } catch {
    // timingSafeEqual throws if buffers have different lengths
    return false;
  }
}

/**
 * Read the auth token from disk (for hooks that need to authenticate).
 * Returns null if the token file does not exist yet.
 */
export function readAuthToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  return readFileSync(TOKEN_PATH, 'utf-8').trim();
}
