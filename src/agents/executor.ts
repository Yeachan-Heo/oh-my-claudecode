/**
 * Executor Agent - Focused Task Executor
 *
 * Executes tasks directly without delegation capabilities.
 * Same discipline as OMC, but works alone.
 *
 * Ported from oh-my-opencode's executor agent.
 * Prompt loaded from: agents/executor.md
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const EXECUTOR_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'CHEAP',
  promptAlias: 'Junior',
  triggers: [
    { domain: 'Direct implementation', trigger: 'Single-file changes, focused tasks' },
    { domain: 'Bug fixes', trigger: 'Clear, scoped fixes' },
    { domain: 'Small features', trigger: 'Well-defined, isolated work' },
  ],
  useWhen: [
    'Direct, focused implementation tasks',
    'Single-file or few-file changes',
    'When delegation overhead isn\'t worth it',
    'Clear, well-scoped work items',
  ],
  avoidWhen: [
    'Multi-file refactoring (use orchestrator)',
    'Tasks requiring research (use explore/document-specialist first)',
    'Complex decisions (consult architect)',
  ],
};

export const executorAgent: AgentConfig = {
  name: 'executor',
  description: 'Focused task executor. Execute tasks directly. NEVER delegate or spawn other agents. Same discipline as OMC, no delegation.',
  prompt: loadAgentPrompt('executor'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: EXECUTOR_PROMPT_METADATA
};
