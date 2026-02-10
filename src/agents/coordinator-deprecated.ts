/**
 * Coordinator Agent - DEPRECATED
 *
 * This file provides deprecated stubs for backward compatibility.
 * The coordinator agent was never registered in the runtime agent registry.
 *
 * @deprecated Will be removed in v4.0.0
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';

// Only emit deprecation warning when verbose mode is enabled
// This prevents noise in normal CLI usage while still informing developers during debugging
const isVerbose = process.env.VERBOSE === '1' || process.env.DEBUG === '1' || process.argv.includes('--verbose');
if (isVerbose) {
  console.warn(
    '[oh-my-claudecode] coordinatorAgent and ORCHESTRATOR_SISYPHUS_PROMPT_METADATA are deprecated ' +
    'and will be removed in v4.0.0. The coordinator agent was never registered in the runtime agent registry.'
  );
}

/**
 * @deprecated Will be removed in v4.0.0. The coordinator was never a runtime agent.
 */
export const ORCHESTRATOR_SISYPHUS_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'orchestration',
  cost: 'CHEAP',
  promptAlias: 'coordinator',
  triggers: [],
  useWhen: [],
  avoidWhen: [],
};

/**
 * @deprecated Will be removed in v4.0.0. The coordinator was never a runtime agent.
 */
export const coordinatorAgent: AgentConfig = {
  name: 'coordinator',
  description: 'DEPRECATED: The coordinator agent was removed. This stub exists for backward compatibility.',
  prompt: '',
  tools: [],
  model: 'opus',
  metadata: ORCHESTRATOR_SISYPHUS_PROMPT_METADATA,
};
