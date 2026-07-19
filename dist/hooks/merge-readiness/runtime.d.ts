import { type MergeReadinessMCQQuestion } from "./mcq.js";
import type { MergeReadinessEvidence, MergeReadinessProfile, MergeReadinessPromptResult, MergeReadinessResult, MergeReadinessState } from "./types.js";
export declare function parseMergeReadinessProfile(promptText: string): MergeReadinessProfile;
export declare function slugifyMergeReadiness(input: string): string;
export declare function collectMergeReadinessEvidence(directory: string, baseRef?: string, sessionId?: string): MergeReadinessEvidence;
export declare function readMergeReadinessState(directory: string, sessionId?: string): MergeReadinessState | null;
export declare function writeMergeReadinessState(directory: string, state: MergeReadinessState, sessionId?: string): boolean;
/**
 * Seed initial merge-readiness state. Called by the bridge on `/merge-readiness`
 * and by the autopilot adapter's onEnter. Collects evidence, picks the profile
 * threshold/maxRounds/required dims from mcq.ts, and marks the state as
 * awaiting AI-generated content (doc + MCQs).
 */
export declare function createInitialMergeReadinessState(directory: string, promptText: string, sessionId?: string, baseRef?: string): MergeReadinessState;
/**
 * AI writes the generated explanation doc (5 sections) + MCQs into state.
 * Called after the AI has read the evidence and produced narrative + questions.
 * Each question must carry correctOptionId so the runtime can score objectively.
 */
export declare function setMergeReadinessContent(directory: string, content: {
    why: string;
    whatChanged: string;
    tradeoffs: string;
    risksConsidered: string;
    teamUnderstanding: string;
    questions: MergeReadinessMCQQuestion[];
}, sessionId?: string): MergeReadinessState | null;
/**
 * Record one MCQ answer (objective scoring via scoreMCQResponse), append it,
 * and finalize the gate if all required questions are answered.
 */
export declare function recordMergeReadinessMCQAnswer(directory: string, questionId: string, selectedOptionId: string, sessionId?: string): MergeReadinessState | null;
/** Correlate only a marked native AskUserQuestion result to the current MCQ. */
export declare function recordMergeReadinessAskUserQuestionResult(directory: string, toolInput: unknown, toolOutput: unknown, sessionId?: string): MergeReadinessState | null;
export declare function validateMergeReadinessContent(content: {
    why: string;
    whatChanged: string;
    tradeoffs: string;
    risksConsidered: string;
    teamUnderstanding: string;
    questions: MergeReadinessMCQQuestion[];
}, state: Pick<MergeReadinessState, "required_dimensions" | "max_rounds">): string[];
export declare function overrideMergeReadiness(directory: string, reason: string, sessionId?: string): MergeReadinessState | null;
export declare function cancelMergeReadiness(directory: string, sessionId?: string): MergeReadinessState | null;
export declare function formatMergeReadinessQuestionMessage(state: MergeReadinessState): string;
/**
 * @deprecated Legacy text-answer recorder. Only routes to the old open-ended
 * round shape when the state has no AI-generated MCQs yet. When MCQs exist,
 * the AI-driven recordMergeReadinessMCQAnswer path is canonical.
 */
export declare function recordMergeReadinessAnswer(directory: string, answer: string, sessionId?: string): MergeReadinessState | null;
export declare function isLikelyMergeReadinessAnswer(promptText: string): boolean;
export declare function handleMergeReadinessPromptSubmit(directory: string, promptText: string, sessionId?: string): MergeReadinessPromptResult;
/**
 * Stop-hook gate. Reads state; if active and not yet passed, blocks the session
 * and injects the pending MCQ (or an awaiting-content nudge). Releases on pass.
 */
export declare function checkMergeReadiness(sessionId: string | undefined, directory: string, cancelInProgress: boolean): Promise<{
    shouldBlock: boolean;
    message: string;
    result: MergeReadinessResult;
} | null>;
export type { MergeReadinessRound } from "./types.js";
//# sourceMappingURL=runtime.d.ts.map