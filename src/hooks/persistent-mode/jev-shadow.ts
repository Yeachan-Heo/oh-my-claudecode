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

import { isJevStateOmitIdsEnabled, noulAnswerIsYes, recordJudgment } from '../jev/index.js';
import type { JevAnswer } from '../jev/index.js';
import type { PersistentModeResult } from './index.js';

/**
 * Iteration metadata only: mode/session/iteration context, tool names, and
 * the continuation-message excerpt (bounded by the point's excerpt limit in the
 * resolver before send/log: 2000 characters by default, or
 * OMC_JEV_EXCERPT_CHARS_LOOP_CONTINUATION). Never whole file contents. Without
 * session_id under OMC_JEV_STATE_OMIT_IDS=1.
 */
function buildLoopContinuationState(result: PersistentModeResult, sessionId?: string): Record<string, unknown> {
  return {
    mode_name: result.mode,
    ...(isJevStateOmitIdsEnabled() ? {} : { session_id: sessionId ?? null }),
    iteration: result.metadata?.iteration ?? null,
    phase: result.metadata?.phase ?? null,
    should_block: result.shouldBlock,
    continuation_excerpt: result.shouldBlock ? result.message : '',
    tool_error_tool: result.metadata?.toolError?.tool_name ?? null,
  };
}

export interface LoopContinuationShadowArgs {
  /** The Stop hook's existing continuation decision (the twin). */
  result: PersistentModeResult;
  sessionId?: string;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
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
export async function applyLoopContinuationShadow(args: LoopContinuationShadowArgs): Promise<PersistentModeResult> {
  const { result } = args;
  // No active mode: there is no loop iteration to judge (cancel paths,
  // kill switches, and "nothing active" stops bypass this point).
  if (result.mode === 'none') return result;

  const state = buildLoopContinuationState(result, args.sessionId);
  
  // For active mode, map Jev's Noul answer (task complete?) to the continuation decision
  const mapTaskCompletionAnswer = (answer: JevAnswer): PersistentModeResult => {
    // Jev Noul answer: noul is the probability of "yes" (0-1); "yes" means the task is complete
    const taskComplete = noulAnswerIsYes(answer);
    if (taskComplete) {
      // Task is complete, exit the loop
      return { ...result, shouldBlock: false, message: '[jev-completion] task complete; exiting loop' };
    } else {
      // Task is not complete, continue the loop  
      return result;
    }
  };
  
  const mapHeuristicForLoopContinuation = (r: PersistentModeResult, questionSet?: number): boolean | number | null => {
    if (questionSet === 1) {
      // Score question (iteration progress): shouldBlock does not reliably indicate
      // actual progress made. Continuing (shouldBlock=true) does not mean we made
      // progress; stopping (shouldBlock=false) does not mean zero progress. Without
      // actual progress metrics, return null to make this comparison non-comparable.
      return null;
    }
    // Question set 0 (Noul): "Is the task complete?"
    // Blocking the stop is an explicit "not complete" judgment. Releasing the stop
    // is not evidence of completion in any mode: failures, cancellations, circuit
    // breakers, diagnostics and exhausted runtimes all release without finishing.
    // The result carries no explicit completion signal, so a release is non-comparable.
    return r.shouldBlock ? false : null;
  };

  const results = await Promise.all([
    recordJudgment<PersistentModeResult>('loop-continuation', {
      state,
      twin: () => result,
      mapAnswer: mapTaskCompletionAnswer,
      mapHeuristic: mapHeuristicForLoopContinuation,
      logContext: { session_id: args.sessionId },
      fetchFn: args.fetchFn,
    }),
    recordJudgment<PersistentModeResult>('loop-continuation', {
      state,
      twin: () => result,
      questionSet: 1,
      mapHeuristic: mapHeuristicForLoopContinuation,
      logContext: { session_id: args.sessionId },
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
