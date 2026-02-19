/**
 * LLM-02: Anomaly Detection on Retrieved Context
 *
 * Scans observations before they are injected into Claude's session context.
 * Flags and optionally quarantines suspicious observations.
 *
 * Threat model:
 *   1. Prompt injection  — imperative instructions hidden in observation text
 *   2. Type confusion    — unknown obs_type to bypass downstream filters
 *   3. Context stuffing  — anomalously large observation consuming token budget
 *   4. HMAC tampering    — missing/mismatched HMAC (complement to INJ-04)
 */

export type AnomalyResult = {
  clean: boolean;
  flags: AnomalyFlag[];
};

export type AnomalyFlag = {
  type: 'prompt-injection' | 'type-confusion' | 'size-anomaly' | 'structural' | 'hmac-mismatch';
  severity: 'warn' | 'block';
  detail: string;
};

// ─── Prompt Injection Patterns ────────────────────────────────────────────────

/** Common prompt-injection phrases, checked case-insensitively against all text fields. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|context|prompt)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /new\s+(system\s+)?(prompt|instructions?|context|rules?)\s*:/i,
  /\[\s*system\s*\]/i,
  /\[\s*assistant\s*\]/i,
  /\[\s*human\s*\]/i,
  /\[\s*inst\s*\]/i,                               // Llama-style injection
  /<\s*\|?\s*(system|user|assistant)\s*\|?\s*>/i,  // ChatML injection
  /IMPORTANT:\s*(you must|always|never|ignore)/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions?|context)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /pretend\s+(you\s+are|to\s+be)\s+(not\s+an?\s+ai|a\s+human)/i,
];

// ─── Valid Observation Types ──────────────────────────────────────────────────

/**
 * Valid obs_type values (raw storage) and type values (BBObservation).
 * Any observation with a type outside this set is flagged as structural/block.
 */
const VALID_OBS_TYPES = new Set([
  // raw storage obs_type values
  'bugfix', 'feature', 'refactor', 'config',
  'research', 'error', 'decision', 'other',
  // BBObservation type values (may overlap or extend)
  'discovery', 'change',
]);

// ─── Size Thresholds ─────────────────────────────────────────────────────────

/** Narrative+compressed total above this → size-anomaly warn */
const MAX_CLEAN_NARRATIVE_CHARS = 8_000;
/** Narrative+compressed total above this → size-anomaly block */
const MAX_BLOCK_CHARS = 50_000;

// ─── Input Type ──────────────────────────────────────────────────────────────

/**
 * Flexible observation input type — accepts both raw storage rows
 * (obs_type, compressed, hmac) and mapped BBObservation (type, narrative).
 */
export type ObsInput = {
  id: number;
  /** Raw storage type field */
  obs_type?: string | null;
  /** BBObservation mapped type field */
  type?: string | null;
  title?: string | null;
  narrative?: string | null;
  compressed?: string | null;
  hmac?: string | null;
};

// ─── Core Detection ──────────────────────────────────────────────────────────

/**
 * Run anomaly checks on a single observation.
 *
 * Checks (in order):
 *  1. Structural: obs_type must be in the allow-list
 *  2. Structural: must have narrative or compressed content
 *  3. Prompt-injection scan across title + narrative + compressed
 *  4. Size anomaly: warn >8 KB, block >50 KB
 *  5. HMAC: warn if hmac field is null/undefined
 */
export function detectAnomalies(obs: ObsInput): AnomalyResult {
  const flags: AnomalyFlag[] = [];

  // Resolve type from whichever field is present
  const obsType = obs.obs_type ?? obs.type ?? '';

  // ── 1. Structural: valid type required ──
  if (!VALID_OBS_TYPES.has(obsType)) {
    flags.push({
      type: 'structural',
      severity: 'block',
      detail: `Unknown obs_type: "${obsType}"`,
    });
  }

  // ── 2. Structural: must have some content ──
  if (!obs.narrative && !obs.compressed) {
    flags.push({
      type: 'structural',
      severity: 'warn',
      detail: 'Observation has no narrative or compressed content',
    });
  }

  // ── 3. Prompt injection scan: title + narrative + compressed ──
  const textToScan = [obs.title, obs.narrative, obs.compressed]
    .filter(Boolean)
    .join(' ');

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(textToScan)) {
      flags.push({
        type: 'prompt-injection',
        severity: 'block',
        detail: `Matched injection pattern: ${pattern.source.slice(0, 60)}`,
      });
      break; // one flag per observation is enough
    }
  }

  // ── 4. Size anomaly ──
  const totalChars =
    (obs.narrative?.length ?? 0) + (obs.compressed?.length ?? 0);
  if (totalChars > MAX_BLOCK_CHARS) {
    flags.push({
      type: 'size-anomaly',
      severity: 'block',
      detail: `Content ${totalChars} chars exceeds hard limit (${MAX_BLOCK_CHARS})`,
    });
  } else if (totalChars > MAX_CLEAN_NARRATIVE_CHARS) {
    flags.push({
      type: 'size-anomaly',
      severity: 'warn',
      detail: `Content ${totalChars} chars is unusually large`,
    });
  }

  // ── 5. HMAC: warn if absent (complement to INJ-04 full verification) ──
  // Only warn when hmac key is explicitly present in the object but null/undefined.
  // For mapped BBObservations that don't carry hmac, we skip this check.
  if ('hmac' in obs && (obs.hmac === null || obs.hmac === undefined)) {
    flags.push({
      type: 'hmac-mismatch',
      severity: 'warn',
      detail: 'Observation missing HMAC — may be pre-migration or tampered',
    });
  }

  const blockingFlags = flags.filter(f => f.severity === 'block');
  return {
    clean: blockingFlags.length === 0,
    flags,
  };
}

// ─── Batch Filter ─────────────────────────────────────────────────────────────

/**
 * Filter a list of observations, logging anomalies and excluding blocked ones.
 *
 * - Blocked observations (any 'block' severity flag) are removed from context.
 * - Warned observations are logged but still included.
 *
 * @returns The subset of observations that pass anomaly detection.
 */
export function filterObservations<T extends ObsInput>(
  observations: T[],
  logPrefix = '[c-mem anomaly]'
): T[] {
  return observations.filter(obs => {
    const result = detectAnomalies(obs);

    if (!result.clean) {
      // Log all flags (including warns) for blocked observations
      for (const flag of result.flags) {
        process.stderr.write(
          `${logPrefix} obs #${obs.id} [${flag.severity}] ${flag.type}: ${flag.detail}\n`
        );
      }
      return false; // exclude from context
    }

    if (result.flags.length > 0) {
      // Warn-only: log but include in context
      for (const flag of result.flags) {
        process.stderr.write(
          `${logPrefix} obs #${obs.id} [warn] ${flag.type}: ${flag.detail}\n`
        );
      }
    }

    return true;
  });
}
