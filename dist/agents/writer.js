/**
 * Document Writer Agent
 *
 * Technical writer who crafts clear, comprehensive documentation.
 *
 * Ported from oh-my-opencode's agent definitions.
 */
import { loadAgentPrompt } from './utils.js';
export const DOCUMENT_WRITER_PROMPT_METADATA = {
    category: 'specialist',
    cost: 'FREE',
    promptAlias: 'writer',
    triggers: [
        {
            domain: 'Documentation',
            trigger: 'README, API docs, guides, comments',
        },
    ],
    useWhen: [
        'Creating or updating README files',
        'Writing API documentation',
        'Creating user guides or tutorials',
        'Adding code comments or JSDoc',
        'Architecture documentation',
    ],
    avoidWhen: [
        'Code implementation tasks',
        'Bug fixes',
        'Non-documentation tasks',
    ],
};
export const writerAgent = {
    name: 'writer',
    description: `Technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides.`,
    prompt: loadAgentPrompt('writer'),
    model: 'haiku',
    defaultModel: 'haiku',
    metadata: DOCUMENT_WRITER_PROMPT_METADATA,
};
//# sourceMappingURL=writer.js.map