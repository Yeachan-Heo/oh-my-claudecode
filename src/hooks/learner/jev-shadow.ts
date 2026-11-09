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

import { detectExtractableMoment, type DetectionResult } from './detector.js';
import { noulAnswerIsYes, recordJudgment } from '../jev/index.js';
import type { JevAnswer, ResolveResult } from '../jev/index.js';

/**
 * Record the shadow comparison for one assistant message and return the
 * detection (twin in shadow/off mode, Jev-mapped in active mode). With no
 * TYPESAFE_API_KEY (or OMC_JEV not naming this point) the resolver
 * short-circuits: zero HTTP calls, no logging, same detection. Jev errors
 * degrade inside the resolver and fall back to the twin.
 */
export function recordLearnerExtractionShadow(
  assistantMessage: string,
  userMessage?: string,
  fetchFn?: typeof fetch,
): Promise<ResolveResult<DetectionResult>> {
  return recordJudgment<DetectionResult>('learner-extraction', {
    state: {
      assistant_message: assistantMessage,
      user_message: userMessage ?? null,
      source: 'learner-detection',
    },
    twin: () => detectExtractableMoment(assistantMessage, userMessage),
    mapHeuristic: (result, questionSet) => result.detected,
    mapAnswer: (answer: JevAnswer) => {
      // Jev Noul answer: noul is the probability of "yes" (0-1)
      return {
        detected: noulAnswerIsYes(answer),
        confidence: (answer.confidence ?? 0.5) * 100, // Scale to 0-100
        patternType: 'technique' as const,
        suggestedTriggers: [],
        reason: 'Jev active-mode detection',
      };
    },
    fetchFn,
  });
}
