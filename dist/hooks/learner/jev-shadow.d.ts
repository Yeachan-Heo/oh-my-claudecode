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
import { type DetectionResult } from './detector.js';
import type { ResolveResult } from '../jev/index.js';
/**
 * Record the shadow comparison for one assistant message and return the
 * twin detection unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not
 * naming this point) the resolver short-circuits: zero HTTP calls, no
 * logging, same detection.
 */
export declare function recordLearnerExtractionShadow(assistantMessage: string, userMessage?: string, fetchFn?: typeof fetch): Promise<ResolveResult<DetectionResult>>;
//# sourceMappingURL=jev-shadow.d.ts.map