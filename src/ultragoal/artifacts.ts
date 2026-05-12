import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  formatClaudeGoalReconciliation,
  parseClaudeGoalSnapshot,
  reconcileClaudeGoalSnapshot,
} from '../goal-workflows/claude-goal-snapshot.js';

export const ULTRAGOAL_DIR = '.omc/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';

export type UltragoalStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'review_blocked';
export type UltragoalClaudeGoalMode = 'aggregate' | 'per_story';

export interface UltragoalItem {
  id: string;
  title: string;
  objective: string;
  status: UltragoalStatus;
  tokenBudget?: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  reviewBlockedAt?: string;
  evidence?: string;
  failureReason?: string;
}

export interface UltragoalAggregateCompletion {
  status: 'complete';
  completedAt: string;
  evidence: string;
  claudeGoal?: unknown;
}

export interface UltragoalPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  briefPath: string;
  goalsPath: string;
  ledgerPath: string;
  claudeGoalMode?: UltragoalClaudeGoalMode;
  claudeObjective?: string;
  aggregateCompletion?: UltragoalAggregateCompletion;
  activeGoalId?: string;
  goals: UltragoalItem[];
}

export interface UltragoalLedgerEntry {
  ts: string;
  event:
    | 'plan_created'
    | 'goal_started'
    | 'goal_resumed'
    | 'goal_completed'
    | 'goal_blocked'
    | 'goal_failed'
    | 'goal_retried'
    | 'aggregate_completed'
    | 'goal_added'
    | 'final_review_failed'
    | 'goal_review_blocked';
  goalId?: string;
  status?: UltragoalStatus;
  message?: string;
  claudeGoal?: unknown;
  evidence?: string;
  qualityGate?: UltragoalQualityGate;
}

export interface CreateUltragoalOptions {
  brief: string;
  goals?: Array<{ title?: string; objective: string; tokenBudget?: number }>;
  claudeGoalMode?: UltragoalClaudeGoalMode;
  now?: Date;
  force?: boolean;
}

export interface StartNextOptions {
  now?: Date;
  retryFailed?: boolean;
}

export interface CheckpointOptions {
  goalId: string;
  status: Extract<UltragoalStatus, 'complete' | 'failed'> | 'blocked';
  evidence?: string;
  claudeGoal?: unknown;
  qualityGate?: unknown;
  allowActiveFinalClaudeGoal?: boolean;
  now?: Date;
}

export interface AddUltragoalGoalOptions {
  title: string;
  objective: string;
  evidence?: string;
  now?: Date;
}

export interface RecordFinalReviewBlockersOptions extends AddUltragoalGoalOptions {
  goalId: string;
  claudeGoal?: unknown;
}

export interface UltragoalQualityGate {
  aiSlopCleaner: {
    status: 'passed';
    evidence: string;
  };
  verification: {
    status: 'passed';
    commands: string[];
    evidence: string;
  };
  codeReview: {
    recommendation: 'APPROVE';
    architectStatus: 'CLEAR';
    evidence: string;
  };
}

export class UltragoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

export function ultragoalDir(cwd: string): string {
  return join(cwd, ULTRAGOAL_DIR);
}

export function ultragoalBriefPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_BRIEF);
}

export function ultragoalGoalsPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
}

export function ultragoalLedgerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER);
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textMentionsUltragoalPlanArtifact(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized.includes(ULTRAGOAL_DIR.toLowerCase())
    || normalized.includes(ULTRAGOAL_GOALS.toLowerCase())
    || normalized.includes(ULTRAGOAL_LEDGER.toLowerCase());
}

function textMentionsGoalId(value: string | undefined, goalId: string): boolean {
  return (value ?? '').toLowerCase().includes(goalId.toLowerCase());
}

