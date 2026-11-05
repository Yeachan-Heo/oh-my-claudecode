/**
 * Jev judgment point: slop-warning (shadow) — recorder only, no runtime wiring.
 *
 * Ticket 12 of the Jev judgment-points feature. The slop-warning heuristic
 * (shouldWarnForSlopFallbackLanguage) lives in scripts/pre-tool-enforcer.mjs,
 * which cannot import TypeScript; wiring a runtime call would require either
 * porting the heuristic to TS or a CJS→ESM bridge. Until that follow-up
 * lands, this recorder is exported and tested only: callers (today, tests)
 * pass their already-computed warning decision as the twin.
 *
 * Advisory point, shadow-only: the twin always decides; Jev's Noul answer is
 * recorded only. The point declaration lives in the jev registry
 * (hooks/jev/points.ts).
 */
import { recordJudgment } from '../hooks/jev/index.js';
/**
 * Record the shadow comparison for one tool input and return the twin
 * decision unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not naming this
 * point) the resolver short-circuits: zero HTTP calls, no logging, same
 * decision.
 */
export function recordSlopWarningShadow(args) {
    return recordJudgment('slop-warning', {
        state: {
            tool_name: args.toolName,
            tool_input: args.toolInput,
            source: 'pre-tool-enforcer',
        },
        twin: () => args.warned,
        fetchFn: args.fetchFn,
    });
}
//# sourceMappingURL=jev-slop-warning.js.map