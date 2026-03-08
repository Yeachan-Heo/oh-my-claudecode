/**
 * Document Specialist Agent - Documentation and External Reference Finder
 *
 * Searches external resources: official docs, GitHub, Stack Overflow.
 * For internal codebase searches, use explore agent instead.
 *
 * Ported from oh-my-opencode's document specialist agent.
 */
import { loadAgentPrompt } from './utils.js';
export const DOCUMENT_SPECIALIST_PROMPT_METADATA = {
    category: 'exploration',
    cost: 'CHEAP',
    promptAlias: 'document-specialist',
    triggers: [
        { domain: 'External documentation', trigger: 'API references, official docs' },
        { domain: 'OSS implementations', trigger: 'GitHub examples, package source' },
        { domain: 'Best practices', trigger: 'Community patterns, recommendations' },
        { domain: 'Literature and reference research', trigger: 'Academic papers, manuals, reference databases' },
    ],
    useWhen: [
        'Looking up official documentation',
        'Finding GitHub examples',
        'Researching npm/pip packages',
        'Stack Overflow solutions',
        'External API references',
        'Searching external literature or academic papers',
        'Looking up manuals, databases, or reference material outside the current project',
    ],
    avoidWhen: [
        'Internal codebase search (use explore)',
        'Current project files (use explore)',
        'When you already have the information',
    ],
};
export const documentSpecialistAgent = {
    name: 'document-specialist',
    description: 'Document Specialist for documentation research and external reference finding. Use for official docs, GitHub examples, OSS implementations, API references, external literature, academic papers, and reference/database lookups. Searches EXTERNAL resources, not internal codebase.',
    prompt: loadAgentPrompt('document-specialist'),
    model: 'sonnet',
    defaultModel: 'sonnet',
    metadata: DOCUMENT_SPECIALIST_PROMPT_METADATA
};
//# sourceMappingURL=document-specialist.js.map