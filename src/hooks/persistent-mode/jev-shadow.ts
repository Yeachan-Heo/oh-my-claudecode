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
import type { PersistentModeResult } from './index.js';

/**
 * Iteration metadata only: mode/session/iteration context, tool names, and
 * the continuation-message excerpt (bounded by OMC_JEV_EXCERPT_CHARS in the
 * resolver before send/log). Never whole file contents.
 */
function buildLoopContinuationState(result: PersistentModeResult, sessionId?: string): Record<string, unknown> {
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

export interface LoopContinuationShadowArgs {
  /** The Stop hook's existing continuation decision (the twin). */
  result: PersistentModeResult;
  sessionId?: string;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

/**
 * Record the shadow comparison for one loop-continuation decision and return
 * the twin unchanged. With no TYPESAFE_API_KEY (or OMC_JEV=off / grayscale
 * exclusion) the resolver short-circuits: zero HTTP calls, no logging, and
 * the result is returned as-is. Jev errors degrade inside the resolver and
 * can never alter the returned decision; the twin returns a captured value
 * so twin errors cannot occur.
 */
export async function applyLoopContinuationShadow(args: LoopContinuationShadowArgs): Promise<PersistentModeResult> {
  const { result } = args;
  // No active mode: there is no loop iteration to judge (cancel paths,
  // kill switches, and "nothing active" stops bypass this point).
  if (result.mode === 'none') return result;

  const state = buildLoopContinuationState(result, args.sessionId);
  await Promise.all([
    recordJudgment<PersistentModeResult>('loop-continuation', {
      state,
      twin: () => result,
      fetchFn: args.fetchFn,
    }),
    recordJudgment<PersistentModeResult>('loop-continuation', {
      state,
      twin: () => result,
      questionSet: 1,
      fetchFn: args.fetchFn,
    }),
  ]);
  return result;
}
