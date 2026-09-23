/**
 * Judgment-point registry - the single place a judgment point is declared.
 *
 * Each entry records the point's resolver key, its TypeSafe question sets,
 * and whether it is gate-type (blocking: callers wait on the Jev verdict) or
 * detector-type (non-blocking: the twin returns immediately, the Jev call
 * settles in the background). The registry holds declarations only; the one
 * execution path stays resolveJudgment (resolver.ts), reached through
 * recordJudgment below.
 *
 * Adding a judgment point (the ticket #8 precondition): one
 * defineJudgmentPoint entry here plus a thin recorder in the owning module -
 * no copied module.
 */
import type { JevQuestions, JudgmentPointName, ResolveResult } from './types.js';
export interface JudgmentPointDefinition {
    /** Resolver key (the `point` argument) - also the registry key. */
    name: string;
    /**
     * Question sets for this point, in resolver-call order. Most points have
     * exactly one; loop-continuation resolves once per question (Noul, Score),
     * so it declares two. The function form is re-evaluated per call
     * (skill-trigger derives its criteria from the detector's KEYWORD_PRIORITY).
     */
    questions: readonly (JevQuestions | (() => JevQuestions))[];
    /** Gate-type points (true) wait on the Jev verdict; detector-type do not. */
    blocking: boolean;
}
/** Declare a judgment point. Declaration only - nothing here executes. */
export declare function defineJudgmentPoint(definition: {
    name: string;
    questions: JevQuestions | (() => JevQuestions) | readonly (JevQuestions | (() => JevQuestions))[];
    blocking: boolean;
}): JudgmentPointDefinition;
/** The judgment-point registry: name -> declaration. */
export declare const JUDGMENT_POINTS: Readonly<Record<JudgmentPointName, JudgmentPointDefinition>>;
/** Look up a declared judgment point. */
export declare function getJudgmentPoint(name: string): JudgmentPointDefinition;
export interface RecordJudgmentCall<T> {
    /** State the caller wants judged (bounded by the resolver before send/log). */
    state: unknown;
    /** Heuristic twin thunk. Errors propagate (twins must not be masked). */
    twin: () => T;
    /** Index into the point's question sets (loop-continuation's Score call uses 1). */
    questionSet?: number;
    /** Test hook: injected transport. */
    fetchFn?: typeof fetch;
}
/**
 * Record one shadow comparison at a declared judgment point. Thin wrapper
 * over resolveJudgment that fills in the registry's name, questions, and
 * blocking flag; the caller supplies only the call-specific state and twin.
 */
export declare function recordJudgment<T>(pointName: string, call: RecordJudgmentCall<T>): Promise<ResolveResult<T>>;
//# sourceMappingURL=points.d.ts.map