/**
 * Planner Agent
 *
 * Strategic planning consultant.
 *
 * Ported from oh-my-opencode's agent definitions.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const PLANNER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'planner',
  cost: 'EXPENSIVE',
  promptAlias: 'planner',
  triggers: [
    {
      domain: 'Strategic Planning',
      trigger: 'Comprehensive work plans, interview-style consultation',
    },
  ],
  useWhen: [
    'Complex features requiring planning',
    'When requirements need clarification through interview',
    'Creating comprehensive work plans',
    'Before large implementation efforts',
  ],
  avoidWhen: [
    'Simple, straightforward tasks',
    'When implementation should just start',
    'When a plan already exists',
  ],
};

export const plannerAgent: AgentConfig = {
  name: 'planner',
  description: `Strategic planning consultant. Interviews users to understand requirements, then creates comprehensive work plans. NEVER implements - only plans.`,
  prompt: loadAgentPrompt('planner'),
  model: 'opus',
  defaultModel: 'opus',
  metadata: PLANNER_PROMPT_METADATA,
};
