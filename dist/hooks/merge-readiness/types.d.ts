/**
 * Merge Readiness state, evidence, and result types.
 *
 * The v1 explainability gate is MCQ-driven: the AI generates an explanation
 * document (5 narrative sections) plus a set of multiple-choice questions, the
 * human answers them one per round (deep-interview style), and the runtime
 * scores each answer objectively (selected option === correct option).
 *
 * Canonical dimension/profile/threshold definitions live in ./mcq.js and are
 * re-exported here so existing imports from ./types.js keep compiling.
 */
export type { MergeReadinessDimension, MergeReadinessProfile, MergeReadinessMCQOption, MergeReadinessMCQQuestion, MergeReadinessMCQAnswer, } from "./mcq.js";
import type { MergeReadinessDimension, MergeReadinessProfile, MergeReadinessMCQQuestion, MergeReadinessMCQAnswer } from "./mcq.js";
export type MergeReadinessPhase = "evidence" | "content" | "questioning" | "complete";
export type MergeReadinessResult = "pending" | "pass" | "paused" | "blocked" | "overridden" | "cancelled";
export interface MergeReadinessEvidence {
    changedFiles: string[];
    /** Untracked paths are context only; they are never proof for --from-diff. */
    untrackedFiles?: string[];
    status: string;
    diffStat: string;
    sourceArtifacts: string[];
    testEvidence: string[];
    reviewEvidence: string[];
    missingEvidence: string[];
    /** The base ref the diff was computed against (explicit baseRef arg or auto-detected upstream). */
    base_ref?: string;
}
/**
 * @deprecated v1 uses objective MCQ scoring (questions + answers). This open
 * ended round shape is retained only for backward-compatible state files and
 * the legacy prompt-as-answer fallback; new code should not populate it.
 */
export interface MergeReadinessRound {
    round: number;
    dimension: MergeReadinessDimension;
    question: string;
    answer?: string;
    score?: number;
    created_at: string;
    answered_at?: string;
}
export interface MergeReadinessState {
    active: boolean;
    session_id?: string;
    current_phase: "merge-readiness";
    phase: MergeReadinessPhase;
    profile: MergeReadinessProfile;
    threshold: number;
    max_rounds: number;
    required_dimensions: MergeReadinessDimension[];
    /** @deprecated retained for backward-compatible state files; MCQ path uses questions/answers. */
    rounds: MergeReadinessRound[];
    /** AI-generated MCQs for this change. Empty until the AI calls setMergeReadinessContent. */
    questions: MergeReadinessMCQQuestion[];
    /** Human MCQ answers recorded one per round. */
    answers: MergeReadinessMCQAnswer[];
    /** True until the AI writes the generated doc + MCQs into state. */
    awaiting_content: boolean;
    validation_errors?: string[];
    /** Next unanswered MCQ the human should see (deep-interview one-per-round). */
    pending_question?: MergeReadinessMCQQuestion;
    evidence: MergeReadinessEvidence;
    /** Correctness rate over answered MCQs, in [0, 1]. */
    readiness_score: number;
    dimension_scores: Partial<Record<MergeReadinessDimension, number>>;
    result: MergeReadinessResult;
    why: string;
    whatChanged: string;
    tradeoffs: string;
    risksConsidered: string;
    teamUnderstanding: string;
    started_at: string;
    updated_at: string;
    completed_at?: string;
    override_reason?: string;
    /** Operator identity that recorded the override (session id of the override call). */
    override_owner?: string;
    /** Operator identity that cancelled the gate (session id, or "legacy" for the no-session bulk path). */
    cancel_owner?: string;
    change_summary: string;
    slug: string;
    /** Evidence source mode: --from-diff requires a diff; --from-artifacts accepts .omc artifacts. */
    source_mode?: "diff" | "artifacts";
    /** Summaries of prior terminal attempts on this session, preserved across re-starts. */
    prior_attempts?: MergeReadinessAttempt[];
}
export interface MergeReadinessAttempt {
    profile: MergeReadinessProfile;
    threshold: number;
    max_rounds: number;
    required_dimensions: MergeReadinessDimension[];
    change_summary: string;
    slug: string;
    why: string;
    whatChanged: string;
    tradeoffs: string;
    risksConsidered: string;
    teamUnderstanding: string;
    started_at?: string;
    completed_at?: string;
    result: MergeReadinessResult;
    override_reason?: string;
    override_owner?: string;
    cancel_owner?: string;
    readiness_score: number;
    dimension_scores: Partial<Record<MergeReadinessDimension, number>>;
    questions: MergeReadinessMCQQuestion[];
    answers: MergeReadinessMCQAnswer[];
    evidence_summary: {
        changedFiles: string[];
        source_mode?: "diff" | "artifacts";
        missingEvidence: string[];
        sourceArtifactCount: number;
        testEvidenceCount: number;
        reviewEvidenceCount: number;
    };
}
export interface MergeReadinessPromptResult {
    handled: boolean;
    message?: string;
}
//# sourceMappingURL=types.d.ts.map