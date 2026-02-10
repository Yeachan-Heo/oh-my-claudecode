/**
 * Autopilot Hook Module
 *
 * Main entry point for the /autopilot command - autonomous execution
 * from idea to working code.
 */
export { DEFAULT_CONFIG } from './types.js';
// State management & phase transitions
export { readAutopilotState, writeAutopilotState, clearAutopilotState, isAutopilotActive, initAutopilot, transitionPhase, incrementAgentCount, updateExpansion, updatePlanning, updateExecution, updateQA, updateValidation, ensureAutopilotDir, getSpecPath, getPlanPath, transitionRalphToUltraQA, transitionUltraQAToValidation, transitionToComplete, transitionToFailed, getTransitionPrompt } from './state.js';
// Prompt generation
export { getExpansionPrompt, getDirectPlanningPrompt, getExecutionPrompt, getQAPrompt, getValidationPrompt, getPhasePrompt } from './prompts.js';
// Validation coordination & summary generation
export { recordValidationVerdict, getValidationStatus, startValidationRound, shouldRetryValidation, getIssuesToFix, getValidationSpawnPrompt, formatValidationResults, generateSummary, formatSummary, formatCompactSummary, formatFailureSummary, formatFileList } from './validation.js';
// Cancellation
export { cancelAutopilot, clearAutopilot, canResumeAutopilot, resumeAutopilot, formatCancelMessage } from './cancel.js';
// Signal detection & enforcement
export { detectSignal, getExpectedSignalForPhase, detectAnySignal, checkAutopilot } from './enforcement.js';
//# sourceMappingURL=index.js.map