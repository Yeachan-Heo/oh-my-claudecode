export declare const ULTRAGOAL_DIR = ".omc/ultragoal";
export declare const ULTRAGOAL_BRIEF = "brief.md";
export declare const ULTRAGOAL_GOALS = "goals.json";
export declare const ULTRAGOAL_LEDGER = "ledger.jsonl";
export declare const ULTRAGOAL_PLANS_SUBDIR = "plans";
/**
 * Multi-plan support (Wave 2 — multi-repo workspace parallelism).
 *
 * Legacy layout (single plan per repo, default for backwards compatibility):
 *   .omc/ultragoal/{brief.md, goals.json, ledger.jsonl}
 *
 * Multi-plan layout (opt-in via planId argument or --plan-id / --auto-plan-id CLI flag):
 *   .omc/ultragoal/plans/{planId}/{brief.md, goals.json, ledger.jsonl}
 *
 * planId is a stable string. Auto-generated form: "{ms}-{slug}" where slug is
 * derived from the first non-empty title in the brief.
 *
 * Plan resolution order when planId is not passed:
 *   1. legacy goals.json if present (covers monorepo single-session)
 *   2. exactly one plan under plans/ → use it
 *   3. zero or many → caller must pass planId
 */
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
    /**
     * Stable plan identifier. When undefined, the plan uses the legacy
     * single-plan layout (.omc/ultragoal/{brief.md,goals.json,ledger.jsonl}).
     * When set, artifacts live under .omc/ultragoal/plans/{planId}/.
     */
    planId?: string;
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
    event: 'plan_created' | 'goal_started' | 'goal_resumed' | 'goal_completed' | 'goal_blocked' | 'goal_failed' | 'goal_retried' | 'aggregate_completed' | 'goal_added' | 'final_review_failed' | 'goal_review_blocked';
    goalId?: string;
    status?: UltragoalStatus;
    message?: string;
    claudeGoal?: unknown;
    evidence?: string;
    qualityGate?: UltragoalQualityGate;
}
export interface CreateUltragoalOptions {
    brief: string;
    goals?: Array<{
        title?: string;
        objective: string;
        tokenBudget?: number;
    }>;
    claudeGoalMode?: UltragoalClaudeGoalMode;
    now?: Date;
    force?: boolean;
    /**
     * Explicit plan id; writes to .omc/ultragoal/plans/{planId}/. Mutually
     * exclusive with autoPlanId. When both omitted, plan uses legacy layout.
     */
    planId?: string;
    /**
     * Auto-generate a plan id from the brief title and current time.
     * Format: "{epochMs}-{slug}". Enables safe parallel ultragoal runs in
     * multi-repo workspaces sharing one .omc/.
     */
    autoPlanId?: boolean;
}
export interface StartNextOptions {
    now?: Date;
    retryFailed?: boolean;
    goalId?: string;
    planId?: string;
}
export interface CheckpointOptions {
    goalId: string;
    status: Extract<UltragoalStatus, 'complete' | 'failed'> | 'blocked';
    evidence?: string;
    claudeGoal?: unknown;
    qualityGate?: unknown;
    allowActiveFinalClaudeGoal?: boolean;
    now?: Date;
    planId?: string;
}
export interface AddUltragoalGoalOptions {
    title: string;
    objective: string;
    evidence?: string;
    now?: Date;
    planId?: string;
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
export declare class UltragoalError extends Error {
}
export declare function ultragoalDir(cwd: string, planId?: string): string;
export declare function ultragoalBriefPath(cwd: string, planId?: string): string;
export declare function ultragoalGoalsPath(cwd: string, planId?: string): string;
export declare function ultragoalLedgerPath(cwd: string, planId?: string): string;
/**
 * List all multi-plan IDs under .omc/ultragoal/plans/.
 * Returns an empty array when the plans/ subdir doesn't exist.
 */
export declare function listUltragoalPlanIds(cwd: string): Promise<string[]>;
/**
 * Resolve which plan a CLI command should target.
 *
 *  - explicitPlanId wins.
 *  - Legacy goals.json (no planId) wins next, for backwards compat.
 *  - If exactly one multi-plan exists, that one is selected.
 *  - Otherwise throws UltragoalError with the list of candidate planIds.
 */
export declare function resolveActivePlanId(cwd: string, explicitPlanId?: string): Promise<string | undefined>;
export declare function isFinalRunCompletionCandidate(plan: UltragoalPlan, goal: UltragoalItem): boolean;
export declare function isUltragoalDone(plan: UltragoalPlan): boolean;
export declare function deriveGoalCandidates(brief: string): Array<{
    title: string;
    objective: string;
}>;
export declare function readUltragoalPlan(cwd: string, planId?: string): Promise<UltragoalPlan>;
export declare function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan>;
export declare function summarizeUltragoalPlan(plan: UltragoalPlan): {
    total: number;
    pending: number;
    inProgress: number;
    complete: number;
    failed: number;
    reviewBlocked: number;
    aggregateComplete: boolean;
    activeGoalId?: string;
};
export declare function addUltragoalGoal(cwd: string, options: AddUltragoalGoalOptions): Promise<{
    plan: UltragoalPlan;
    goal: UltragoalItem;
}>;
export declare function startNextUltragoal(cwd: string, options?: StartNextOptions): Promise<{
    plan: UltragoalPlan;
    goal: UltragoalItem | null;
    resumed: boolean;
    done: boolean;
}>;
export declare function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan>;
export declare function recordFinalReviewBlockers(cwd: string, options: RecordFinalReviewBlockersOptions): Promise<{
    plan: UltragoalPlan;
    blockedGoal: UltragoalItem;
    addedGoal: UltragoalItem;
}>;
export declare function buildClaudeGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string;
//# sourceMappingURL=artifacts.d.ts.map