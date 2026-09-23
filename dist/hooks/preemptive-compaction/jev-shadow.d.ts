/**
 * Jev shadow judgment: "context-pruning" (judgment point 5).
 *
 * Shadow-only. The existing heuristic (analyzeContextUsage -> action) still
 * decides everything; Jev's staleness Score is requested asynchronously
 * (blocking: false) and recorded in the shadow log for later comparison.
 * With no key configured this is a no-op: zero HTTP calls, no log.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the call-specific state shape.
 */
import type { ResolveResult } from '../jev/index.js';
export declare const CONTEXT_PRUNING_POINT = "context-pruning";
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
 * The twin is the heuristic's own action ('none' | 'warn' | 'compact'); the
 * returned promise resolves with that twin immediately (blocking: false) and
 * the Jev comparison is logged when it settles. Never rejects on the Jev
 * path. One call per compaction run with a summary state — never one call
 * per candidate.
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