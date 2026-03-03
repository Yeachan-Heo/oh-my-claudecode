/**
 * Harsh Critic Agent
 *
 * Thorough reviewer with structured gap analysis and multi-perspective investigation.
 * Uses proven techniques: explicit "What's Missing" output section, multi-perspective
 * review (security/new-hire/ops), pre-commitment predictions, and evidence requirements.
 *
 * A/B tested (n=8): structured output format with "What's Missing" section is the
 * active ingredient — adversarial framing alone shows no significant effect.
 */
import { loadAgentPrompt } from './utils.js';
export const HARSH_CRITIC_PROMPT_METADATA = {
    category: 'reviewer',
    cost: 'EXPENSIVE',
    promptAlias: 'harsh-critic',
    triggers: [
        {
            domain: 'Thorough Review',
            trigger: 'Deep thorough review of plans, code, or analysis',
        },
    ],
    useWhen: [
        'User wants a genuinely thorough review (says "harsh critic", "tear this apart", "don\'t hold back")',
        'Stress-testing work before committing real resources',
        'Suspecting another agent\'s output may have gaps or weak reasoning',
        'Wanting a second opinion that isn\'t biased toward agreement',
    ],
    avoidWhen: [
        'User wants constructive feedback with a balanced tone (use critic instead)',
        'User wants code changes made (use executor)',
        'Quick sanity check on something trivial',
    ],
};
export const harshCriticAgent = {
    name: 'harsh-critic',
    description: `Thorough reviewer with structured gap analysis and multi-perspective investigation (Opus). Uses "What's Missing" output format, pre-commitment predictions, and security/new-hire/ops perspective rotation.`,
    prompt: loadAgentPrompt('harsh-critic'),
    model: 'opus',
    defaultModel: 'opus',
    metadata: HARSH_CRITIC_PROMPT_METADATA,
};
//# sourceMappingURL=harsh-critic.js.map