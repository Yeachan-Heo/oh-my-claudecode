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
export const MERGE_READINESS_DIMENSIONS = [
    "why",
    "change",
    "tradeoff",
    "risk",
    "team",
];
/**
 * Readiness thresholds per depth profile, expressed as a required correctness
 * rate over the answered MCQs.
 */
export const MERGE_READINESS_THRESHOLDS = {
    quick: 0.7,
    standard: 0.8,
    deep: 0.9,
};
/** Total MCQs presented per profile (the "max rounds" cap). */
export const MERGE_READINESS_MAX_ROUNDS = {
    quick: 3,
    standard: 5,
    deep: 8,
};
export function profileThreshold(profile) {
    return MERGE_READINESS_THRESHOLDS[profile] ?? MERGE_READINESS_THRESHOLDS.standard;
}
export function profileMaxRounds(profile) {
    return MERGE_READINESS_MAX_ROUNDS[profile] ?? MERGE_READINESS_MAX_ROUNDS.standard;
}
/**
 * Dimensions that must be covered before the gate can pass.
 * Quick is a lighter gate (why/change/risk); standard and deep cover all five.
 */
export function requiredDimensionsForProfile(profile) {
    if (profile === "quick")
        return ["why", "change", "risk"];
    return [...MERGE_READINESS_DIMENSIONS];
}
/** Objective check: does the selected option match the correct one? */
export function scoreMCQResponse(question, selectedOptionId) {
    return selectedOptionId === question.correctOptionId;
}
/** Correctness rate over answered MCQs, in [0, 1]. Empty -> 0. */
export function computeCorrectnessRate(answers) {
    if (answers.length === 0)
        return 0;
    const correct = answers.filter((a) => a.isCorrect).length;
    return correct / answers.length;
}
export function isCorrectnessPass(rate, threshold) {
    return rate >= threshold;
}
/**
 * Whether every required dimension has at least one answered MCQ.
 * The gate does not pass until required coverage exists, even if the rate
 * is high, so a human cannot skip a dimension they cannot explain.
 */
export function hasRequiredDimensionCoverage(answers, questions, requiredDimensions) {
    const answeredDimensions = new Set(answers
        .map((answer) => questions.find((q) => q.id === answer.questionId)?.dimension)
        .filter((d) => Boolean(d)));
    return requiredDimensions.every((dimension) => answeredDimensions.has(dimension));
}
//# sourceMappingURL=mcq.js.map