import { runFactcheck } from '../hooks/factcheck/index.js';
import { checkSentinelHealth } from '../hooks/factcheck/sentinel.js';
import type { FactcheckResult } from '../hooks/factcheck/types.js';

export interface SentinelReadinessOptions {
  logPath?: string;
  workspace?: string;
  claims?: Record<string, unknown>;
  enabled?: boolean;
}

export interface SentinelGateResult {
  ready: boolean;
  blockers: string[];
  skipped: boolean;
}

function mapFactcheckToBlockers(result: FactcheckResult): string[] {
  if (result.verdict === 'PASS') {
    return [];
  }

  if (result.mismatches.length === 0) {
    return [`[factcheck] verdict ${result.verdict}`];
  }

  return result.mismatches.map(
    mismatch => `[factcheck] ${mismatch.severity} ${mismatch.check}: ${mismatch.detail}`,
  );
}

/**
 * Coerce a value expected to be an array into an actual array.
 * - If already an array, return as-is.
 * - If nullish, return empty array.
 * - Otherwise wrap in a single-element array.
 */
function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'object' && !Array.isArray(value)) return [];
  return [value];
}

/**
 * Validate and coerce a claims object so downstream factcheck code
 * never throws on unexpected shapes (e.g. `{ files_modified: {} }`).
 */
function sanitizeClaims(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  const arrayFields = [
    'files_modified', 'files_created', 'files_deleted',
    'artifacts_expected', 'commands_executed', 'models_used',
  ];
  for (const field of arrayFields) {
    if (field in out) {
      out[field] = coerceArray(out[field]);
    }
  }
  return out;
}

export function checkSentinelReadiness(
  options: SentinelReadinessOptions = {},
): SentinelGateResult {
  const {
    logPath,
    workspace,
    claims,
    enabled = true,
  } = options;

  if (!enabled) {
    return {
      ready: true,
      blockers: [],
      skipped: true,
    };
  }

  const blockers: string[] = [];
  let ranCheck = false;

  if (logPath) {
    ranCheck = true;
    const health = checkSentinelHealth(logPath, workspace);
    blockers.push(...health.blockers);
  }

  if (claims) {
    ranCheck = true;
    try {
      const sanitized = sanitizeClaims(claims);
      const factcheck = runFactcheck(sanitized, { workspace });
      blockers.push(...mapFactcheckToBlockers(factcheck));
    } catch (err) {
      blockers.push(
        `[factcheck] execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fail-closed: if the gate is enabled but no checks ran, do not pass.
  if (!ranCheck) {
    return {
      ready: false,
      blockers: ['[sentinel] gate enabled but no logPath or claims provided — cannot verify readiness'],
      skipped: true,
    };
  }

  const dedupedBlockers = [...new Set(blockers)];
  return {
    ready: dedupedBlockers.length === 0,
    blockers: dedupedBlockers,
    skipped: false,
  };
}
