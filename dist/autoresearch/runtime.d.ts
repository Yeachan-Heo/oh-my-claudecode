import type { ExecutionMode } from '../hooks/mode-registry/types.js';
import { type AutoresearchKeepPolicy, type AutoresearchMissionContract } from './contracts.js';
export type AutoresearchCandidateStatus = 'candidate' | 'noop' | 'abort' | 'interrupted';
export type AutoresearchDecisionStatus = 'baseline' | 'keep' | 'discard' | 'ambiguous' | 'noop' | 'abort' | 'interrupted' | 'error';
export type AutoresearchRunStatus = 'running' | 'stopped' | 'completed' | 'failed';
export interface PreparedAutoresearchRuntime {
    runId: string;
    runTag: string;
    runDir: string;
    instructionsFile: string;
    manifestFile: string;
    ledgerFile: string;
    latestEvaluatorFile: string;
    resultsFile: string;
    stateFile: string;
    candidateFile: string;
    repoRoot: string;
    worktreePath: string;
    taskDescription: string;
}
export interface AutoresearchEvaluationRecord {
    command: string;
    ran_at: string;
    status: 'pass' | 'fail' | 'error';
    pass?: boolean;
    score?: number;
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
    parse_error?: string;
}
export interface AutoresearchCandidateArtifact {
    status: AutoresearchCandidateStatus;
    candidate_commit: string | null;
    base_commit: string;
    description: string;
    notes: string[];
    created_at: string;
}
export interface AutoresearchLedgerEntry {
    iteration: number;
    kind: 'baseline' | 'iteration';
    decision: AutoresearchDecisionStatus;
    decision_reason: string;
    candidate_status: AutoresearchCandidateStatus | 'baseline';
    base_commit: string;
    candidate_commit: string | null;
    kept_commit: string;
    keep_policy: AutoresearchKeepPolicy;
    evaluator: AutoresearchEvaluationRecord | null;
    created_at: string;
    notes: string[];
    description: string;
}
export interface AutoresearchRunManifest {
    schema_version: 1;
    run_id: string;
    run_tag: string;
    mission_dir: string;
    mission_file: string;
    sandbox_file: string;
    repo_root: string;
    worktree_path: string;
    mission_slug: string;
    branch_name: string;
    baseline_commit: string;
    last_kept_commit: string;
    last_kept_score: number | null;
    latest_candidate_commit: string | null;
    results_file: string;
    instructions_file: string;
    manifest_file: string;
    ledger_file: string;
    latest_evaluator_file: string;
    candidate_file: string;
    evaluator: AutoresearchMissionContract['sandbox']['evaluator'];
    keep_policy: AutoresearchKeepPolicy;
    status: AutoresearchRunStatus;
    stop_reason: string | null;
    iteration: number;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
}
export interface AutoresearchMissionArtifactLayout {
    missionRoot: string;
    missionSpecFile: string;
    evaluatorReferenceFile: string;
    runsDir: string;
    runDir: string;
    evaluationsDir: string;
    decisionLogFile: string;
}
interface AutoresearchDecision {
    decision: AutoresearchDecisionStatus;
    decisionReason: string;
    keep: boolean;
    evaluator: AutoresearchEvaluationRecord | null;
    notes: string[];
}
interface AutoresearchInstructionLedgerSummary {
    iteration: number;
    decision: AutoresearchDecisionStatus;
    reason: string;
    kept_commit: string;
    candidate_commit: string | null;
    evaluator_status: AutoresearchEvaluationRecord['status'] | null;
    evaluator_score: number | null;
    description: string;
}
export declare function getAutoresearchMissionArtifactLayout(projectRoot: string, missionSlug: string, runId: string): AutoresearchMissionArtifactLayout;
export declare function buildAutoresearchRunTag(date?: Date): string;
export declare function assertResetSafeWorktree(worktreePath: string, allowedDirtyPaths?: readonly string[]): void;
/**
 * Assert no exclusive mode is already active (ralph, ultrawork, autopilot).
 * Mirrors OMX assertModeStartAllowed semantics using OMC mode-state-io.
 */
export declare function assertModeStartAllowed(mode: ExecutionMode, projectRoot: string): Promise<void>;
export declare function countTrailingAutoresearchNoops(ledgerFile: string): Promise<number>;
export declare function runAutoresearchEvaluator(contract: AutoresearchMissionContract, worktreePath: string, ledgerFile?: string, latestEvaluatorFile?: string): Promise<AutoresearchEvaluationRecord>;
export declare function decideAutoresearchOutcome(manifest: Pick<AutoresearchRunManifest, 'keep_policy' | 'last_kept_score'>, candidate: AutoresearchCandidateArtifact, evaluation: AutoresearchEvaluationRecord | null): AutoresearchDecision;
export declare function buildAutoresearchInstructions(contract: AutoresearchMissionContract, context: {
    runId: string;
    iteration: number;
    baselineCommit: string;
    lastKeptCommit: string;
    lastKeptScore?: number | null;
    resultsFile: string;
    candidateFile: string;
    keepPolicy: AutoresearchKeepPolicy;
    previousIterationOutcome?: string | null;
    recentLedgerSummary?: AutoresearchInstructionLedgerSummary[];
}): string;
export declare function materializeAutoresearchMissionToWorktree(contract: AutoresearchMissionContract, worktreePath: string): Promise<AutoresearchMissionContract>;
export declare function loadAutoresearchRunManifest(projectRoot: string, runId: string): Promise<AutoresearchRunManifest>;
export declare function prepareAutoresearchRuntime(contract: AutoresearchMissionContract, projectRoot: string, worktreePath: string, options?: {
    runTag?: string;
    maxRuntimeMs?: number;
}): Promise<PreparedAutoresearchRuntime>;
export declare function resumeAutoresearchRuntime(projectRoot: string, runId: string): Promise<PreparedAutoresearchRuntime>;
export declare function parseAutoresearchCandidateArtifact(raw: string): AutoresearchCandidateArtifact;
export declare function processAutoresearchCandidate(contract: AutoresearchMissionContract, manifest: AutoresearchRunManifest, projectRoot: string): Promise<AutoresearchDecisionStatus>;
export declare function finalizeAutoresearchRunState(projectRoot: string, runId: string, updates: {
    status: AutoresearchRunStatus;
    stopReason: string;
}): Promise<void>;
export declare function stopAutoresearchRuntime(projectRoot: string): Promise<void>;
export {};
//# sourceMappingURL=runtime.d.ts.map