function textHasCompletionValidationEvidence(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  const hasImplementationCompletion = /\b(?:planned work|implementation|deliverables?|scope|task|work)\b/.test(normalized)
    && /\b(?:done|complete|completed|finished|shipped)\b/.test(normalized);
  const hasValidation = /\b(?:validation|verification|tests?|build|lint|review|quality gate|code-review)\b/.test(normalized)
    && /\b(?:passed|complete|completed|clean|green|approve|approved|clear)\b/.test(normalized);
  return hasImplementationCompletion && hasValidation;
}

async function snapshotObjectiveMapsToUltragoalPlan(cwd: string, snapshotObjective: string): Promise<boolean> {
  const actual = normalizeObjective(snapshotObjective).toLowerCase();
  if (textMentionsUltragoalPlanArtifact(actual)) return true;
  if (actual.length < 24) return false;
  try {
    const brief = normalizeObjective(await readFile(ultragoalBriefPath(cwd), 'utf-8')).toLowerCase();
    if (!brief || brief.length < 24) return false;
    return brief.includes(actual) || actual.includes(brief);
  } catch {
    return false;
  }
}

async function canReconcileCompletedTaskScopedAggregateSnapshot(
  cwd: string,
  plan: UltragoalPlan,
  goal: UltragoalItem,
  snapshotObjective: string,
  evidence: string | undefined,
): Promise<boolean> {
  if (claudeGoalMode(plan) !== 'aggregate') return false;
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) return false;
  if (!textMentionsUltragoalPlanArtifact(evidence)) return false;
  if (!textMentionsGoalId(evidence, goal.id)) return false;
  if (!textHasCompletionValidationEvidence(evidence)) return false;
  return snapshotObjectiveMapsToUltragoalPlan(cwd, snapshotObjective);
}

function assertActiveInProgressCheckpoint(plan: UltragoalPlan, goal: UltragoalItem, checkpointKind: string): void {
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) {
    throw new UltragoalError(`Cannot record a ${checkpointKind} checkpoint for ${goal.id} while it is ${goal.status}; start or resume the active ultragoal before checkpointing it.`);
  }
}

function buildCompletedLegacyGoalRemediation(goal: UltragoalItem): string {
  return [
    'If the active /goal condition is a different completed legacy goal, do not repeat --status complete in this session.',
    `Record a non-terminal blocker with: omc ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Claude goal blocks setting a new /goal in this session>" --claude-goal-json "<different completed goal snapshot JSON or path>".`,
    'Then continue this ultragoal in a fresh Claude Code session in the same repo/worktree and set the intended /goal there.',
  ].join(' ');
}

function claudeGoalMode(plan: UltragoalPlan): UltragoalClaudeGoalMode {
  return plan.claudeGoalMode ?? 'per_story';
}

function isResolvedStatus(status: UltragoalStatus): boolean {
  return status === 'complete' || status === 'review_blocked';
}

function aggregateClaudeObjective(goals: readonly UltragoalItem[]): string {
  const prefix = `Complete all ultragoal stories in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}: `;
  const suffix = goals.map((goal) => `${goal.id} ${goal.title}`).join('; ');
  const full = `${prefix}${suffix}`;
  if (full.length <= 4000) return full;
  const fallback = `Complete all ultragoal stories listed in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}. Use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the durable audit trail.`;
  if (fallback.length <= 4000) return fallback;
  throw new UltragoalError('Generated aggregate Claude /goal objective exceeds the 4,000 character limit.');
}

function expectedClaudeObjective(plan: UltragoalPlan, goal: UltragoalItem): string {
  return claudeGoalMode(plan) === 'aggregate'
    ? (plan.claudeObjective ?? aggregateClaudeObjective(plan.goals))
    : goal.objective;
}

export function isFinalRunCompletionCandidate(plan: UltragoalPlan, goal: UltragoalItem): boolean {
  return plan.goals.every((candidate) => candidate.id === goal.id || isResolvedStatus(candidate.status));
}

