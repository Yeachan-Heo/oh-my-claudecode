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
  deepMerge,
  loadAgentPrompt,
  formatOpenQuestions,
  OPEN_QUESTIONS_PATH
} from './utils.js';

// Individual agent exports
export { architectAgent, ARCHITECT_PROMPT_METADATA } from './architect.js';
export { exploreAgent, EXPLORE_PROMPT_METADATA } from './explore.js';
export { executorAgent, EXECUTOR_PROMPT_METADATA } from './executor.js';
export { designerAgent, FRONTEND_ENGINEER_PROMPT_METADATA } from './designer.js';
export { writerAgent, DOCUMENT_WRITER_PROMPT_METADATA } from './writer.js';
export { criticAgent, CRITIC_PROMPT_METADATA } from './critic.js';
export { analystAgent, ANALYST_PROMPT_METADATA } from './analyst.js';
export { plannerAgent, PLANNER_PROMPT_METADATA } from './planner.js';
export { qaTesterAgent, QA_TESTER_PROMPT_METADATA } from './qa-tester.js';
export { scientistAgent, SCIENTIST_PROMPT_METADATA } from './scientist.js';
// Backward compatibility: Deprecated researcher export
/** @deprecated Use document-specialist agent instead */
export { documentSpecialistAgent, DOCUMENT_SPECIALIST_PROMPT_METADATA } from './document-specialist.js';
/** @deprecated Use document-specialist agent instead */
export { documentSpecialistAgent as researcherAgent } from './document-specialist.js';

// Reformed agents (Build/Analysis Lane)
export {
  deepExecutorAgent,
  debuggerAgent,
  verifierAgent
} from './definitions.js';

// Reformed agents (Review Lane)
export {
  qualityReviewerAgent
} from './definitions.js';

// Reformed agents (Domain Specialists)
export {
  testEngineerAgent
} from './definitions.js';

// Specialized agents (Security, Build, Code Review, Git, Code Simplifier)
export {
  securityReviewerAgent,
  buildFixerAgent,
  codeReviewerAgent,
  gitMasterAgent,
  codeSimplifierAgent
} from './definitions.js';

// Core exports (getAgentDefinitions and omcSystemPrompt)
export {
  getAgentDefinitions,
  omcSystemPrompt
} from './definitions.js';

