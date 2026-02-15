/**
 * Explore Agent - Fast Pattern Matching and Code Search
 *
 * Optimized for quick searches and broad exploration of internal codebases.
 * Uses parallel search strategies for maximum speed.
 *
 * Ported from oh-my-opencode's explore agent.
 */
import { defineAgent } from './utils.js';
export const EXPLORE_PROMPT_METADATA = {
    category: 'exploration',
    cost: 'CHEAP',
    promptAlias: 'Explore',
    triggers: [
        { domain: 'Internal codebase search', trigger: 'Finding implementations, patterns, files' },
        { domain: 'Project structure', trigger: 'Understanding code organization' },
        { domain: 'Code discovery', trigger: 'Locating specific code by pattern' },
    ],
    useWhen: [
        'Finding files by pattern or name',
        'Searching for implementations in current project',
        'Understanding project structure',
        'Locating code by content or pattern',
        'Quick codebase exploration',
    ],
    avoidWhen: [
        'External documentation lookup (use document-specialist)',
        'GitHub/npm package research (use document-specialist)',
        'Complex architectural analysis (use architect)',
        'When you already know the file location',
    ],
};
export const exploreAgent = defineAgent({
    name: 'explore',
    description: 'Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase.',
    model: 'haiku',
    metadata: EXPLORE_PROMPT_METADATA,
});
//# sourceMappingURL=explore.js.map