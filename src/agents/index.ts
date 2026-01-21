/**
 * Agents Module Exports
 *
 * New modular agent system with individual files and metadata.
 * Maintains backward compatibility with definitions.ts exports.
 */

// Types
export * from './types.js';

// Utilities
export {
  createAgentToolRestrictions,
  mergeAgentConfig,
  buildDelegationTable,
  buildUseAvoidSection,
  createEnvContext,
  getAvailableAgents,
  buildKeyTriggersSection,
  validateAgentConfig,
  deepMerge
} from './utils.js';

// Individual agent exports (rebranded intuitive names)
export { architectAgent, ARCHITECT_PROMPT_METADATA } from './architect.js';
export { exploreAgent, EXPLORE_PROMPT_METADATA } from './explore.js';
export { researcherAgent, RESEARCHER_PROMPT_METADATA } from './researcher.js';
export { executorAgent, SISYPHUS_JUNIOR_PROMPT_METADATA } from './executor.js';
export { designerAgent, FRONTEND_ENGINEER_PROMPT_METADATA } from './designer.js';
export { writerAgent, DOCUMENT_WRITER_PROMPT_METADATA } from './writer.js';
export { visionAgent, MULTIMODAL_LOOKER_PROMPT_METADATA } from './vision.js';
export { criticAgent, CRITIC_PROMPT_METADATA } from './critic.js';
export { analystAgent, ANALYST_PROMPT_METADATA } from './analyst.js';
export { coordinatorAgent, ORCHESTRATOR_SISYPHUS_PROMPT_METADATA } from './coordinator.js';
export { plannerAgent, PLANNER_PROMPT_METADATA } from './planner.js';
export { qaTesterAgent, QA_TESTER_PROMPT_METADATA } from './qa-tester.js';
export { scientistAgent, SCIENTIST_PROMPT_METADATA } from './scientist.js';

// Tiered agent variants (prompts loaded dynamically from /agents/*.md)
export {
  architectMediumAgent,
  architectLowAgent,
  executorHighAgent,
  executorLowAgent,
  researcherLowAgent,
  exploreMediumAgent,
  designerLowAgent,
  designerHighAgent,
  qaTesterHighAgent,
  scientistLowAgent,
  scientistHighAgent
} from './definitions.js';

// Core exports (getAgentDefinitions and omcSystemPrompt)
export {
  getAgentDefinitions,
  omcSystemPrompt
} from './definitions.js';
