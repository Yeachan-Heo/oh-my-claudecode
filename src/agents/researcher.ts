/**
 * Researcher Agent - Documentation and External Reference Finder
 *
 * Searches external resources: official docs, GitHub, Stack Overflow.
 * For internal codebase searches, use explore agent instead.
 *
 * Ported from oh-my-opencode's researcher agent.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const RESEARCHER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'exploration',
  cost: 'CHEAP',
  promptAlias: 'researcher',
  triggers: [
    { domain: 'External documentation', trigger: 'API references, official docs' },
    { domain: 'OSS implementations', trigger: 'GitHub examples, package source' },
    { domain: 'Best practices', trigger: 'Community patterns, recommendations' },
  ],
  useWhen: [
    'Looking up official documentation',
    'Finding GitHub examples',
    'Researching npm/pip packages',
    'Stack Overflow solutions',
    'External API references',
  ],
  avoidWhen: [
    'Internal codebase search (use explore)',
    'Current project files (use explore)',
    'When you already have the information',
  ],
};


export const researcherAgent: AgentConfig = {
  name: 'researcher',
  description: 'Documentation researcher and external reference finder. Use for official docs, GitHub examples, OSS implementations, API references. Searches EXTERNAL resources, not internal codebase.',
  prompt: loadAgentPrompt('researcher'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: RESEARCHER_PROMPT_METADATA
};
