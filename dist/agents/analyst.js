/**
 * Analyst Agent
 *
 * Pre-planning consultant for identifying hidden requirements.
 *
 * Ported from oh-my-opencode's agent definitions.
 */
import { loadAgentPrompt } from './utils.js';
export const ANALYST_PROMPT_METADATA = {
    category: 'planner',
    cost: 'EXPENSIVE',
    promptAlias: 'analyst',
    triggers: [
        {
            domain: 'Pre-Planning',
            trigger: 'Hidden requirements, edge cases, risk analysis',
        },
    ],
    useWhen: [
        'Before creating a work plan',
        'When requirements seem incomplete',
        'To identify hidden assumptions',
        'Risk analysis before implementation',
        'Scope validation',
    ],
    avoidWhen: [
        'Simple, well-defined tasks',
        'During implementation phase',
        'When plan already reviewed',
    ],
};
export const analystAgent = {
    name: 'analyst',
    description: `Pre-planning consultant that analyzes requests before implementation to identify hidden requirements, edge cases, and potential risks. Use before creating a work plan.`,
    prompt: loadAgentPrompt('analyst'),
    model: 'opus',
    defaultModel: 'opus',
    metadata: ANALYST_PROMPT_METADATA,
};
//# sourceMappingURL=analyst.js.map