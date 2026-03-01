/**
 * Factcheck Guard - Main Entry Point
 *
 * Portable factcheck engine that validates a claims payload against
 * configurable policies. Ported from rolldav/portable-omc-guards (issue #1155).
 *
 * Modes:
 *   - strict:   All gates must be true, cwd mismatch is FAIL
 *   - declared:  Warns on false gates if source files exist
 *   - manual:   Same as declared
 *   - quick:    Skips cwd parity check by default
 */

import type {
  FactcheckClaims,
  FactcheckMode,
  FactcheckPolicy,
  FactcheckResult,
  Mismatch,
  Severity,
} from './types.js';
import {
  checkMissingFields,
  checkMissingGates,
  getFalseGates,
  sourceFileCount,
  checkPaths,
  checkCommands,
  checkCwdParity,
} from './checks.js';
import { loadGuardsConfig } from './config.js';

export type {
  FactcheckClaims,
  FactcheckMode,
  FactcheckPolicy,
  FactcheckResult,
  Mismatch,
  Severity,
} from './types.js';
export { loadGuardsConfig, shouldUseStrictMode } from './config.js';

// ---------------------------------------------------------------------------
// Severity ranking
// ---------------------------------------------------------------------------

function severityRank(value: Severity): number {
  if (value === 'FAIL') return 2;
  if (value === 'WARN') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Main check runner
// ---------------------------------------------------------------------------

/**
 * Run the portable factcheck logic against a claims payload.
 *
 * @param claims     - The claims payload to validate
 * @param mode       - Validation mode: strict | declared | manual | quick
 * @param policy     - Factcheck policy (loaded from config or provided)
 * @param runtimeCwd - Runtime working directory (defaults to process.cwd())
 * @returns Factcheck result with verdict, mismatches, notes, and evidence
 */
export function runChecks(
  claims: Record<string, unknown>,
  mode: FactcheckMode,
  policy: FactcheckPolicy,
  runtimeCwd?: string,
): FactcheckResult {
  const mismatches: Mismatch[] = [];
  const notes: string[] = [];

  // A. Missing required fields
  const missingFields = checkMissingFields(claims);
  if (missingFields.length > 0) {
    mismatches.push({
      check: 'A',
      severity: 'FAIL',
      detail: `Missing required fields: ${JSON.stringify(missingFields)}`,
    });
  }

  // A. Missing required gates
  const missingGates = checkMissingGates(claims);
  if (missingGates.length > 0) {
    mismatches.push({
      check: 'A',
      severity: 'FAIL',
      detail: `Missing required gates: ${JSON.stringify(missingGates)}`,
    });
  }

  // B. Gate value checks
  const falseGates = getFalseGates(claims);
  const srcFiles = sourceFileCount(claims);

  if (mode === 'strict' && falseGates.length > 0) {
    mismatches.push({
      check: 'B',
      severity: 'FAIL',
      detail: `Strict mode requires all gates true, got false: ${JSON.stringify(falseGates)}`,
    });
  } else if (
    (mode === 'declared' || mode === 'manual') &&
    falseGates.length > 0 &&
    policy.warn_on_unverified_gates
  ) {
    if (srcFiles > 0 || policy.warn_on_unverified_gates_when_no_source_files) {
      mismatches.push({
        check: 'B',
        severity: 'WARN',
        detail: `Unverified gates in declared/manual mode: ${JSON.stringify(falseGates)}`,
      });
    } else {
      notes.push('No source files declared; unverified gates are ignored by policy');
    }
  }

  // H/C. Path checks
  mismatches.push(...checkPaths(claims, policy));

  // H. Command checks
  mismatches.push(...checkCommands(claims, policy));

  // CWD parity
  const claimsCwd = String(claims.cwd ?? '').trim();
  const cwdMismatch = checkCwdParity(
    claimsCwd,
    runtimeCwd ?? process.cwd(),
    mode,
    policy,
  );
  if (cwdMismatch) {
    mismatches.push(cwdMismatch);
  }

  // Compute verdict from worst severity
  const maxRank = mismatches.reduce(
    (max, m) => Math.max(max, severityRank(m.severity)),
    0,
  );
  let verdict: Severity = 'PASS';
  if (maxRank === 2) verdict = 'FAIL';
  else if (maxRank === 1) verdict = 'WARN';

  return {
    verdict,
    mode,
    mismatches,
    notes,
    claims_evidence: {
      source_files: srcFiles,
      commands_count: ((claims.commands_executed as string[]) ?? []).length,
      models_count: ((claims.models_used as string[]) ?? []).length,
    },
  };
}

/**
 * Convenience wrapper: load config and run checks in one call.
 */
export function runFactcheck(
  claims: Record<string, unknown>,
  options?: {
    mode?: FactcheckMode;
    runtimeCwd?: string;
    workspace?: string;
  },
): FactcheckResult {
  const config = loadGuardsConfig(options?.workspace);
  const mode = options?.mode ?? (config.factcheck.mode as FactcheckMode);
  return runChecks(claims, mode, config.factcheck, options?.runtimeCwd);
}
