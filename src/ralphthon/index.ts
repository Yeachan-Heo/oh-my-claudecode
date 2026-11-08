/**
 * Ralphthon Module
 *
 * Autonomous hackathon lifecycle: deep-interview -> PRD -> ralph execution ->
 * auto-hardening -> termination after clean waves.
 */

// Types
export type {
  TaskPriority,
  TaskStatus,
  RalphthonPhase,
  RalphthonTask,
  RalphthonStory,
  HardeningTask,
  RalphthonConfig,
  RalphthonPlanningContext,
  RalphthonPRD,
  RalphthonState,
  OrchestratorEvent,
  OrchestratorEventHandler,
  RalphthonCliOptions,
} from "./types.js";

export { RALPHTHON_DEFAULTS, PRD_FILENAME } from "./types.js";

// PRD operations
export {
  getRalphthonPrdPath,
  findRalphthonPrdPath,
  readRalphthonPrd,
  writeRalphthonPrd,
  getRalphthonPrdStatus,
  updateTaskStatus,
  incrementTaskRetry,
  updateHardeningTaskStatus,
  incrementHardeningTaskRetry,
  addHardeningTasks,
  createRalphthonPrd,
  initRalphthonPrd,
  normalizePlanningContext,
  DEFAULT_PLANNING_CONTEXT,
  formatTaskPrompt,
  formatHardeningTaskPrompt,
  formatHardeningGenerationPrompt,
  formatRalphthonStatus,
} from "./prd.js";

export type { RalphthonPrdStatus } from "./prd.js";

// Deep interview handoff
export { buildRalphthonDeepInterviewPrompt } from './deep-interview-prompt.js';

// Orchestrator
export {
  readRalphthonState,
  writeRalphthonState,
  clearRalphthonState,
  isPaneIdle,
  paneExists,
  sendKeysToPane,
  capturePaneContent,
  detectLeaderIdle,
  detectCompletionSignal,
  initOrchestrator,
  getNextAction,
  transitionPhase,
  startHardeningWave,
  endHardeningWave,
  recordTaskCompletion,
  recordTaskSkip,
  orchestratorTick,
  startOrchestratorLoop,
} from "./orchestrator.js";