export function isUltragoalDone(plan: UltragoalPlan): boolean {
  if (plan.aggregateCompletion?.status === 'complete') return true;
  if (plan.goals.length === 0) return true;
  if (plan.goals.some((goal) => goal.status === 'pending' || goal.status === 'in_progress' || goal.status === 'failed')) return false;
  if (!plan.goals.every((goal) => isResolvedStatus(goal.status))) return false;
  const latestNonReviewBlocked = [...plan.goals].reverse().find((goal) => goal.status !== 'review_blocked');
  return latestNonReviewBlocked?.status === 'complete';
}

function titleFromObjective(objective: string, fallback: string): string {
  const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}

export function deriveGoalCandidates(brief: string): Array<{ title: string; objective: string }> {
  const lines = brief.split(/\r?\n/);
  const bulletGoals = lines
    .map((line) => ({ original: line, cleaned: cleanLine(line) }))
    .filter(({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200)
    .filter(({ original, cleaned }, index, all) => (
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original)
      && all.findIndex((candidate) => candidate.cleaned === cleaned) === index
    ))
    .map(({ cleaned }) => cleaned);

  const objectives = bulletGoals.length > 0
    ? bulletGoals
    : brief
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#'));

  const selected = objectives.length > 0 ? objectives : [brief.trim() || 'Complete the requested project objective.'];
  return selected.map((objective, index) => ({
    title: titleFromObjective(objective, `Goal ${index + 1}`),
    objective,
  }));
}

function normalizeGoalId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return `G${String(index + 1).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}

async function appendLedger(cwd: string, entry: UltragoalLedgerEntry): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const path = ultragoalLedgerPath(cwd);
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omc ultragoal create-goals ...\` first.`);
  }
  const parsed = JSON.parse(raw) as UltragoalPlan;
  if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${repoRelative(cwd, path)}.`);
  }
  return parsed;
}

async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalGoalsPath(cwd), `${JSON.stringify(plan, null, 2)}\n`);
}

export async function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan> {
  if (!options.force && existsSync(ultragoalGoalsPath(cwd))) {
    throw new UltragoalError(`Refusing to overwrite existing ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}; pass --force to recreate it.`);
  }
  const now = iso(options.now);
  const sourceGoals: Array<{ title?: string; objective: string; tokenBudget?: number }> = options.goals?.length
    ? options.goals
    : deriveGoalCandidates(options.brief);
  const candidates = sourceGoals
    .map((goal, index): UltragoalItem => ({
      id: normalizeGoalId(goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`), index),
      title: goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
      objective: goal.objective.trim(),
      status: 'pending',
      tokenBudget: goal.tokenBudget,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }));

  const plan: UltragoalPlan = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    briefPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`,
    goalsPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`,
    ledgerPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`,
    claudeGoalMode: options.claudeGoalMode ?? 'aggregate',
    goals: candidates,
  };
  if (plan.claudeGoalMode === 'aggregate') plan.claudeObjective = aggregateClaudeObjective(candidates);

  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalBriefPath(cwd), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
  await writePlan(cwd, plan);
  await writeFile(ultragoalLedgerPath(cwd), '');
  await appendLedger(cwd, { ts: now, event: 'plan_created', message: `${candidates.length} goal(s) created` });
  return plan;
}

export function summarizeUltragoalPlan(plan: UltragoalPlan): { total: number; pending: number; inProgress: number; complete: number; failed: number; reviewBlocked: number; aggregateComplete: boolean; activeGoalId?: string } {
  return {
    total: plan.goals.length,
    pending: plan.goals.filter((goal) => goal.status === 'pending').length,
    inProgress: plan.goals.filter((goal) => goal.status === 'in_progress').length,
    complete: plan.goals.filter((goal) => goal.status === 'complete').length,
    failed: plan.goals.filter((goal) => goal.status === 'failed').length,
    reviewBlocked: plan.goals.filter((goal) => goal.status === 'review_blocked').length,
    aggregateComplete: plan.aggregateCompletion?.status === 'complete',
    activeGoalId: plan.activeGoalId,
  };
}

function assertNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new UltragoalError(`Missing ${label}.`);
  return trimmed;
}

function appendGoalToPlan(plan: UltragoalPlan, options: AddUltragoalGoalOptions, now: string): UltragoalItem {
  const title = assertNonEmpty(options.title, '--title');
  const objective = assertNonEmpty(options.objective, '--objective');
  const goal: UltragoalItem = {
    id: normalizeGoalId(title, plan.goals.length),
    title,
    objective,
    status: 'pending',
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    evidence: options.evidence,
  };
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

export async function addUltragoalGoal(cwd: string, options: AddUltragoalGoalOptions): Promise<{ plan: UltragoalPlan; goal: UltragoalItem }> {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  const goal = appendGoalToPlan(plan, options, now);
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: goal.title,
  });
  return { plan, goal };
}

function validateQualityGate(value: unknown): UltragoalQualityGate {
  if (!value || typeof value !== 'object') {
    throw new UltragoalError('Final ultragoal completion requires --quality-gate-json with ai-slop-cleaner, verification, and code-review evidence.');
  }
  const gate = value as Partial<UltragoalQualityGate>;
  const cleaner = gate.aiSlopCleaner;
  const verification = gate.verification;
  const review = gate.codeReview;
  if (!cleaner || typeof cleaner !== 'object') throw new UltragoalError('Final quality gate is missing aiSlopCleaner evidence.');
  if (cleaner.status !== 'passed') {
    throw new UltragoalError('Final quality gate requires aiSlopCleaner.status="passed"; run ai-slop-cleaner even when it is a no-op.');
  }
  assertNonEmpty(cleaner.evidence, 'aiSlopCleaner.evidence');
  if (!verification || typeof verification !== 'object') throw new UltragoalError('Final quality gate is missing verification evidence.');
  if (verification.status !== 'passed') throw new UltragoalError('Final quality gate requires verification.status="passed".');
  if (!Array.isArray(verification.commands) || verification.commands.length === 0 || verification.commands.some((command) => typeof command !== 'string' || command.trim() === '')) {
    throw new UltragoalError('Final quality gate requires non-empty verification.commands.');
  }
  assertNonEmpty(verification.evidence, 'verification.evidence');
  if (!review || typeof review !== 'object') throw new UltragoalError('Final quality gate is missing codeReview evidence.');
  if (review.recommendation !== 'APPROVE') {
    throw new UltragoalError('Final code-review must be clean: codeReview.recommendation must be APPROVE; use record-review-blockers for COMMENT or REQUEST CHANGES.');
  }
  if (review.architectStatus !== 'CLEAR') {
    throw new UltragoalError('Final code-review must be clean: codeReview.architectStatus must be CLEAR; use record-review-blockers for WATCH or BLOCK.');
  }
  assertNonEmpty(review.evidence, 'codeReview.evidence');
  return gate as UltragoalQualityGate;
}

export async function startNextUltragoal(cwd: string, options: StartNextOptions = {}): Promise<{ plan: UltragoalPlan; goal: UltragoalItem | null; resumed: boolean; done: boolean }> {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  if (plan.aggregateCompletion?.status === 'complete') return { plan, goal: null, resumed: false, done: true };
  const existing = plan.goals.find((goal) => goal.status === 'in_progress');
  if (existing) {
    await appendLedger(cwd, { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' });
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((goal) => goal.status === 'pending');
  if (!next && options.retryFailed) {
    next = plan.goals.find((goal) => goal.status === 'failed');
    if (next) await appendLedger(cwd, { ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason });
  }
  if (!next) return { plan, goal: null, resumed: false, done: isUltragoalDone(plan) };

  next.status = 'in_progress';
  next.attempt += 1;
  next.startedAt = now;
  next.failedAt = undefined;
  next.failureReason = undefined;
  next.updatedAt = now;
  plan.activeGoalId = next.id;
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, { ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` });
  return { plan, goal: next, resumed: false, done: false };
}

