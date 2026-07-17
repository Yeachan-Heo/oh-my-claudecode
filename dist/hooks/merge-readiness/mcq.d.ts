/**
 * Merge Readiness MCQ module.
 *
 * Objective multiple-choice scoring for the post-task explainability gate.
 * The runtime uses these pure helpers to judge human answers without semantic
 * guessing: an MCQ has exactly one correct option, and code checks equality.
 *
 * Depth profiles (v1, unified with skills/merge-readiness/SKILL.md):
 *   quick    -> threshold 0.70, max 3 MCQs, dims: why/change/risk
 *   standard -> threshold 0.80, max 5 MCQs, dims: why/change/tradeoff/risk/team
 *   deep     -> threshold 0.90, max 8 MCQs (redundancy across dims)
 *
 * "max rounds" == total MCQs presented. The AI distributes MCQs across the
 * required dimensions (with redundancy for deep) up to that count.
 */
export type MergeReadinessDimension = "why" | "change" | "tradeoff" | "risk" | "team";
export type MergeReadinessProfile = "quick" | "standard" | "deep";
export declare const MERGE_READINESS_DIMENSIONS: readonly MergeReadinessDimension[];
/**
 * Readiness thresholds per depth profile, expressed as a required correctness
 * rate over the answered MCQs.
 */
export declare const MERGE_READINESS_THRESHOLDS: Readonly<Record<MergeReadinessProfile, number>>;
/** Total MCQs presented per profile (the "max rounds" cap). */
export declare const MERGE_READINESS_MAX_ROUNDS: Readonly<Record<MergeReadinessProfile, number>>;
export interface MergeReadinessMCQOption {
    id: string;
    text: string;
}
export interface MergeReadinessMCQQuestion {
    id: string;
    dimension: MergeReadinessDimension;
    stem: string;
    options: MergeReadinessMCQOption[];
    /** Option id that is objectively correct. */
    correctOptionId: string;
    /** Why the correct option is right / what understanding it verifies. */
    rationale?: string;
}
export interface MergeReadinessMCQAnswer {
    questionId: string;
    selectedOptionId: string;
    isCorrect: boolean;
    answeredAt?: string;
}
export declare function profileThreshold(profile: MergeReadinessProfile): number;
export declare function profileMaxRounds(profile: MergeReadinessProfile): number;
/**
 * Dimensions that must be covered before the gate can pass.
 * Quick is a lighter gate (why/change/risk); standard and deep cover all five.
 */
export declare function requiredDimensionsForProfile(profile: MergeReadinessProfile): MergeReadinessDimension[];
/** Objective check: does the selected option match the correct one? */
export declare function scoreMCQResponse(question: MergeReadinessMCQQuestion, selectedOptionId: string): boolean;
/** Correctness rate over answered MCQs, in [0, 1]. Empty -> 0. */
export declare function computeCorrectnessRate(answers: MergeReadinessMCQAnswer[]): number;
export declare function isCorrectnessPass(rate: number, threshold: number): boolean;
/**
 * Whether every required dimension has at least one answered MCQ.
 * The gate does not pass until required coverage exists, even if the rate
 * is high, so a human cannot skip a dimension they cannot explain.
 */
export declare function hasRequiredDimensionCoverage(answers: MergeReadinessMCQAnswer[], questions: MergeReadinessMCQQuestion[], requiredDimensions: MergeReadinessDimension[]): boolean;
//# sourceMappingURL=mcq.d.ts.map