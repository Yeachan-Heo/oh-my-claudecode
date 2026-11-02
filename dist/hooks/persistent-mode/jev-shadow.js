/**
 * Jev judgment point: loop-continuation (shadow).
 *
 * Ticket 03 of the Jev judgment-points feature (issue-3669). Wraps the
 * persistent-mode Stop hook's continuation decision (continue vs bypass vs
 * inject a continuation message) as the heuristic twin of a gate-type
 * resolveJudgment call. In shadow mode the twin always decides — the hook's
 * output is byte-identical with and without TYPESAFE_API_KEY — and Jev's
 * Noul/Score answers are recorded only.
 *
 * The point declaration (both question sets, blocking) lives in the jev
 * registry (hooks/jev/points.ts). The resolver logs one Jev answer per shadow
 * line, so the point resolves once per question (Noul, Score); both calls
 * share the same twin decision and iteration state.
 */
import { recordJudgment } from '../jev/index.js';
/**
 * Iteration metadata only: mode/session/iteration context, tool names, and
 * the continuation-message excerpt (bounded by OMC_JEV_EXCERPT_CHARS in the
 * resolver before send/log). Never whole file contents.
 */
function buildLoopContinuationState(result, sessionId) {
    return {
        mode_name: result.mode,
        session_id: sessionId ?? null,
        iteration: result.metadata?.iteration ?? null,
        phase: result.metadata?.phase ?? null,
        should_block: result.shouldBlock,
        continuation_excerpt: result.shouldBlock ? result.message : '',
        tool_error_tool: result.metadata?.toolError?.tool_name ?? null,
    };
}
/**
 * Record the shadow comparison for one loop-continuation decision and return
 * the result (twin in shadow/off mode, Jev-modified in active mode). With no
 * TYPESAFE_API_KEY (or OMC_JEV=off / grayscale exclusion) the resolver
 * short-circuits: zero HTTP calls, no logging, and the result is returned
 * as-is. Jev errors degrade inside the resolver and fall back to the twin.
 *
 * In active mode, Jev's Noul answer (task complete?) can override the heuristic
 * continuation decision.
 */
export async function applyLoopContinuationShadow(args) {
    const { result } = args;
    // No active mode: there is no loop iteration to judge (cancel paths,
    // kill switches, and "nothing active" stops bypass this point).
    if (result.mode === 'none')
        return result;
    const state = buildLoopContinuationState(result, args.sessionId);
    // For active mode, map Jev's Noul answer (task complete?) to a boolean
    const mapTaskCompletionAnswer = (answer) => {
        // Jev Noul answer: noul=true means task is complete, noul=false/undefined means not complete
        const taskComplete = answer.noul === true;
        if (taskComplete) {
            // Task is complete, exit the loop
            return { ...result, shouldBlock: false, message: '[jev-completion] task complete; exiting loop' };
        }
        else {
            // Task is not complete, continue the loop  
            return result;
        }
    };
    const mapHeuristicForLoopContinuation = (r, questionSet) => {
        if (questionSet === 1) {
            // Score question (iteration progress): shouldBlock does not reliably indicate
            // actual progress made. Continuing (shouldBlock=true) does not mean we made
            // progress; stopping (shouldBlock=false) does not mean zero progress. Without
            // actual progress metrics, return null to make this comparison non-comparable.
            return null;
        }
        // Question set 0 (Noul, default): Is task complete?
        // shouldBlock=true means prevent stopping (task NOT complete)
        // shouldBlock=false USUALLY means allow stopping (task IS complete),
        // BUT when a persistent mode allows stopping due to pipeline failure/cancellation
        // (safety release), it may return shouldBlock=false without task completion.
        // This applies to: team (failure/cancellation), ralplan (circuit breaker/agent still
        // running), autoresearch (failure/cancellation/runtime exhausted). In these cases,
        // return null to make the comparison non-comparable (not actual task completion).
        if (!r.shouldBlock && ['team', 'ralplan', 'autoresearch'].includes(r.mode)) {
            return null; // Safety release or permission to stop, not task completion
        }
        return !r.shouldBlock;
    };
    const results = await Promise.all([
        recordJudgment('loop-continuation', {
            state,
            twin: () => result,
            mapAnswer: mapTaskCompletionAnswer,
            mapHeuristic: mapHeuristicForLoopContinuation,
            fetchFn: args.fetchFn,
        }),
        recordJudgment('loop-continuation', {
            state,
            twin: () => result,
            questionSet: 1,
            mapHeuristic: mapHeuristicForLoopContinuation,
            fetchFn: args.fetchFn,
        }),
    ]);
    // In active mode, use Jev's mapped result; otherwise return the twin
    const noulResult = results[0];
    if (noulResult.mode === 'active') {
        return noulResult.answer;
    }
    // Shadow/off/degraded: return unchanged
    return result;
}
//# sourceMappingURL=jev-shadow.js.map