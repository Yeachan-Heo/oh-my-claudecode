/**
 * Factcheck Guard Types
 *
 * TypeScript types for the portable factcheck guard and sentinel health analyzer.
 * Ported from rolldav/portable-omc-guards (issue #1155).
 */

// ---------------------------------------------------------------------------
// Factcheck Claims
// ---------------------------------------------------------------------------

export interface FactcheckGates {
  selftest_ran: boolean;
  goldens_ran: boolean;
  sentinel_stop_smoke_ran: boolean;
  shadow_leak_check_ran: boolean;
  [key: string]: boolean;
}

export interface FactcheckClaims {
  schema_version: string;
  run_id: string;
  ts: string;
  cwd: string;
  mode: string;
  files_modified: string[];
  files_created: string[];
  files_deleted?: string[];
  artifacts_expected: string[];
  gates: FactcheckGates;
  commands_executed?: string[];
  models_used?: string[];
}

// ---------------------------------------------------------------------------
// Policy / Config
// ---------------------------------------------------------------------------

export interface FactcheckPolicy {
  enabled: boolean;
  mode: FactcheckMode;
  strict_project_patterns: string[];
  forbidden_path_prefixes: string[];
  forbidden_path_substrings: string[];
  readonly_command_prefixes: string[];
  warn_on_cwd_mismatch: boolean;
  enforce_cwd_parity_in_quick: boolean;
  warn_on_unverified_gates: boolean;
  warn_on_unverified_gates_when_no_source_files: boolean;
}

export interface SentinelReadinessPolicy {
  min_pass_rate: number;
  max_timeout_rate: number;
  max_warn_plus_fail_rate: number;
  min_reason_coverage_rate: number;
}

export interface SentinelPolicy {
  enabled: boolean;
  readiness: SentinelReadinessPolicy;
}

export interface GuardsConfig {
  factcheck: FactcheckPolicy;
  sentinel: SentinelPolicy;
}

export type FactcheckMode = 'strict' | 'declared' | 'manual' | 'quick';

// ---------------------------------------------------------------------------
// Check Results
// ---------------------------------------------------------------------------

export type Severity = 'PASS' | 'WARN' | 'FAIL';

export interface Mismatch {
  check: string;
  severity: Severity;
  detail: string;
}

export interface FactcheckResult {
  verdict: Severity;
  mode: string;
  mismatches: Mismatch[];
  notes: string[];
  claims_evidence: {
    source_files: number;
    commands_count: number;
    models_count: number;
  };
}

// ---------------------------------------------------------------------------
// Sentinel Health
// ---------------------------------------------------------------------------

export interface SentinelLogEntry {
  verdict?: string;
  reason?: string;
  error?: string;
  message?: string;
  runtime?: {
    timed_out?: boolean;
    global_timeout?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SentinelStats {
  total_runs: number;
  pass_count: number;
  warn_count: number;
  fail_count: number;
  timeout_count: number;
  reason_coverage_count: number;
}

export interface SentinelReadinessResult {
  ready: boolean;
  blockers: string[];
  stats: SentinelStats;
}

// ---------------------------------------------------------------------------
// Required fields / gates constants
// ---------------------------------------------------------------------------

export const REQUIRED_FIELDS: ReadonlySet<string> = new Set([
  'schema_version',
  'run_id',
  'ts',
  'cwd',
  'mode',
  'files_modified',
  'files_created',
  'artifacts_expected',
  'gates',
]);

export const REQUIRED_GATES: ReadonlySet<string> = new Set([
  'selftest_ran',
  'goldens_ran',
  'sentinel_stop_smoke_ran',
  'shadow_leak_check_ran',
]);
