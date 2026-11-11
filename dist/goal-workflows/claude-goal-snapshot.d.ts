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
export declare class ClaudeGoalSnapshotError extends Error {
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
export declare function parseClaudeGoalSnapshot(value: unknown): ClaudeGoalSnapshot;
export declare function readClaudeGoalSnapshotInput(raw: string | undefined, cwd?: string): Promise<ClaudeGoalSnapshot | null>;
export declare function reconcileClaudeGoalSnapshot(snapshot: ClaudeGoalSnapshot | null | undefined, options: ReconcileClaudeGoalOptions): ClaudeGoalReconciliation;
export declare function formatClaudeGoalReconciliation(reconciliation: ClaudeGoalReconciliation): string;
//# sourceMappingURL=claude-goal-snapshot.d.ts.map