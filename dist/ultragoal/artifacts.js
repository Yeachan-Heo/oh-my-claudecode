import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { formatClaudeGoalReconciliation, parseClaudeGoalSnapshot, reconcileClaudeGoalSnapshot, } from '../goal-workflows/claude-goal-snapshot.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
export const ULTRAGOAL_DIR = '.omc/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';
export const ULTRAGOAL_PLANS_SUBDIR = 'plans';
export class UltragoalError extends Error {
}
function iso(now = new Date()) {
    return now.toISOString();
}
export function ultragoalDir(cwd, planId) {
    const omcRoot = getOmcRoot(cwd);
    if (planId)
        return join(omcRoot, 'ultragoal', ULTRAGOAL_PLANS_SUBDIR, planId);
    return join(omcRoot, 'ultragoal');
}
export function ultragoalBriefPath(cwd, planId) {
    return join(ultragoalDir(cwd, planId), ULTRAGOAL_BRIEF);
}
export function ultragoalGoalsPath(cwd, planId) {
    return join(ultragoalDir(cwd, planId), ULTRAGOAL_GOALS);
}
export function ultragoalLedgerPath(cwd, planId) {
    return join(ultragoalDir(cwd, planId), ULTRAGOAL_LEDGER);
}
/**
 * List all multi-plan IDs under .omc/ultragoal/plans/.
 * Returns an empty array when the plans/ subdir doesn't exist.
 */
export async function listUltragoalPlanIds(cwd) {
    const dir = join(getOmcRoot(cwd), 'ultragoal', ULTRAGOAL_PLANS_SUBDIR);
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .filter((entry) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    }
    catch {
        return [];
    }
}
/**
 * Resolve which plan a CLI command should target.
 *
 *  - explicitPlanId wins.
 *  - Legacy goals.json (no planId) wins next, for backwards compat.
 *  - If exactly one multi-plan exists, that one is selected.
 *  - Otherwise throws UltragoalError with the list of candidate planIds.
 */
export async function resolveActivePlanId(cwd, explicitPlanId) {
    if (explicitPlanId) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(explicitPlanId)) {
            throw new UltragoalError(`Invalid --plan-id: ${explicitPlanId}. Allowed chars: a-z, 0-9, dot, underscore, hyphen.`);
        }
        return explicitPlanId;
    }
    // Legacy single-plan takes precedence when present.
    if (existsSync(join(getOmcRoot(cwd), 'ultragoal', ULTRAGOAL_GOALS)))
        return undefined;
    const plans = await listUltragoalPlanIds(cwd);
    if (plans.length === 1)
        return plans[0];
    if (plans.length === 0)
        return undefined;
    throw new UltragoalError(`Multiple ultragoal plans exist; pass --plan-id <id>. Available plans: ${plans.join(', ')}`);
}
function makePlanId(brief, now) {
    const ts = now.getTime();
    const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'plan';
    const slug = firstLine
        .toLowerCase()
        .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '') || 'plan';
    return `${ts}-${slug}`;
}
function repoRelative(cwd, path) {
    return relative(cwd, path).split('\\').join('/');
}
function cleanLine(line) {
    return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}
