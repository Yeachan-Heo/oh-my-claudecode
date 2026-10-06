/**
 * Jev judgment point: learner-extraction (shadow).
 *
 * Ticket 12 of the Jev judgment-points feature. Wraps the learner detector's
 * existing confidence heuristic (detectExtractableMoment) as the twin of a
 * detector-type resolveJudgment call. Advisory point, shadow-only: the twin
 * always decides; Jev's Noul answer is recorded only and never gates the
 * extraction prompt. Degrade paths are handled inside the resolver.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the call-specific state shape.
 */
import { detectExtractableMoment } from './detector.js';
import { recordJudgment } from '../jev/index.js';
/**
 * Record the shadow comparison for one assistant message and return the
 * detection (twin in shadow/off mode, Jev-mapped in active mode). With no
 * TYPESAFE_API_KEY (or OMC_JEV not naming this point) the resolver
 * short-circuits: zero HTTP calls, no logging, same detection. Jev errors
 * degrade inside the resolver and fall back to the twin.
 */
export function recordLearnerExtractionShadow(assistantMessage, userMessage, fetchFn) {
    return recordJudgment('learner-extraction', {
        state: {
            assistant_message: assistantMessage,
            user_message: userMessage ?? null,
            source: 'learner-detection',
        },
        twin: () => detectExtractableMoment(assistantMessage, userMessage),
        mapAnswer: (answer) => {
            // Jev Noul answer has { type: 'noul', noul: boolean | undefined }
            return {
                detected: answer.noul === true,
                confidence: (answer.confidence ?? 0.5) * 100, // Scale to 0-100
                patternType: 'technique',
                suggestedTriggers: [],
                reason: 'Jev active-mode detection',
            };
        },
        fetchFn,
    });
}
//# sourceMappingURL=jev-shadow.js.map