import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type ClaudeGoalSnapshotStatus = 'active' | 'complete' | 'cancelled' | 'failed' | 'unknown';

export interface ClaudeGoalSnapshot {
  available: boolean;
  objective?: string;
  status?: ClaudeGoalSnapshotStatus;
  tokenBudget?: number;
  remainingTokens?: number | null;
  raw: unknown;
}

export interface ClaudeGoalReconciliation {
  ok: boolean;
  snapshot: ClaudeGoalSnapshot;
  warnings: string[];
  errors: string[];
}

export interface ReconcileClaudeGoalOptions {
  expectedObjective: string;
  allowedStatuses?: readonly ClaudeGoalSnapshotStatus[];
  requireSnapshot?: boolean;
  requireComplete?: boolean;
}

export class ClaudeGoalSnapshotError extends Error {}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStatus(value: unknown): ClaudeGoalSnapshotStatus {
  const status = safeString(value).toLowerCase();
  if (status === 'complete' || status === 'completed' || status === 'done') return 'complete';
  if (status === 'cancelled' || status === 'canceled' || status === 'cleared') return 'cancelled';
  if (status === 'failed' || status === 'failure') return 'failed';
  if (status === 'active' || status === 'in_progress' || status === 'pending' || status === 'running') return 'active';
  return 'unknown';
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a Claude goal snapshot JSON payload.
 *
 * The payload is whatever the active Claude agent shares as proof of the
 * current `/goal` condition state. Accepted shapes include:
 *   { goal: { objective, status, ... } }
 *   { objective, status, ... }
 * with `condition` accepted as a synonym for `objective`.
 *
 * NOTE: The Claude Code `/goal` slash command is not invokable from a shell.
 * This snapshot is a model-facing artifact; OMC only verifies textual
 * consistency between the model's reported state and the ultragoal plan.
 */
export function parseClaudeGoalSnapshot(value: unknown): ClaudeGoalSnapshot {
  const root = safeObject(value);
  const goalValue = Object.hasOwn(root, 'goal') ? root.goal : value;
  if (goalValue === null || goalValue === undefined || goalValue === false) {
    return { available: false, raw: value };
  }

  const goal = safeObject(goalValue);
  const objective = safeString(
    goal.objective
    ?? goal.condition
    ?? goal.goal
    ?? goal.description
    ?? root.objective
    ?? root.condition,
  );
  const status = normalizeStatus(goal.status ?? root.status);
  const tokenBudget = safeNumber(
    goal.token_budget
    ?? goal.tokenBudget
    ?? root.token_budget
    ?? root.tokenBudget,
  );
  const remainingTokens = safeNumber(root.remainingTokens ?? root.remaining_tokens);

  return {
    available: Boolean(objective || status !== 'unknown'),
    ...(objective ? { objective } : {}),
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    remainingTokens: remainingTokens ?? null,
    raw: value,
  };
}

export async function readClaudeGoalSnapshotInput(raw: string | undefined, cwd = process.cwd()): Promise<ClaudeGoalSnapshot | null> {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  try {
    return parseClaudeGoalSnapshot(JSON.parse(trimmed));
  } catch {
    const path = resolve(cwd, trimmed);
    if (!existsSync(path)) {
      throw new ClaudeGoalSnapshotError(`Claude goal snapshot is neither valid JSON nor a readable path: ${trimmed}`);
    }
    try {
      return parseClaudeGoalSnapshot(JSON.parse(await readFile(path, 'utf-8')));
    } catch (error) {
      throw new ClaudeGoalSnapshotError(`Claude goal snapshot path does not contain valid JSON: ${trimmed}${error instanceof Error ? ` (${error.message})` : ''}`);
    }
  }
}

export function reconcileClaudeGoalSnapshot(
  snapshot: ClaudeGoalSnapshot | null | undefined,
  options: ReconcileClaudeGoalOptions,
): ClaudeGoalReconciliation {
  const effectiveSnapshot = snapshot ?? { available: false, raw: null };
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!effectiveSnapshot.available) {
    const message = 'Claude goal snapshot is absent or reports no active goal; ask the active Claude agent to share the current /goal condition and pass its JSON with --claude-goal-json.';
    if (options.requireSnapshot) errors.push(message);
    else warnings.push(message);
    return { ok: errors.length === 0, snapshot: effectiveSnapshot, warnings, errors };
  }

  const expected = normalizeObjective(options.expectedObjective);
  const actual = normalizeObjective(effectiveSnapshot.objective ?? '');
  if (!actual) {
    errors.push('Claude goal snapshot is missing objective text.');
  } else if (actual !== expected) {
    errors.push(`Claude goal objective mismatch: expected "${expected}", got "${actual}".`);
  }

  const allowed = options.allowedStatuses ?? (options.requireComplete ? ['complete'] : ['active', 'complete']);
  const actualStatus = effectiveSnapshot.status ?? 'unknown';
  if (!allowed.includes(actualStatus)) {
    errors.push(`Claude goal status mismatch: expected ${allowed.join(' or ')}, got ${actualStatus}.`);
  }
  if (options.requireComplete && actualStatus !== 'complete') {
    errors.push(`Claude goal is not complete; only after the active condition is genuinely satisfied (the /goal hook auto-clears, or you run /goal clear), share the fresh snapshot.`);
  }

  return { ok: errors.length === 0, snapshot: effectiveSnapshot, warnings, errors };
}

export function formatClaudeGoalReconciliation(reconciliation: ClaudeGoalReconciliation): string {
  const parts = [...reconciliation.errors, ...reconciliation.warnings];
  return parts.join(' ');
}
