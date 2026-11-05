/**
 * Jev shadow judgment: "context-pruning" (judgment point 5).
 *
 * In shadow/off mode the heuristic (analyzeContextUsage -> action) decides;
 * Jev's staleness Score is requested asynchronously (blocking: false) and
 * recorded in the shadow log for later comparison. In active mode the score
 * is mapped to an action (see mapAnswer below). With no key configured this
 * is a no-op: zero HTTP calls, no log.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the call-specific state shape.
 */
import type { JevAnswer, ResolveResult } from '../jev/index.js';
export declare const CONTEXT_PRUNING_POINT = "context-pruning";
/**
 * Staleness label from a Jev answer. Only a score answer counts; another
 * answer type yields no label, even when it carries a `choice`. A score answer
 * carries only `score` (0 = fresh ... 3 = stale), so it is rounded to the
 * nearest label; a score outside 0..3 or a non-number yields no label. A
 * string `choice` that names one of the labels (case-insensitively) wins.
 */
export declare function stalenessLabelOf(answer: JevAnswer): string | undefined;
/** Metadata-only summary of one pruning candidate (a tool result). */
export interface PruningCandidate {
    /** Tool that produced the result, e.g. "read". */
    tool: string;
    /** Estimated token size of the result. */
    tokens: number;
    /** First-line excerpt of the result; bounded before send by the resolver. */
    excerpt: string;
}
/**
 * Record one shadow comparison for the context-pruning point.
 *
 * The twin is the heuristic's own action ('none' | 'warn' | 'compact'); in
 * shadow/off mode the twin is returned immediately (blocking: false) and the
 * Jev comparison is logged when it settles. In active mode, Jev's Score
 * answer is mapped to an action and returned immediately. Never rejects on
 * the Jev path. One call per compaction run with a summary state — never one
 * call per candidate.
 */
export declare function recordContextPruningShadow(args: {
    /** Heuristic twin decision for this run. */
    action: 'none' | 'warn' | 'compact';
    /** Cumulative session token estimate at decision time. */
    totalTokens: number;
    /** Candidate summaries: metadata and bounded excerpts only. */
    candidates: PruningCandidate[];
    /** Test hook: injected transport. */
    fetchFn?: typeof fetch;
}): Promise<ResolveResult<string>>;
//# sourceMappingURL=jev-shadow.d.ts.map