export async function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan> {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  const now = iso(options.now);
  if (options.status === 'blocked') {
    assertActiveInProgressCheckpoint(plan, goal, 'blocked');
    const snapshot = options.claudeGoal === undefined ? null : parseClaudeGoalSnapshot(options.claudeGoal);
    if (!snapshot?.available) {
      throw new UltragoalError('Blocked ultragoal checkpoints require a Claude /goal snapshot for the completed legacy goal that blocked a new /goal directive; pass --claude-goal-json.');
    }
    if (snapshot.status !== 'complete') {
      throw new UltragoalError(`Cannot record a blocked ultragoal checkpoint while the existing Claude /goal is ${snapshot.status ?? 'unknown'}; strict objective mismatch protection remains required for active or incomplete goals.`);
    }
    if (!snapshot.objective) {
      throw new UltragoalError('Blocked ultragoal checkpoint Claude snapshot is missing objective text.');
    }
    if (normalizeObjective(snapshot.objective) === normalizeObjective(expectedClaudeObjective(plan, goal))) {
      throw new UltragoalError('Blocked ultragoal checkpoint is only for a different completed legacy Claude goal; complete this ultragoal with --status complete after its audit passes.');
    }
    goal.updatedAt = now;
    plan.activeGoalId = goal.id;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'goal_blocked',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      claudeGoal: options.claudeGoal,
    });
    return plan;
  }
  if (options.status === 'failed') {
    assertActiveInProgressCheckpoint(plan, goal, 'failed');
  }
  let aggregateCompletion: UltragoalAggregateCompletion | undefined;
  if (options.status === 'complete') {
    assertActiveInProgressCheckpoint(plan, goal, 'complete');
    const expectedObjective = expectedClaudeObjective(plan, goal);
    const aggregateMode = claudeGoalMode(plan) === 'aggregate';
    const finalRunCheckpoint = isFinalRunCompletionCandidate(plan, goal);
    const snapshot = options.claudeGoal === undefined ? null : parseClaudeGoalSnapshot(options.claudeGoal);
    const reconciliation = reconcileClaudeGoalSnapshot(
      snapshot,
      {
        expectedObjective,
        allowedStatuses: aggregateMode
          ? (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal ? ['complete'] : ['active'])
          : ['complete'],
        requireSnapshot: true,
        requireComplete: !aggregateMode || (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal),
      },
    );
    if (!reconciliation.ok) {
      const completedTaskScopedAggregateSnapshot = snapshot?.available
        && snapshot.status === 'complete'
        && Boolean(snapshot.objective)
        && normalizeObjective(snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
        && await canReconcileCompletedTaskScopedAggregateSnapshot(cwd, plan, goal, snapshot.objective ?? '', options.evidence);
      if (completedTaskScopedAggregateSnapshot) {
        aggregateCompletion = {
          status: 'complete',
          completedAt: now,
          evidence: assertNonEmpty(options.evidence, '--evidence'),
          claudeGoal: options.claudeGoal,
        };
      } else {
        const taskScopedRequirement = aggregateMode && snapshot?.status === 'complete' && Boolean(snapshot.objective)
          ? ' Completed task-scoped aggregate reconciliation requires the checkpoint goal to be the active in-progress OMC goal, evidence that names that active OMC goal id, names .omc/ultragoal/goals.json or ledger.jsonl, includes completed implementation plus validation/review evidence, and a Claude /goal objective that maps to the ultragoal brief/artifact.'
          : '';
        const remediation = reconciliation.snapshot.available
          && reconciliation.snapshot.status === 'complete'
          && Boolean(reconciliation.snapshot.objective)
          && normalizeObjective(reconciliation.snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
          ? ` ${buildCompletedLegacyGoalRemediation(goal)}`
          : '';
        throw new UltragoalError(`${formatClaudeGoalReconciliation(reconciliation)}${taskScopedRequirement}${remediation}`);
      }
    }
    if (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal) goal.evidence = options.evidence;
  }
  const qualityGate = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalClaudeGoal))
    ? validateQualityGate(options.qualityGate)
    : undefined;
  if (aggregateCompletion) {
    plan.aggregateCompletion = aggregateCompletion;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'aggregate_completed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      claudeGoal: options.claudeGoal,
      qualityGate,
      message: 'Aggregate ultragoal plan completed via task-scoped Claude /goal snapshot; microgoal ledger progress remains independent.',
    });
    return plan;
  }
  goal.status = options.status;
  goal.updatedAt = now;
  if (options.status === 'complete') {
    goal.completedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  } else {
    goal.failedAt = now;
    goal.failureReason = options.evidence;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  }
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: options.status === 'complete' ? 'goal_completed' : 'goal_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    claudeGoal: options.claudeGoal,
    qualityGate,
  });
  return plan;
}

