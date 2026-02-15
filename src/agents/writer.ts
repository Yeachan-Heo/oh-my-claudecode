/**
 * Document Writer Agent
 *
 * Technical writer who crafts clear, comprehensive documentation.
 *
 * Ported from oh-my-opencode's agent definitions.
 */

import type { AgentPromptMetadata } from './types.js';
import { defineAgent } from './utils.js';

export const DOCUMENT_WRITER_PROMPT_METADATA: AgentPromptMetadata = {
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

export const writerAgent = defineAgent({
  name: 'writer',
  description: `Technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides.`,
  model: 'haiku',
  metadata: DOCUMENT_WRITER_PROMPT_METADATA,
});
