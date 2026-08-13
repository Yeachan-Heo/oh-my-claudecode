/**
 * Hook dispatcher cutover — #3698 / #3708.
 *
 * Active event-family cutover on top of the shadow registry (#3707).
 * Contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md §6.3 / §8 step 6.
 *
 * - Advisory by default, hard only for the approved risk classes
 *   (destructive-mutation, security-boundary, secrets-privacy,
 *   corruption-integrity, release-authority). Unknown failures default
 *   advisory during migration.
 * - Per-family cutover with global + per-event rollback flags.
 * - Bounded, privacy-preserving dispatch telemetry (ids/durations/verdicts only).
 * - Ordinary injection / procedure enforcement (prompt prerequisites,
 *   orchestrator strict delegation) collapses to advisory when the
 *   corresponding family is cut over; hard permission/release/security
 *   semantics are preserved.
 *
 * Rollback:
 * - `OMC_HOOK_DISPATCHER=off|0|false|disabled` — global cutover off, legacy only.
 * - `OMC_HOOK_ROLLBACK=<Event,...>` or `OMC_HOOK_DISPATCHER_ROLLBACK=<Event,...>` — per-family rollback.
 *   Family names are HookEvent values (UserPromptSubmit, SessionStart, PreToolUse,
 *   PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop,
 *   PreCompact, Stop, SessionEnd) or `*`. Comparison is case-insensitive.
 * - `OMC_HOOK_CUTOVER` is accepted as an alias for `OMC_HOOK_DISPATCHER`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getOmcRoot, resolveToWorktreeRoot } from '../../lib/worktree-paths.js';
import type { HookEvent } from './types.js';

export const DISPATCH_TELEMETRY_MAX_RECORDS = 500;
export const DISPATCH_TELEMETRY_MAX_BYTES = 256 * 1024;

/** Privacy-preserving cutover telemetry record (plan §9). */
export interface DispatchTelemetryRecord {
  schemaVersion: 1;
  event: HookEvent | string;
  hookType?: string;
  hookId?: string;
  riskClass?: string;
  failMode?: string;
  appliedDecision: 'advisory' | 'hard' | 'none' | 'fail-open' | 'fail-closed';
  durationMs: number;
  verdict?: string;
  rollback?: boolean;
  recordedAt: string;
}

function cutoverFlagRaw(): string | undefined {
  const v = process.env.OMC_HOOK_DISPATCHER ?? process.env.OMC_HOOK_CUTOVER;
  return v;
}

/** Global dispatcher cutover enabled. Aggressively on by default; `off` rolls back to legacy. */
export function isDispatcherEnabled(): boolean {
  const raw = cutoverFlagRaw();
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'disabled');
}

function rollbackSet(): Set<string> {
  const raw = process.env.OMC_HOOK_ROLLBACK ?? process.env.OMC_HOOK_DISPATCHER_ROLLBACK ?? '';
  const out = new Set<string>();
  for (const tok of raw.split(',')) {
    const n = tok.trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

/** Per-family cutover enabled (global + rollback). */
export function isFamilyCutoverEnabled(event: HookEvent | string): boolean {
  if (!isDispatcherEnabled()) return false;
  const rb = rollbackSet();
  if (rb.has('*')) return false;
  const lower = event.toLowerCase();
  if (rb.has(lower)) return false;
  return true;
}

/** Whether ordinary injection/procedure enforcement for `event` should be demoted to advisory. */
export function shouldLoosenOrdinaryEnforcement(event: HookEvent | string): boolean {
  return isFamilyCutoverEnabled(event);
}

export function telemetryPath(worktreeRoot?: string): string {
  const root = getOmcRoot(worktreeRoot ?? resolveToWorktreeRoot());
  return join(root, 'state', 'hook-dispatch-telemetry.jsonl');
}

/** Bounded append; never throws, never blocks hooks. */
export function recordDispatchTelemetry(
  record: DispatchTelemetryRecord,
  worktreeRoot?: string,
): void {
  try {
    const p = telemetryPath(worktreeRoot);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n');
    // Opportunistic bounding: trim only when file likely over budget.
    // Cheap check: file size via read; bound enforcement is best-effort.
    try {
      const raw = readFileSync(p, 'utf-8');
      if (raw.length > DISPATCH_TELEMETRY_MAX_BYTES) {
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        let kept = lines.slice(-DISPATCH_TELEMETRY_MAX_RECORDS);
        while (kept.length > 0 && kept.join('\n').length + 1 > DISPATCH_TELEMETRY_MAX_BYTES) {
          kept = kept.slice(1);
        }
        writeFileSync(p, kept.length > 0 ? kept.join('\n') + '\n' : '');
      } else {
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > DISPATCH_TELEMETRY_MAX_RECORDS) {
          writeFileSync(p, lines.slice(-DISPATCH_TELEMETRY_MAX_RECORDS).join('\n') + '\n');
        }
      }
    } catch {
      // ignore bounding errors
    }
  } catch {
    // telemetry never affects hook behavior
  }
}

export function readDispatchTelemetryTail(
  limit = 100,
  worktreeRoot?: string,
): DispatchTelemetryRecord[] {
  try {
    const p = telemetryPath(worktreeRoot);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0).slice(-limit);
    return lines.map(l => {
      try { return JSON.parse(l) as DispatchTelemetryRecord; } catch { return null; }
    }).filter(Boolean) as DispatchTelemetryRecord[];
  } catch { return []; }
}

export function clearDispatchTelemetryForTests(worktreeRoot?: string): void {
  try {
    const p = telemetryPath(worktreeRoot);
    if (existsSync(p)) writeFileSync(p, '');
  } catch { /* ignore */ }
}

/** Map bridge HookType to its HookEvent family for cutover gating. */
export function hookEventForType(hookType: string): HookEvent | null {
  switch (hookType) {
    case 'keyword-detector': return 'UserPromptSubmit';
    case 'session-start':
    case 'setup-init':
    case 'setup-maintenance': return 'SessionStart';
    case 'pre-tool-use': return 'PreToolUse';
    case 'permission-request': return 'PermissionRequest';
    case 'post-tool-use': return 'PostToolUse';
    case 'subagent-start': return 'SubagentStart';
    case 'subagent-stop': return 'SubagentStop';
    case 'pre-compact': return 'PreCompact';
    case 'stop-continuation':
    case 'persistent-mode':
    case 'ralph':
    case 'code-simplifier': return 'Stop';
    case 'session-end': return 'SessionEnd';
    case 'autopilot': return null;
    default: return null;
  }
}
