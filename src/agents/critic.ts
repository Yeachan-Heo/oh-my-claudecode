/**
 * Critic Agent
 *
 * Expert plan reviewer with ruthless evaluation standards.
 *
 * Ported from oh-my-opencode's agent definitions.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const CRITIC_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'reviewer',
  cost: 'EXPENSIVE',
  promptAlias: 'critic',
  triggers: [
    {
      domain: 'Plan Review',
      trigger: 'Evaluating work plans before execution',
    },
  ],
  useWhen: [
    'After planner creates a work plan',
    'Before executing a complex plan',
    'When plan quality validation is needed',
    'To catch gaps before implementation',
  ],
  avoidWhen: [
    'Simple, straightforward tasks',
    'When no plan exists to review',
    'During implementation phase',
  ],
};

export const criticAgent: AgentConfig = {
  name: 'critic',
  description: `Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards. Use after planner creates a work plan to validate it before execution.`,
  prompt: loadAgentPrompt('critic'),
  model: 'opus',
  defaultModel: 'opus',
  metadata: CRITIC_PROMPT_METADATA,
};
