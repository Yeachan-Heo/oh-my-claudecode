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
import { recordJudgment } from '../jev/index.js';
export const CONTEXT_PRUNING_POINT = 'context-pruning';
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
export function recordContextPruningShadow(args) {
    return recordJudgment(CONTEXT_PRUNING_POINT, {
        state: {
            action: args.action,
            totalTokens: args.totalTokens,
            candidateCount: args.candidates.length,
            candidates: args.candidates.map((candidate) => ({
                tool: candidate.tool,
                tokens: candidate.tokens,
                excerpt: candidate.excerpt,
            })),
        },
        twin: () => args.action,
        mapAnswer: (answer) => {
            // Jev Score answer has { type: 'score', choice: 'fresh' | 'recent' | 'aging' | 'stale' }
            const choice = answer.choice?.toLowerCase();
            // Map staleness to action: fresh/recent -> none, aging -> warn, stale -> compact
            if (choice === 'fresh' || choice === 'recent')
                return 'none';
            if (choice === 'aging')
                return 'warn';
            if (choice === 'stale')
                return 'compact';
            return 'none'; // Default fallback
        },
        fetchFn: args.fetchFn,
    });
}
//# sourceMappingURL=jev-shadow.js.map