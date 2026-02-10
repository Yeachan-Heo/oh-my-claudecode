/**
 * Frontend Engineer Agent
 *
 * Designer-turned-developer who crafts stunning UI/UX.
 *
 * Ported from oh-my-opencode's agent definitions.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const FRONTEND_ENGINEER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'CHEAP',
  promptAlias: 'designer',
  triggers: [
    {
      domain: 'UI/UX',
      trigger: 'Visual changes, styling, components, accessibility',
    },
    {
      domain: 'Design',
      trigger: 'Layout, animations, responsive design',
    },
  ],
  useWhen: [
    'Visual styling or layout changes',
    'Component design or refactoring',
    'Animation implementation',
    'Accessibility improvements',
    'Responsive design work',
  ],
  avoidWhen: [
    'Pure logic changes in frontend files',
    'Backend/API work',
    'Non-visual refactoring',
  ],
};

export const designerAgent: AgentConfig = {
  name: 'designer',
  description: `Designer-turned-developer who crafts stunning UI/UX even without design mockups. Use for VISUAL changes only (styling, layout, animation). Pure logic changes in frontend files should be handled directly.`,
  prompt: loadAgentPrompt('designer'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: FRONTEND_ENGINEER_PROMPT_METADATA,
};
