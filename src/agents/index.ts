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

// Individual agent exports (new modular structure)
export { oracleAgent, ORACLE_PROMPT_METADATA } from './oracle.js';
export { exploreAgent, EXPLORE_PROMPT_METADATA } from './explore.js';
export { librarianAgent, LIBRARIAN_PROMPT_METADATA } from './librarian.js';
export { sisyphusJuniorAgent, SISYPHUS_JUNIOR_PROMPT_METADATA } from './sisyphus-junior.js';
export { frontendEngineerAgent, FRONTEND_ENGINEER_PROMPT_METADATA } from './frontend-engineer.js';
export { documentWriterAgent, DOCUMENT_WRITER_PROMPT_METADATA } from './document-writer.js';
export { multimodalLookerAgent, MULTIMODAL_LOOKER_PROMPT_METADATA } from './multimodal-looker.js';
export { momusAgent, MOMUS_PROMPT_METADATA } from './momus.js';
export { metisAgent, METIS_PROMPT_METADATA } from './metis.js';
export { orchestratorSisyphusAgent, ORCHESTRATOR_SISYPHUS_PROMPT_METADATA } from './orchestrator-sisyphus.js';
export { prometheusAgent, PROMETHEUS_PROMPT_METADATA } from './prometheus.js';
export { qaTesterAgent, QA_TESTER_PROMPT_METADATA } from './qa-tester.js';

// Legacy exports (backward compatibility - getAgentDefinitions and sisyphusSystemPrompt)
export {
  getAgentDefinitions,
  sisyphusSystemPrompt
} from './definitions.js';