export async function recordFinalReviewBlockers(cwd: string, options: RecordFinalReviewBlockersOptions): Promise<{ plan: UltragoalPlan; blockedGoal: UltragoalItem; addedGoal: UltragoalItem }> {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  assertNonEmpty(options.evidence, '--evidence');
  if (goal.status !== 'in_progress') {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id} while it is ${goal.status}; start or resume the ultragoal first.`);
  }
  if (!isFinalRunCompletionCandidate(plan, goal)) {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id}; it is not the only unresolved ultragoal story.`);
  }

  const now = iso(options.now);
  const expectedObjective = expectedClaudeObjective(plan, goal);
  const aggregateMode = claudeGoalMode(plan) === 'aggregate';
  const reconciliation = reconcileClaudeGoalSnapshot(
    options.claudeGoal === undefined ? null : parseClaudeGoalSnapshot(options.claudeGoal),
    {
      expectedObjective,
      allowedStatuses: ['active'],
      requireSnapshot: true,
      requireComplete: false,
    },
  );
  if (!reconciliation.ok) {
    throw new UltragoalError(formatClaudeGoalReconciliation(reconciliation));
  }

  const addedGoal = appendGoalToPlan(plan, options, now);
  goal.status = 'review_blocked';
  goal.reviewBlockedAt = now;
  goal.updatedAt = now;
  goal.completedAt = undefined;
  goal.failedAt = undefined;
  goal.failureReason = undefined;
  goal.evidence = options.evidence;
  if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  plan.updatedAt = now;

  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'final_review_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    claudeGoal: options.claudeGoal,
    message: aggregateMode
      ? 'Final aggregate code-review was not clean; blocker story was appended while Claude /goal remains active.'
      : 'Final per-story code-review was not clean; blocker story was appended and may require a fresh/available Claude /goal context.',
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: addedGoal.id,
    status: addedGoal.status,
    evidence: options.evidence,
    message: addedGoal.title,
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_review_blocked',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    claudeGoal: options.claudeGoal,
  });
  return { plan, blockedGoal: goal, addedGoal };
}

