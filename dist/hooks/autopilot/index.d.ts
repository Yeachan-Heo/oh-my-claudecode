/**
 * Autopilot Hook Module
 *
 * Main entry point for the /autopilot command - autonomous execution
 * from idea to working code.
 */
export type { AutopilotPhase, AutopilotState, AutopilotConfig, AutopilotResult, AutopilotSummary, AutopilotExpansion, AutopilotPlanning, AutopilotExecution, AutopilotQA, AutopilotValidation, ValidationResult, ValidationVerdictType, ValidationVerdict, QAStatus, AutopilotSignal } from './types.js';
export { DEFAULT_CONFIG } from './types.js';
export { readAutopilotState, writeAutopilotState, clearAutopilotState, isAutopilotActive, getAutopilotStateAge, initAutopilot, transitionPhase, incrementAgentCount, updateExpansion, updatePlanning, updateExecution, updateQA, updateValidation, ensureAutopilotDir, getSpecPath, getPlanPath, transitionRalphToUltraQA, transitionUltraQAToValidation, transitionToComplete, transitionToFailed, getTransitionPrompt, type TransitionResult } from './state.js';
export { getExpansionPrompt, getDirectPlanningPrompt, getExecutionPrompt, getQAPrompt, getValidationPrompt, getPhasePrompt } from './prompts.js';
export { recordValidationVerdict, getValidationStatus, startValidationRound, shouldRetryValidation, getIssuesToFix, getValidationSpawnPrompt, formatValidationResults, generateSummary, formatSummary, formatCompactSummary, formatFailureSummary, formatFileList, type ValidationCoordinatorResult } from './validation.js';
export { cancelAutopilot, clearAutopilot, canResumeAutopilot, resumeAutopilot, formatCancelMessage, STALE_STATE_MAX_AGE_MS, type CancelResult } from './cancel.js';
export { detectSignal, getExpectedSignalForPhase, detectAnySignal, checkAutopilot, type AutopilotEnforcementResult } from './enforcement.js';
export type { PipelineStageId, PipelineTerminalState, PipelinePhase, StageStatus, ExecutionBackend, VerificationConfig, PipelineConfig, PipelineContext, PipelineStageAdapter, PipelineStageState, PipelineTracking, } from './pipeline-types.js';
export { DEFAULT_PIPELINE_CONFIG, STAGE_ORDER, DEPRECATED_MODE_ALIASES, } from './pipeline-types.js';
export { resolvePipelineConfig, getDeprecationWarning, buildPipelineTracking, getActiveAdapters, readPipelineTracking, writePipelineTracking, initPipeline, getCurrentStageAdapter, getNextStageAdapter, advanceStage, failCurrentStage, incrementStageIteration, getCurrentCompletionSignal, getSignalToStageMap, generatePipelinePrompt, generateTransitionPrompt, getPipelineStatus, formatPipelineHUD, hasPipelineTracking, } from './pipeline.js';
export { ALL_ADAPTERS, getAdapterById, ralplanAdapter, executionAdapter, ralphAdapter, qaAdapter, RALPLAN_COMPLETION_SIGNAL, EXECUTION_COMPLETION_SIGNAL, RALPH_COMPLETION_SIGNAL, QA_COMPLETION_SIGNAL, } from './adapters/index.js';
//# sourceMappingURL=index.d.ts.map