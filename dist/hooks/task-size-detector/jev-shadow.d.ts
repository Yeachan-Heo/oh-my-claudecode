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
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the twin and the call-specific
 * state construction. The classification result is consumed by
 * getAllKeywordsWithSizeCheck in bridge.ts; the recorder is wired at the
 * detector level only (runtime invocation from the bridge is a recorded
 * follow-up).
 */
import { type TaskSizeResult } from './index.js';
import type { ResolveResult } from '../jev/index.js';
/**
 * Point "task-size" (ticket 09): the detector's word-count/regex
 * classification decides; Jev's Choice is recorded per prompt.
 */
export declare function recordTaskSizeShadow(prompt: string, fetchFn?: typeof fetch): Promise<ResolveResult<TaskSizeResult>>;
//# sourceMappingURL=jev-shadow.d.ts.map