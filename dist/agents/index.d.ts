/**
 * Agents Module Exports
 *
 * New modular agent system with individual files and metadata.
 * Maintains backward compatibility with definitions.ts exports.
 */
export * from './types.js';
export { createAgentToolRestrictions, mergeAgentConfig, buildDelegationTable, buildUseAvoidSection, createEnvContext, getAvailableAgents, buildKeyTriggersSection, validateAgentConfig, deepMerge, loadAgentPrompt } from './utils.js';
export { architectAgent, ARCHITECT_PROMPT_METADATA } from './architect.js';
export { exploreAgent, EXPLORE_PROMPT_METADATA } from './explore.js';
export { executorAgent, SISYPHUS_JUNIOR_PROMPT_METADATA } from './executor.js';
export { designerAgent, FRONTEND_ENGINEER_PROMPT_METADATA } from './designer.js';
export { writerAgent, DOCUMENT_WRITER_PROMPT_METADATA } from './writer.js';
export { visionAgent, MULTIMODAL_LOOKER_PROMPT_METADATA } from './vision.js';
export { criticAgent, CRITIC_PROMPT_METADATA } from './critic.js';
export { analystAgent, ANALYST_PROMPT_METADATA } from './analyst.js';
export { plannerAgent, PLANNER_PROMPT_METADATA } from './planner.js';
export { qaTesterAgent, QA_TESTER_PROMPT_METADATA } from './qa-tester.js';
export { scientistAgent, SCIENTIST_PROMPT_METADATA } from './scientist.js';
export { deepExecutorAgent, DEEP_EXECUTOR_PROMPT_METADATA } from './deep-executor.js';
/** @deprecated Use dependency-expert agent instead */
export { researcherAgent, RESEARCHER_PROMPT_METADATA } from './researcher.js';
export { debuggerAgent, verifierAgent } from './definitions.js';
export { styleReviewerAgent, qualityReviewerAgent, apiReviewerAgent, performanceReviewerAgent } from './definitions.js';
export { dependencyExpertAgent, testEngineerAgent, qualityStrategistAgent } from './definitions.js';
export { productManagerAgent, uxResearcherAgent, informationArchitectAgent, productAnalystAgent } from './definitions.js';
export { securityReviewerAgent, buildFixerAgent, codeReviewerAgent, gitMasterAgent } from './definitions.js';
export { getAgentDefinitions, omcSystemPrompt } from './definitions.js';
export { coordinatorAgent, ORCHESTRATOR_SISYPHUS_PROMPT_METADATA } from './coordinator-deprecated.js';
//# sourceMappingURL=index.d.ts.map