/**
 * Judgment resolver - the single seam every judgment point consults.
 *
 * Dispatches a named judgment across the off | shadow | active tri-state:
 * - off / cap / circuit-open: twin decides, no fetch, no log
 * - shadow: twin decides; the Jev call is made (waited on unless
 *   blocking:false) and the comparison logged
 * - active: Jev answer decides; the twin result is preserved in the log
 *
 * Degrade paths (timeout, HTTP error, invalid response) return the twin and
 * log mode:"degraded". The resolver never throws and never rejects on the
 * Jev path - only twin() (and mapAnswer()) errors propagate, because twins
 * are existing repo code whose bugs must not be masked.
 */
import type { JevAnswer, JevLogContext, JevQuestions, ResolveResult } from './types.js';
/** Reset in-process resolver state (request cap, circuit breaker, warnings). Test hook. */
export declare function resetJevResolverState(): void;
export interface ResolveJudgmentArgs<T> {
    /** Judgment point name, e.g. "intent" or "model-routing". */
    point: string;
    /** State the caller wants judged. Strings are bounded before send/log. */
    state: unknown;
    /** TypeSafe questions object (Choice/Score/Noul definitions). */
    questions: JevQuestions;
    /** Heuristic twin thunk. Errors propagate (twins must not be masked). */
    twin: () => T;
    /**
     * Maps Jev's first answer onto the twin's result type. Defaults to an
     * unchecked cast. Only used in active mode.
     */
    mapAnswer?: (answer: JevAnswer) => T;
    /**
     * Extracts the comparison-relevant heuristic value from the twin result for shadow logging.
     * When not provided, the full twin result is logged as the heuristic.
     * For judgment points with non-primitive twins, this should return the comparable primitive
     * (boolean for noul, string for choice, number for score).
     * The optional questionSet parameter is provided when the point has multiple question sets.
     */
    mapHeuristic?: (twinResult: T, questionSet?: number) => unknown;
    /**
     * Index into the point's question sets (loop-continuation's Score call uses 1).
     * Provided to mapHeuristic to allow conditional extraction of the right field.
     */
    questionSet?: number;
    /**
     * Force "shadow" or "active" for this call, overriding code activation.
     * Config-off still wins.
     */
    mode?: 'shadow' | 'active';
    /**
     * Wait for the Jev call before returning. Default true (gate-type points).
     * Detector-type points pass false: twin returns immediately, the Jev call
     * is fire-and-forget and the comparison is logged when it settles.
     */
    blocking?: boolean;
    /**
     * The hook input of the call being judged, or any object carrying its ids
     * (see jevLogContextOf). Logged with OMC_JEV_LOG_CONTEXT=1, never sent.
     */
    logContext?: unknown;
    /** Test hook: injected transport. */
    fetchFn?: typeof fetch;
}
/**
 * The ids of one hook call for the Jev logs: tool_use_id, session_id, cwd,
 * agent_id, agent_type, prompt_id and request_id, read from a hook input
 * (snake or camel case). Only non-empty strings are kept, each cut to 1000
 * characters. Mirror of jevLogContextOf in scripts/jev-resolve.mjs.
 */
export declare function jevLogContextOf(source: unknown): JevLogContext;
/**
 * Rotate one Jev log file before an append. A file larger than maxBytes is
 * renamed to <name>-<YYYYMMDD-HHmmss>-<pid>.jsonl (UTC) in the same directory,
 * so the append starts a new file. maxBytes 0 turns rotation off. An existing
 * target is never overwritten, and a failed rename (another process rotated
 * the file first, the file is locked) is ignored: rotation is best-effort and
 * must never cost the line being appended. Rotated files are never deleted.
 * Every writer of a Jev log file calls this right before appending.
 * Mirror of rotateJevLog in scripts/jev-resolve.mjs.
 */
export declare function rotateJevLog(path: string, maxBytes: number, now?: Date): void;
/** Extract the loggable heuristic value, applying mapHeuristic if provided. */
/**
 * A logged heuristic is comparable with the logged Jev answer only when it is
 * a valid answer to the same question: the first declared question, whose
 * answer is the one logged. Anything else is logged as null (non-comparable).
 */
export declare function comparableHeuristic(value: unknown, questions: JevQuestions): string | number | boolean | null;
export declare function resolveJudgment<T>(resolveJudgmentArgs: ResolveJudgmentArgs<T>): Promise<ResolveResult<T>>;
//# sourceMappingURL=resolver.d.ts.map