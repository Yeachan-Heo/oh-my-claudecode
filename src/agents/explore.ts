/**
 * Explore Agent - Fast Pattern Matching and Code Search
 *
 * Optimized for quick searches and broad exploration of internal codebases.
 * Uses parallel search strategies for maximum speed.
 *
 * Ported from oh-my-opencode's explore agent.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const EXPLORE_PROMPT_METADATA: AgentPromptMetadata = {
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
    'External documentation, literature, or academic paper lookup (use document-specialist)',
    'Database/reference/manual lookups outside the current project (use document-specialist)',
    'GitHub/npm package research (use document-specialist)',
    'Complex architectural analysis (use architect)',
    'When you already know the file location',
  ],
};

export const exploreAgent: AgentConfig = {
  name: 'explore',
  description: 'Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase only; external docs, literature, papers, and reference databases belong to document-specialist.',
  prompt: loadAgentPrompt('explore'),
  model: 'haiku',
  defaultModel: 'haiku',
  metadata: EXPLORE_PROMPT_METADATA
};
