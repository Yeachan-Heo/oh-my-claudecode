/**
 * Shadow judgment point wired to the task-size detector (issue #790,
 * ticket 09).
 *
 * Detector-type (blocking:false): the detector's existing classifyTaskSize
 * computation is the heuristic twin and always decides; Jev's Choice over
 * small/medium/large is only recorded for later comparison. resolveJudgment
 * never rejects on the Jev path, so callers fire this without awaiting it —
 * prompt submission latency is unchanged. With TYPESAFE_API_KEY unset the
 * resolver short-circuits to the twin with zero HTTP calls.
 *
 * The classification result is consumed by getAllKeywordsWithSizeCheck in
 * bridge.ts; the recorder is wired at the detector level only (runtime
 * invocation from the bridge is a recorded follow-up).
 */

import { classifyTaskSize, type TaskSizeResult } from './index.js';
import { resolveJudgment } from '../jev/index.js';
import type { JevQuestions, ResolveResult } from '../jev/index.js';

const TASK_SIZE_QUESTIONS: JevQuestions = {
  'task-size': {
    type: 'Choice',
    instructions: 'What size is this task — how much orchestration does it warrant?',
    criteria: {
      small: 'Single-file or few-line change; run directly without heavy modes',
      medium: 'Multi-file but single-area change; standard delegation',
      large: 'Multi-area or architectural change; heavy orchestration (ralph/autopilot/team) is warranted',
    },
  },
};

/**
 * Point "task-size" (ticket 09): the detector's word-count/regex
 * classification decides; Jev's Choice is recorded per prompt.
 */
export function recordTaskSizeShadow(
  prompt: string,
  fetchFn?: typeof fetch,
): Promise<ResolveResult<TaskSizeResult>> {
  return resolveJudgment<TaskSizeResult>({
    point: 'task-size',
    state: { prompt, source: 'user-prompt-submit' },
    questions: TASK_SIZE_QUESTIONS,
    twin: () => classifyTaskSize(prompt),
    blocking: false,
    fetchFn,
  });
}