function normalizeObjective(value) {
    return value.replace(/\s+/g, ' ').trim();
}
function textMentionsUltragoalPlanArtifact(value) {
    const normalized = (value ?? '').toLowerCase();
    return normalized.includes(ULTRAGOAL_DIR.toLowerCase())
        || normalized.includes(ULTRAGOAL_GOALS.toLowerCase())
        || normalized.includes(ULTRAGOAL_LEDGER.toLowerCase());
}
function textMentionsGoalId(value, goalId) {
    return (value ?? '').toLowerCase().includes(goalId.toLowerCase());
}
function textHasCompletionValidationEvidence(value) {
    const normalized = (value ?? '').toLowerCase();
    const hasImplementationCompletion = /\b(?:planned work|implementation|deliverables?|scope|task|work)\b/.test(normalized)
        && /\b(?:done|complete|completed|finished|shipped)\b/.test(normalized);
    const hasValidation = /\b(?:validation|verification|tests?|build|lint|review|quality gate|code-review)\b/.test(normalized)
        && /\b(?:passed|complete|completed|clean|green|approve|approved|clear)\b/.test(normalized);
    return hasImplementationCompletion && hasValidation;
}
async function snapshotObjectiveMapsToUltragoalPlan(cwd, snapshotObjective, planId) {
    const actual = normalizeObjective(snapshotObjective).toLowerCase();
    if (textMentionsUltragoalPlanArtifact(actual))
        return true;
    if (actual.length < 24)
        return false;
    try {
        const brief = normalizeObjective(await readFile(ultragoalBriefPath(cwd, planId), 'utf-8')).toLowerCase();
        if (!brief || brief.length < 24)
            return false;
        return brief.includes(actual) || actual.includes(brief);
    }
    catch {
        return false;
    }
}
async function canReconcileCompletedTaskScopedAggregateSnapshot(cwd, plan, goal, snapshotObjective, evidence) {
    if (claudeGoalMode(plan) !== 'aggregate')
        return false;
    if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id)
        return false;
    if (!textMentionsUltragoalPlanArtifact(evidence))
        return false;
    if (!textMentionsGoalId(evidence, goal.id))
        return false;
    if (!textHasCompletionValidationEvidence(evidence))
        return false;
    return snapshotObjectiveMapsToUltragoalPlan(cwd, snapshotObjective, plan.planId);
}
function assertActiveInProgressCheckpoint(plan, goal, checkpointKind) {
    if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) {
        throw new UltragoalError(`Cannot record a ${checkpointKind} checkpoint for ${goal.id} while it is ${goal.status}; start or resume the active ultragoal before checkpointing it.`);
    }
}
function buildCompletedLegacyGoalRemediation(goal) {
    return [
        'If the active /goal condition is a different completed legacy goal, do not repeat --status complete in this session.',
        `Record a non-terminal blocker with: omc ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Claude goal blocks setting a new /goal in this session>" --claude-goal-json "<different completed goal snapshot JSON or path>".`,
        'Then continue this ultragoal in a fresh Claude Code session in the same repo/worktree and set the intended /goal there.',
    ].join(' ');
}
function claudeGoalMode(plan) {
    return plan.claudeGoalMode ?? 'per_story';
}
function isResolvedStatus(status) {
    return status === 'complete' || status === 'review_blocked';
}
function planDirRelative(planId) {
    return planId ? `${ULTRAGOAL_DIR}/${ULTRAGOAL_PLANS_SUBDIR}/${planId}` : ULTRAGOAL_DIR;
}
function aggregateClaudeObjective(goals, planId) {
    const planDir = planDirRelative(planId);
    const prefix = `Complete all ultragoal stories in ${planDir}/${ULTRAGOAL_GOALS}: `;
    const suffix = goals.map((goal) => `${goal.id} ${goal.title}`).join('; ');
    const full = `${prefix}${suffix}`;
    if (full.length <= 4000)
        return full;
    const fallback = `Complete all ultragoal stories listed in ${planDir}/${ULTRAGOAL_GOALS}. Use ${planDir}/${ULTRAGOAL_LEDGER} as the durable audit trail.`;
    if (fallback.length <= 4000)
        return fallback;
    throw new UltragoalError('Generated aggregate Claude /goal objective exceeds the 4,000 character limit.');
}
function expectedClaudeObjective(plan, goal) {
    return claudeGoalMode(plan) === 'aggregate'
        ? (plan.claudeObjective ?? aggregateClaudeObjective(plan.goals, plan.planId))
        : goal.objective;
}
export function isFinalRunCompletionCandidate(plan, goal) {
    return plan.goals.every((candidate) => candidate.id === goal.id || isResolvedStatus(candidate.status));
}
export function isUltragoalDone(plan) {
    if (plan.aggregateCompletion?.status === 'complete')
        return true;
    if (plan.goals.length === 0)
        return true;
    if (plan.goals.some((goal) => goal.status === 'pending' || goal.status === 'in_progress' || goal.status === 'failed'))
        return false;
    if (!plan.goals.every((goal) => isResolvedStatus(goal.status)))
        return false;
    const latestNonReviewBlocked = [...plan.goals].reverse().find((goal) => goal.status !== 'review_blocked');
    return latestNonReviewBlocked?.status === 'complete';
}
function titleFromObjective(objective, fallback) {
    const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
    return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}
