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
import { getAllKeywords, } from './index.js';
import { recordJudgment } from '../jev/index.js';
/**
 * Point "skill-trigger" (ticket 04): the keyword list decides in shadow/off
 * mode; Jev's Choice over the triggerable skills/modes is recorded per
 * prompt. In active mode, Jev's answer is mapped to a keyword list.
 */
export function recordSkillTriggerShadow(prompt, fetchFn) {
    return recordJudgment('skill-trigger', {
        state: { prompt, source: 'user-prompt-submit' },
        twin: () => getAllKeywords(prompt),
        mapAnswer: (answer) => {
            // Jev Choice answer has { type: 'choice', choice: <keyword> | 'none' }
            const choice = answer.choice?.toLowerCase();
            if (choice === 'none' || !choice)
                return [];
            // Return the chosen keyword as a single-element array
            return [choice];
        },
        fetchFn,
    });
}
/**
 * Explicit slash invocation of the intent skill. Mirrors the detector's
 * WORKFLOW_SLASH_PATTERN shape for a skill outside
 * CANONICAL_WORKFLOW_SLASH_SKILLS: skills/intent/SKILL.md frontmatter sets
 * skills/intent/SKILL.md frontmatter sets disable-model-invocation, so an
 * explicit `/intent` (optionally namespaced) is the only trigger surface.
 */
const INTENT_SLASH_PATTERN = /^\s*\/(?:oh-my-claudecode:|omc:)?intent(?=\s|$|[?!.,;:])/i;
/**
 * Point "intent" (ticket 02): the detector's existing trigger answer decides
 * in shadow/off mode; Jev's Noul judgment is recorded per prompt. In active
 * mode, Jev's answer is used to decide whether this is an intent request.
 */
export function recordIntentShadow(prompt, fetchFn) {
    return recordJudgment('intent', {
        state: { prompt, mode_name: 'intent' },
        twin: () => INTENT_SLASH_PATTERN.test(prompt),
        mapAnswer: (answer) => {
            // Jev Noul answer has { type: 'noul', noul: boolean | undefined }
            return answer.noul === true;
        },
        fetchFn,
    });
}
//# sourceMappingURL=jev-shadow.js.map