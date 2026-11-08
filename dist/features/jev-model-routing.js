/**
 * Jev judgment point ④: model-tier routing (shadow mode).
 *
 * Wraps the delegation enforcer's existing tier resolution as the heuristic
 * twin of `resolveJudgment` for the "model-routing" point. Shadow-only: Jev's
 * Choice is recorded for comparison and never overrides the enforcer while in
 * shadow. Detector-type point (blocking:false) — this is a high-frequency
 * pre-tool path, so the pinned tier returns immediately and the Jev call
 * settles in the background (issue-3669 latency policy).
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the twin and the call-specific
 * state construction.
 */
import { recordJudgment } from '../hooks/jev/index.js';
/**
 * Record the shadow comparison for one delegated Task/Agent call.
 *
 * `pinned` is the enforcer's already-computed tier resolution; it is wrapped
 * as the twin (never recomputed, never overridden). With no TYPESAFE_API_KEY
 * or OMC_JEV=off the resolver answers "off" with zero HTTP calls and no log.
 * The returned promise resolves once the twin answer is available; the Jev
 * comparison log line settles asynchronously afterwards. Never rejects on the
 * Jev path.
 */
export function recordModelRoutingShadow(toolName, pinned, fetchFn) {
    return recordJudgment('model-routing', {
        state: {
            tool_name: toolName,
            subagent_type: pinned.originalInput.subagent_type,
            task: pinned.originalInput.prompt,
        },
        twin: () => pinned,
        fetchFn,
    });
}
//# sourceMappingURL=jev-model-routing.js.map