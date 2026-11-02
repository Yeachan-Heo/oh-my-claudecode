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
import { classifyTaskSize } from './index.js';
import { recordJudgment } from '../jev/index.js';
/**
 * Point "task-size" (ticket 09): the detector's word-count/regex
 * classification decides in shadow/off mode; Jev's Choice is recorded per prompt.
 * In active mode, Jev's answer is mapped to the TaskSizeResult type.
 */
export function recordTaskSizeShadow(prompt, fetchFn) {
    return recordJudgment('task-size', {
        state: { prompt, source: 'user-prompt-submit' },
        twin: () => classifyTaskSize(prompt),
        mapAnswer: (answer) => {
            // Jev answer is a Choice over { small, medium, large }
            const choice = answer.choice?.toLowerCase();
            const sizeMap = {
                small: 'small',
                medium: 'medium',
                large: 'large',
            };
            const size = choice && choice in sizeMap ? sizeMap[choice] : 'medium';
            return {
                size,
                reason: `Jev active-mode classification: ${choice}`,
                wordCount: 0, // Not available from Jev answer
                hasEscapeHatch: false, // Not available from Jev answer
                confidence: answer.confidence,
            };
        },
        fetchFn,
    });
}
//# sourceMappingURL=jev-shadow.js.map