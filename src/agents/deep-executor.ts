/**
 * Deep Executor Agent - Autonomous Deep Worker
 *
 * Ported from oh-my-opencode's Hephaestus agent (PR #1287).
 * Inspired by AmpCode's deep mode - goal-oriented autonomous execution with explore-first behavior.
 *
 * Key behaviors:
 * - Explore-first: Uses own tools extensively before acting
 * - Self-execution: Does all work itself (no delegation)
 * - 100% completion guarantee with verification evidence
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const DEEP_EXECUTOR_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'EXPENSIVE',
  promptAlias: 'Deep Executor',
  triggers: [
    { domain: 'Complex tasks', trigger: 'Multi-file changes, unclear scope, needs exploration' },
    { domain: 'Deep work', trigger: 'Goal-oriented tasks requiring sustained focus' },
    { domain: 'Forge', trigger: 'Complex implementation needing deep reasoning' },
  ],
  useWhen: [
    'Complex multi-file tasks requiring thorough exploration first',
    'Goal-oriented work with unclear implementation path',
    'Tasks needing deep reasoning and 100% completion guarantee',
    'Work where executor-high is not enough reasoning power',
  ],
  avoidWhen: [
    'Simple single-file changes (use executor)',
    'Quick lookups (use explore)',
    'When explicit step-by-step guidance is provided',
    'Cost-sensitive operations (use executor tiers instead)',
    'Tasks requiring delegation to sub-agents (use orchestrator)',
  ],
  promptDescription: 'Deep executor for complex goal-oriented tasks. Explores extensively before acting, executes all work itself, and guarantees completion with evidence.',
};

export const deepExecutorAgent: AgentConfig = {
  name: 'deep-executor',
  description: 'Deep executor for complex goal-oriented tasks. Explores extensively, executes all work itself, guarantees 100% completion with evidence.',
  prompt: loadAgentPrompt('deep-executor'),
  model: 'opus',
  defaultModel: 'opus',
  metadata: DEEP_EXECUTOR_PROMPT_METADATA
};