export function deriveGoalCandidates(brief) {
    const lines = brief.split(/\r?\n/);
    const bulletGoals = lines
        .map((line) => ({ original: line, cleaned: cleanLine(line) }))
        .filter(({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200)
        .filter(({ original, cleaned }, index, all) => (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original)
        && all.findIndex((candidate) => candidate.cleaned === cleaned) === index))
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
function normalizeGoalId(title, index) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36)
        .replace(/-+$/g, '');
    return `G${String(index + 1).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}
async function appendLedger(cwd, entry, planId) {
    await mkdir(ultragoalDir(cwd, planId), { recursive: true });
    const path = ultragoalLedgerPath(cwd, planId);
    await appendFile(path, `${JSON.stringify(entry)}\n`);
}
export async function readUltragoalPlan(cwd, planId) {
    const path = ultragoalGoalsPath(cwd, planId);
    let raw;
    try {
        raw = await readFile(path, 'utf-8');
    }
    catch {
        const hint = planId
            ? `Pass --plan-id ${planId} to a previously-created plan, or run \`omc ultragoal create-goals --plan-id ${planId} ...\`.`
            : 'Run `omc ultragoal create-goals ...` first.';
        throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. ${hint}`);
    }
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
        throw new UltragoalError(`Invalid ultragoal plan at ${repoRelative(cwd, path)}.`);
    }
    // Hydrate planId on the plan from the resolved location for downstream
    // path computations (so callers don't need to pass planId again).
    if (planId && !parsed.planId)
        parsed.planId = planId;
    return parsed;
}
async function writePlan(cwd, plan) {
    await mkdir(ultragoalDir(cwd, plan.planId), { recursive: true });
    await writeFile(ultragoalGoalsPath(cwd, plan.planId), `${JSON.stringify(plan, null, 2)}\n`);
}
export async function createUltragoalPlan(cwd, options) {
    if (options.planId && options.autoPlanId) {
        throw new UltragoalError('Pass either --plan-id or --auto-plan-id, not both.');
    }
    const now = iso(options.now);
    const nowDate = options.now ?? new Date();
    const planId = options.planId ?? (options.autoPlanId ? makePlanId(options.brief, nowDate) : undefined);
    if (planId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(planId)) {
        throw new UltragoalError(`Invalid plan id: ${planId}. Allowed chars: a-z, 0-9, dot, underscore, hyphen.`);
    }
    if (!options.force && existsSync(ultragoalGoalsPath(cwd, planId))) {
        const label = planId
            ? `${ULTRAGOAL_DIR}/${ULTRAGOAL_PLANS_SUBDIR}/${planId}/${ULTRAGOAL_GOALS}`
            : `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`;
        throw new UltragoalError(`Refusing to overwrite existing ${label}; pass --force to recreate it.`);
    }
    const sourceGoals = options.goals?.length
        ? options.goals
        : deriveGoalCandidates(options.brief);
    const candidates = sourceGoals
        .map((goal, index) => ({
        id: normalizeGoalId(goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`), index),
        title: goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
        objective: goal.objective.trim(),
        status: 'pending',
        tokenBudget: goal.tokenBudget,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
    }));
    const planDir = planDirRelative(planId);
    const plan = {
        version: 1,
        ...(planId ? { planId } : {}),
        createdAt: now,
        updatedAt: now,
        briefPath: `${planDir}/${ULTRAGOAL_BRIEF}`,
        goalsPath: `${planDir}/${ULTRAGOAL_GOALS}`,
        ledgerPath: `${planDir}/${ULTRAGOAL_LEDGER}`,
        claudeGoalMode: options.claudeGoalMode ?? 'aggregate',
        goals: candidates,
    };
    if (plan.claudeGoalMode === 'aggregate')
        plan.claudeObjective = aggregateClaudeObjective(candidates, planId);
    await mkdir(ultragoalDir(cwd, planId), { recursive: true });
    await writeFile(ultragoalBriefPath(cwd, planId), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
    await writePlan(cwd, plan);
    await writeFile(ultragoalLedgerPath(cwd, planId), '');
    await appendLedger(cwd, { ts: now, event: 'plan_created', message: `${candidates.length} goal(s) created` }, planId);
    return plan;
}
export function summarizeUltragoalPlan(plan) {
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
function assertNonEmpty(value, label) {
    const trimmed = value?.trim();
    if (!trimmed)
        throw new UltragoalError(`Missing ${label}.`);
    return trimmed;
}
function appendGoalToPlan(plan, options, now) {
    const title = assertNonEmpty(options.title, '--title');
    const objective = assertNonEmpty(options.objective, '--objective');
    const goal = {
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
export async function addUltragoalGoal(cwd, options) {
    const plan = await readUltragoalPlan(cwd, options.planId);
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
    }, plan.planId);
    return { plan, goal };
}
function validateQualityGate(value) {
    if (!value || typeof value !== 'object') {
        throw new UltragoalError('Final ultragoal completion requires --quality-gate-json with ai-slop-cleaner, verification, and code-review evidence.');
    }
    const gate = value;
    const cleaner = gate.aiSlopCleaner;
    const verification = gate.verification;
    const review = gate.codeReview;
    if (!cleaner || typeof cleaner !== 'object')
        throw new UltragoalError('Final quality gate is missing aiSlopCleaner evidence.');
    if (cleaner.status !== 'passed') {
        throw new UltragoalError('Final quality gate requires aiSlopCleaner.status="passed"; run ai-slop-cleaner even when it is a no-op.');
    }
    assertNonEmpty(cleaner.evidence, 'aiSlopCleaner.evidence');
    if (!verification || typeof verification !== 'object')
        throw new UltragoalError('Final quality gate is missing verification evidence.');
    if (verification.status !== 'passed')
        throw new UltragoalError('Final quality gate requires verification.status="passed".');
    if (!Array.isArray(verification.commands) || verification.commands.length === 0 || verification.commands.some((command) => typeof command !== 'string' || command.trim() === '')) {
        throw new UltragoalError('Final quality gate requires non-empty verification.commands.');
    }
    assertNonEmpty(verification.evidence, 'verification.evidence');
    if (!review || typeof review !== 'object')
        throw new UltragoalError('Final quality gate is missing codeReview evidence.');
    if (review.recommendation !== 'APPROVE') {
        throw new UltragoalError('Final code-review must be clean: codeReview.recommendation must be APPROVE; use record-review-blockers for COMMENT or REQUEST CHANGES.');
    }
    if (review.architectStatus !== 'CLEAR') {
        throw new UltragoalError('Final code-review must be clean: codeReview.architectStatus must be CLEAR; use record-review-blockers for WATCH or BLOCK.');
    }
    assertNonEmpty(review.evidence, 'codeReview.evidence');
    return gate;
}
export async function startNextUltragoal(cwd, options = {}) {
    const plan = await readUltragoalPlan(cwd, options.planId);
    const now = iso(options.now);
    if (plan.aggregateCompletion?.status === 'complete')
        return { plan, goal: null, resumed: false, done: true };
    const existing = plan.goals.find((goal) => goal.status === 'in_progress');
    if (existing) {
        await appendLedger(cwd, { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' }, plan.planId);
        return { plan, goal: existing, resumed: true, done: false };
    }
    let next = plan.goals.find((goal) => goal.status === 'pending');
    if (!next && options.retryFailed) {
        next = plan.goals.find((goal) => goal.status === 'failed');
        if (next)
            await appendLedger(cwd, { ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason }, plan.planId);
    }
    if (!next)
        return { plan, goal: null, resumed: false, done: isUltragoalDone(plan) };
    next.status = 'in_progress';
    next.attempt += 1;
    next.startedAt = now;
    next.failedAt = undefined;
    next.failureReason = undefined;
    next.updatedAt = now;
    plan.activeGoalId = next.id;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, { ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` }, plan.planId);
    return { plan, goal: next, resumed: false, done: false };
}
export async function checkpointUltragoal(cwd, options) {
    const plan = await readUltragoalPlan(cwd, options.planId);
    const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
    if (!goal)
        throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
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
        }, plan.planId);
        return plan;
    }
    if (options.status === 'failed') {
        assertActiveInProgressCheckpoint(plan, goal, 'failed');
    }
    let aggregateCompletion;
    if (options.status === 'complete') {
        assertActiveInProgressCheckpoint(plan, goal, 'complete');
        const expectedObjective = expectedClaudeObjective(plan, goal);
        const aggregateMode = claudeGoalMode(plan) === 'aggregate';
        const finalRunCheckpoint = isFinalRunCompletionCandidate(plan, goal);
        const snapshot = options.claudeGoal === undefined ? null : parseClaudeGoalSnapshot(options.claudeGoal);
        const reconciliation = reconcileClaudeGoalSnapshot(snapshot, {
            expectedObjective,
            allowedStatuses: aggregateMode
                ? (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal ? ['complete'] : ['active'])
                : ['complete'],
            requireSnapshot: true,
            requireComplete: !aggregateMode || (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal),
        });
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
            }
            else {
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
        if (finalRunCheckpoint && !options.allowActiveFinalClaudeGoal)
            goal.evidence = options.evidence;
    }
    const qualityGate = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalClaudeGoal))
        ? validateQualityGate(options.qualityGate)
        : undefined;
    if (aggregateCompletion) {
        plan.aggregateCompletion = aggregateCompletion;
        if (plan.activeGoalId === goal.id)
            delete plan.activeGoalId;
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
        }, plan.planId);
        return plan;
    }
    goal.status = options.status;
    goal.updatedAt = now;
    if (options.status === 'complete') {
        goal.completedAt = now;
        goal.evidence = options.evidence;
        goal.failureReason = undefined;
        goal.failedAt = undefined;
        if (plan.activeGoalId === goal.id)
            delete plan.activeGoalId;
    }
    else {
        goal.failedAt = now;
        goal.failureReason = options.evidence;
        if (plan.activeGoalId === goal.id)
            delete plan.activeGoalId;
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
    }, plan.planId);
    return plan;
}
export async function recordFinalReviewBlockers(cwd, options) {
    const plan = await readUltragoalPlan(cwd, options.planId);
    const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
    if (!goal)
        throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
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
    const reconciliation = reconcileClaudeGoalSnapshot(options.claudeGoal === undefined ? null : parseClaudeGoalSnapshot(options.claudeGoal), {
        expectedObjective,
        allowedStatuses: ['active'],
        requireSnapshot: true,
        requireComplete: false,
    });
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
    if (plan.activeGoalId === goal.id)
        delete plan.activeGoalId;
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
    }, plan.planId);
    await appendLedger(cwd, {
        ts: now,
        event: 'goal_added',
        goalId: addedGoal.id,
        status: addedGoal.status,
        evidence: options.evidence,
        message: addedGoal.title,
    }, plan.planId);
    await appendLedger(cwd, {
        ts: now,
        event: 'goal_review_blocked',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        claudeGoal: options.claudeGoal,
    }, plan.planId);
    return { plan, blockedGoal: goal, addedGoal };
}
export function buildClaudeGoalInstruction(goal, plan) {
    if (claudeGoalMode(plan) === 'aggregate')
        return buildAggregateClaudeGoalInstruction(goal, plan);
    return buildPerStoryClaudeGoalInstruction(goal, plan);
}
function buildPerStoryClaudeGoalInstruction(goal, plan) {
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
        '- First confirm the active Claude /goal for this session; if none is active, invoke /goal <condition> with the payload below. If you cannot invoke /goal in this session (e.g. standalone Claude Code), ask the user to type it and wait; --claude-goal-json reconciles the ledger only and does not satisfy the PreToolUse /goal guard.',
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
        'Suggested /goal payload (model-facing — invoke /goal in-session; if you cannot, e.g. standalone Claude Code, ask the user to):',
        JSON.stringify(createPayload, null, 2),
        '',
        'Objective (use as the /goal condition):',
        goal.objective,
    ].filter((line) => line !== null).join('\n');
}
function buildAggregateClaudeGoalInstruction(goal, plan) {
    const objective = plan.claudeObjective ?? aggregateClaudeObjective(plan.goals, plan.planId);
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
        '- First confirm the active Claude /goal for this session; if none is active, invoke /goal <condition> with the aggregate payload below. If you cannot invoke /goal in this session (e.g. standalone Claude Code), ask the user to type it and wait; --claude-goal-json reconciles the ledger only and does not satisfy the PreToolUse /goal guard.',
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
        'Suggested /goal payload (model-facing — invoke /goal in-session; if you cannot, e.g. standalone Claude Code, ask the user to):',
        JSON.stringify(createPayload, null, 2),
        '',
        'Aggregate /goal condition:',
        objective,
        '',
        'Current OMC story objective:',
        goal.objective,
    ].filter((line) => line !== null).join('\n');
}
//# sourceMappingURL=artifacts.js.map