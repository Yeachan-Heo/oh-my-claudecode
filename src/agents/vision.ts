/**
 * Multimodal Looker Agent
 *
 * Visual content analysis specialist.
 *
 * Ported from oh-my-opencode's agent definitions.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const MULTIMODAL_LOOKER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'CHEAP',
  promptAlias: 'vision',
  triggers: [
    {
      domain: 'Visual Analysis',
      trigger: 'Screenshots, images, diagrams, PDFs',
    },
  ],
  useWhen: [
    'Analyzing screenshots or mockups',
    'Extracting data from images',
    'Understanding diagrams or flowcharts',
    'Processing PDF documents',
    'Describing visual content',
  ],
  avoidWhen: [
    'Plain text or code files',
    'Files that need editing afterward',
    'Simple file reading tasks',
  ],
};

export const visionAgent: AgentConfig = {
  name: 'vision',
  description: `Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text. Extracts specific information or summaries from documents, describes visual content.`,
  prompt: loadAgentPrompt('vision'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: MULTIMODAL_LOOKER_PROMPT_METADATA,
};
