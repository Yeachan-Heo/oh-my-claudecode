/**
 * Autopilot Hook Module
 *
 * Main entry point for the /autopilot command - autonomous execution
 * from idea to working code.
 */

// Types
export type {
  AutopilotPhase,
  AutopilotState,
  AutopilotConfig,
  AutopilotResult,
  AutopilotSummary,
  AutopilotExpansion,
  AutopilotPlanning,
  AutopilotExecution,
  AutopilotQA,
  AutopilotValidation,
  ValidationResult,
  ValidationVerdictType,
  ValidationVerdict,
  QAStatus,
  AutopilotSignal
} from './types.js';

export { DEFAULT_CONFIG } from './types.js';

// State management & phase transitions
export {
  readAutopilotState,
  writeAutopilotState,
  clearAutopilotState,
  isAutopilotActive,
  getAutopilotStateAge,
  initAutopilot,
  transitionPhase,
  incrementAgentCount,
  updateExpansion,
  updatePlanning,
  updateExecution,
  updateQA,
  updateValidation,
  ensureAutopilotDir,
  getSpecPath,
  getPlanPath,
  transitionRalphToUltraQA,
  transitionUltraQAToValidation,
  transitionToComplete,
  transitionToFailed,
  getTransitionPrompt,
  type TransitionResult
} from './state.js';

// Prompt generation
export {
  getExpansionPrompt,
  getDirectPlanningPrompt,
  getExecutionPrompt,
  getQAPrompt,
  getValidationPrompt,
  getPhasePrompt
} from './prompts.js';

// Validation coordination & summary generation
export {
  recordValidationVerdict,
  getValidationStatus,
  startValidationRound,
  shouldRetryValidation,
  getIssuesToFix,
  getValidationSpawnPrompt,
  formatValidationResults,
  generateSummary,
  formatSummary,
  formatCompactSummary,
  formatFailureSummary,
  formatFileList,
  type ValidationCoordinatorResult
} from './validation.js';

// Cancellation
export {
  cancelAutopilot,
  clearAutopilot,
  canResumeAutopilot,
  resumeAutopilot,
  formatCancelMessage,
  STALE_STATE_MAX_AGE_MS,
  type CancelResult
} from './cancel.js';

// Signal detection & enforcement
export {
  detectSignal,
  getExpectedSignalForPhase,
  detectAnySignal,
  checkAutopilot,
  type AutopilotEnforcementResult
} from './enforcement.js';

// Pipeline types
export type {
  PipelineStageId,
  PipelineTerminalState,
  PipelinePhase,
  StageStatus,
  ExecutionBackend,
  VerificationConfig,
  PipelineConfig,
  PipelineContext,
  PipelineStageAdapter,
  PipelineStageState,
  PipelineTracking,
} from './pipeline-types.js';

export {
  DEFAULT_PIPELINE_CONFIG,
  STAGE_ORDER,
  DEPRECATED_MODE_ALIASES,
} from './pipeline-types.js';

// Pipeline orchestrator
export {
  resolvePipelineConfig,
  getDeprecationWarning,
  buildPipelineTracking,
  getActiveAdapters,
  readPipelineTracking,
  writePipelineTracking,
  initPipeline,
  getCurrentStageAdapter,
  getNextStageAdapter,
  advanceStage,
  failCurrentStage,
  incrementStageIteration,
  getCurrentCompletionSignal,
  getSignalToStageMap,
  generatePipelinePrompt,
  generateTransitionPrompt,
  getPipelineStatus,
  formatPipelineHUD,
  hasPipelineTracking,
} from './pipeline.js';

// Stage adapters
export {
  ALL_ADAPTERS,
  getAdapterById,
  ralplanAdapter,
  executionAdapter,
  ralphAdapter,
  qaAdapter,
  RALPLAN_COMPLETION_SIGNAL,
  EXECUTION_COMPLETION_SIGNAL,
  RALPH_COMPLETION_SIGNAL,
  QA_COMPLETION_SIGNAL,
} from './adapters/index.js';