export function buildClaudeGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  if (claudeGoalMode(plan) === 'aggregate') return buildAggregateClaudeGoalInstruction(goal, plan);
  return buildPerStoryClaudeGoalInstruction(goal, plan);
}

function buildPerStoryClaudeGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const createPayload = {
    condition: goal.objective,
    ...(goal.tokenBudget ? { token_budget: goal.tokenBudget } : {}),
  };
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  return [
    'Ultragoal active-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Claude /goal integration constraints (model-facing — OMC cannot mutate Claude /goal state from a shell):',
    '- First confirm the active Claude /goal condition for this session. If none is active, invoke /goal <condition> with the payload below.',
    '- If a different active Claude /goal exists, finish or clear that /goal before starting this ultragoal.',
    '- If the active /goal is a different completed legacy goal and the Claude session refuses to set a new /goal, continue this ultragoal in a fresh Claude Code session (same repo/worktree) and invoke /goal there.',
    `- To preserve the durable ledger before switching sessions, record the non-terminal blocker without failing this goal: omc ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Claude goal blocks new /goal in this session>" --claude-goal-json "<goal snapshot JSON or path>"`,
    '- Work only this goal until its completion audit passes.',
    finalStory
      ? '- Final mandatory quality gate: run ai-slop-cleaner on changed files even when it is a no-op, rerun verification, then run $code-review.'
      : '- This is not the final ultragoal story; do not run the final ai-slop-cleaner/$code-review gate yet.',
    finalStory
      ? '- If final $code-review is not APPROVE with architect status CLEAR, do not clear the /goal. Record blockers with:'
      : '- After the goal is actually complete, clear or update the active /goal (run /goal clear once the auto-clear has not already fired), then share a fresh /goal snapshot and checkpoint the ledger with:',
    finalStory
      ? `  omc ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --claude-goal-json "<active /goal snapshot JSON or path>"`
      : `  omc ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --claude-goal-json "<fresh /goal snapshot JSON or path>"`,
    finalStory
      ? '- In legacy per-story mode, the blocker story may require a fresh/available Claude /goal context because this story remains an active incomplete /goal; do not claim it is complete.'
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR), clear the /goal (or wait for the auto-clear), then checkpoint with --quality-gate-json:'
      : null,
    finalStory
      ? `  omc ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --claude-goal-json "<fresh complete /goal snapshot JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : null,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'Suggested /goal payload (model-facing — invoke /goal yourself in-session):',
    JSON.stringify(createPayload, null, 2),
    '',
    'Objective (use as the /goal condition):',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}

function buildAggregateClaudeGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const objective = plan.claudeObjective ?? aggregateClaudeObjective(plan.goals);
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  const createPayload = { condition: objective };
  const checkpointStatus = finalStory ? 'complete' : 'active';
  return [
    'Ultragoal aggregate-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Claude /goal integration constraints (model-facing — OMC cannot mutate Claude /goal state from a shell):',
    '- Claude /goal = the whole ultragoal run; OMC G001/G002/etc. = ledger stories.',
    '- First confirm the active Claude /goal condition for this session. If none is active, invoke /goal <condition> with the aggregate payload below.',
    '- If the active /goal already reports the same aggregate objective as active, continue this OMC story without setting a new /goal.',
    '- If a different active or incomplete Claude /goal exists, finish or clear that /goal before starting this ultragoal; do not claim a shell command can replace Claude /goal state.',
    finalStory
      ? '- This is the final pending story: run the mandatory final ai-slop-cleaner pass, rerun verification, and run $code-review before any /goal clear.'
      : '- This is not the final story: do not clear the /goal yet; the aggregate Claude /goal must remain active while later OMC stories remain.',
    finalStory
      ? '- If final $code-review is not APPROVE with architect status CLEAR, do not clear the /goal. Record durable blocker work first:'
      : null,
    finalStory
      ? `  omc ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --claude-goal-json "<active /goal snapshot JSON or path>"`
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR), clear the /goal (or let the auto-clear fire when the condition holds), share a fresh complete /goal snapshot, then checkpoint with --quality-gate-json.'
      : null,
    `- Checkpoint this OMC story with a fresh /goal snapshot whose objective matches the aggregate payload and whose status is ${checkpointStatus}:`,
    finalStory
      ? `  omc ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --claude-goal-json "<fresh complete /goal snapshot JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : `  omc ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --claude-goal-json "<fresh /goal snapshot JSON or path>"`,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'Suggested /goal payload (model-facing — invoke /goal yourself in-session):',
    JSON.stringify(createPayload, null, 2),
    '',
    'Aggregate /goal condition:',
    objective,
    '',
    'Current OMC story objective:',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}
