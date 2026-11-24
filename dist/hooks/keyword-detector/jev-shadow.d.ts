/**
 * Shadow judgment points wired to the keyword detector (issue #3669,
 * tickets 02 + 04).
 *
 * The point declarations (questions, blocking flag) live in the jev registry
 * (hooks/jev/points.ts); this module keeps only the twin heuristics and the
 * call-specific state construction. Both points are detector-type
 * (blocking:false): the detector's existing computation is the heuristic twin
 * and always decides; Jev's answer is only recorded for later comparison.
 * resolveJudgment never rejects on the Jev path, so callers fire these
 * without awaiting them — prompt submission latency is unchanged. With
 * TYPESAFE_API_KEY unset the resolver short-circuits to the twin with zero
 * HTTP calls.
 */
import { type KeywordType } from './index.js';
import type { ResolveResult } from '../jev/index.js';
/**
 * Point "skill-trigger" (ticket 04): the keyword list decides in shadow/off
 * mode; Jev's Choice over the triggerable skills/modes is recorded per
 * prompt. In active mode, Jev's answer is mapped to a keyword list.
 */
export declare function recordSkillTriggerShadow(prompt: string, fetchFn?: typeof fetch): Promise<ResolveResult<KeywordType[]>>;
/**
 * Point "intent" (ticket 02): the detector's existing trigger answer decides
 * in shadow/off mode; Jev's Noul judgment is recorded per prompt. In active
 * mode, Jev's answer is used to decide whether this is an intent request.
 */
export declare function recordIntentShadow(prompt: string, fetchFn?: typeof fetch): Promise<ResolveResult<boolean>>;
//# sourceMappingURL=jev-shadow.d.ts.map