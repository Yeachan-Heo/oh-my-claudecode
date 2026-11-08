/**
 * Declarative hook registry and dispatcher shadow-mode types — #3698 / #3707.
 *
 * Contract source: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md §6.3.
 * One registry entry per installed hooks.json command; a shadow dispatcher
 * that parses each event once, selects only applicable entries in declared
 * order, enforces per-hook timeouts, applies declared fail-modes, and records
 * structured timing/error observations — without changing any runtime
 * decision. Risk classes and fail-modes are derived by convention from the
 * entrypoint name using the canonical taxonomy in src/workflow/registry.ts.
 * No behavior change; cutover is #3708.
 */

import type { FailMode, RiskClass } from '../../workflow/registry.js';

/** Lifecycle events present in hooks/hooks.json (the installed registration). */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'SessionEnd',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * One declarative hook registration. `order` is the execution order within
 * its (event, matcher) group, mirroring hooks.json array position.
 */
export interface HookRegistryEntry {
  /** Stable identifier: `<event>:<matcher>:<entrypoint>[:<args>]`. */
  id: string;
  event: HookEvent;
  /** hooks.json matcher ('*', 'init', 'maintenance', 'Bash', ...). */
  matcher: string;
  /** Execution order within the same event+matcher group (0-based). */
  order: number;
  /** Installed script entrypoint basename, e.g. 'keyword-detector.mjs'. */
  entrypoint: string;
  /** Extra argv after the script (e.g. 'start'/'stop' for subagent-tracker). */
  args: readonly string[];
  timeoutMs: number;
  async: boolean;
  riskClass: RiskClass;
  failMode: FailMode;
}

/** Minimal shape of hooks/hooks.json for registry derivation. */
export interface HooksJsonCommand {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}
export interface HooksJsonGroup {
  matcher: string;
  hooks: HooksJsonCommand[];
}
export type HooksJson = Record<string, HooksJsonGroup[]>;

// ---------------------------------------------------------------------------
// Shadow dispatcher
// ---------------------------------------------------------------------------

export type DispatchStatus = 'ok' | 'error' | 'timeout' | 'skipped';

/** Structured per-hook timing/error record emitted by the shadow dispatcher. */
export interface DispatchRecord {
  hookId: string;
  event: HookEvent;
  durationMs: number;
  status: DispatchStatus;
  /** Stable error class (e.g. 'Error', 'TimeoutError'); never message text. */
  errorClass?: string;
  failMode: FailMode;
  riskClass: RiskClass;
  /** Which decision source was applied for this hook (always 'none' in shadow). */
  appliedDecision: 'handler' | 'fail-open' | 'fail-closed' | 'none';
}

/** Result of a shadow dispatch — records only, never a runtime decision. */
export interface DispatchResult {
  event: HookEvent;
  records: DispatchRecord[];
}

/** Minimal structural decision shape accepted from any hook output type. */
export interface ShadowDecisionInput {
  continue?: boolean;
  decision?: unknown;
  message?: string;
}

export type HookHandler = (
  input: unknown,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shadow comparison
// ---------------------------------------------------------------------------

export type ShadowVerdict =
  | 'equivalent' // shadow selection/ordering and decision match legacy observation
  | 'divergent' // selection/ordering or decision mismatch — evidence for #3708
  | 'deferred' // side-effecting handler; decision equivalence deferred to cutover
  | 'unmapped'; // bridge hook type has no registry entry

/**
 * Privacy-preserving shadow comparison record (plan §9): no prompts, secrets,
 * repository contents, or user text — only ids, events, durations, digests,
 * error classes, and verdicts.
 */
export interface ShadowComparisonRecord {
  schemaVersion: 1;
  hookType: string;
  event: HookEvent | null;
  registryEntryIds: readonly string[];
  verdict: ShadowVerdict;
  legacyDurationMs: number;
  shadowDurationMs: number;
  /** sha256 of the normalized legacy decision shape (never content). */
  legacyDecisionDigest: string;
  /** sha256 of the normalized shadow decision shape, when computed. */
  shadowDecisionDigest?: string;
  errorClass?: string;
  recordedAt: string;
}
