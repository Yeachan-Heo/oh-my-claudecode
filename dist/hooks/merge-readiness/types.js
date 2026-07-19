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
export {};
//# sourceMappingURL=types.js.map