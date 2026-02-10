/**
 * Autopilot State Management & Phase Transitions
 *
 * Handles:
 * - Persistent state for the autopilot workflow across phases
 * - Phase transitions, especially Ralph → UltraQA and UltraQA → Validation
 * - State machine operations
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { AutopilotState, AutopilotPhase, AutopilotConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import {
  readRalphState,
  clearRalphState,
  clearLinkedUltraworkState
} from '../ralph/index.js';
import {
  startUltraQA,
  clearUltraQAState,
  readUltraQAState
} from '../ultraqa/index.js';
import { canStartMode } from '../mode-registry/index.js';
import { resolveSessionStatePath, ensureSessionStateDir } from '../../lib/worktree-paths.js';

const STATE_FILE = 'autopilot-state.json';
const SPEC_DIR = 'autopilot';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Get the state file path
 */
function getStateFilePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('autopilot', sessionId, directory);
  }
  const omcDir = join(directory, '.omc');
  return join(omcDir, 'state', STATE_FILE);
}

/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory: string, sessionId?: string): void {
  if (sessionId) {
    ensureSessionStateDir(sessionId, directory);
    return;
  }
  const stateDir = join(directory, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Ensure the autopilot directory exists
 */
export function ensureAutopilotDir(directory: string): string {
  ensureStateDir(directory);
  const autopilotDir = join(directory, '.omc', SPEC_DIR);
  if (!existsSync(autopilotDir)) {
    mkdirSync(autopilotDir, { recursive: true });
  }
  return autopilotDir;
}

/**
 * Read autopilot state from disk
 */
export function readAutopilotState(directory: string, sessionId?: string): AutopilotState | null {
  if (sessionId) {
    // Session-scoped ONLY — no legacy fallback
    const sessionFile = getStateFilePath(directory, sessionId);
    if (!existsSync(sessionFile)) return null;
    try {
      const content = readFileSync(sessionFile, 'utf-8');
      const state = JSON.parse(content);
      // Validate session identity
      if (state.session_id && state.session_id !== sessionId) return null;
      return state;
    } catch {
      return null;
    }
  }

  // No sessionId: legacy path (backward compat)
  const stateFile = getStateFilePath(directory);
  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write autopilot state to disk
 */
export function writeAutopilotState(directory: string, state: AutopilotState, sessionId?: string): boolean {
  try {
    ensureStateDir(directory, sessionId);
    const stateFile = getStateFilePath(directory, sessionId);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear autopilot state
 */
export function clearAutopilotState(directory: string, sessionId?: string): boolean {
  const stateFile = getStateFilePath(directory, sessionId);

  if (!existsSync(stateFile)) {
    return true;
  }

  try {
    unlinkSync(stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if autopilot is active
 */
export function isAutopilotActive(directory: string, sessionId?: string): boolean {
  const state = readAutopilotState(directory, sessionId);
  return state !== null && state.active === true;
}

/**
 * Initialize a new autopilot session
 */
export function initAutopilot(
  directory: string,
  idea: string,
  sessionId?: string,
  config?: Partial<AutopilotConfig>
): AutopilotState | null {
  // Mutual exclusion check via mode-registry
  const canStart = canStartMode('autopilot', directory);
  if (!canStart.allowed) {
    console.error(canStart.message);
    return null;
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = new Date().toISOString();

  const state: AutopilotState = {
    active: true,
    phase: 'expansion',
    iteration: 1,
    max_iterations: mergedConfig.maxIterations ?? 10,
    originalIdea: idea,

    expansion: {
      analyst_complete: false,
      architect_complete: false,
      spec_path: null,
      requirements_summary: '',
      tech_stack: []
    },

    planning: {
      plan_path: null,
      architect_iterations: 0,
      approved: false
    },

    execution: {
      ralph_iterations: 0,
      ultrawork_active: false,
      tasks_completed: 0,
      tasks_total: 0,
      files_created: [],
      files_modified: []
    },

    qa: {
      ultraqa_cycles: 0,
      build_status: 'pending',
      lint_status: 'pending',
      test_status: 'pending'
    },

    validation: {
      architects_spawned: 0,
      verdicts: [],
      all_approved: false,
      validation_rounds: 0
    },

    started_at: now,
    completed_at: null,
    phase_durations: {},
    total_agents_spawned: 0,
    wisdom_entries: 0,
    session_id: sessionId,
    project_path: directory
  };

  ensureAutopilotDir(directory);
  writeAutopilotState(directory, state, sessionId);

  return state;
}

/**
 * Transition to a new phase
 */
export function transitionPhase(
  directory: string,
  newPhase: AutopilotPhase,
  sessionId?: string
): AutopilotState | null {
  const state = readAutopilotState(directory, sessionId);

  if (!state || !state.active) {
    return null;
  }

  const now = new Date().toISOString();
  const oldPhase = state.phase;

  // Record duration for old phase (if we have a start time recorded)
  const phaseStartKey = `${oldPhase}_start_ms`;
  if (state.phase_durations[phaseStartKey] !== undefined) {
    const duration = Date.now() - state.phase_durations[phaseStartKey];
    state.phase_durations[oldPhase] = duration;
  }

  // Transition to new phase and record start time
  state.phase = newPhase;
  state.phase_durations[`${newPhase}_start_ms`] = Date.now();

  if (newPhase === 'complete' || newPhase === 'failed') {
    state.completed_at = now;
    state.active = false;
  }

  writeAutopilotState(directory, state, sessionId);
  return state;
}

/**
 * Increment the agent spawn counter
 */
export function incrementAgentCount(directory: string, count: number = 1, sessionId?: string): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.total_agents_spawned += count;
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Update expansion phase data
 */
export function updateExpansion(
  directory: string,
  updates: Partial<AutopilotState['expansion']>,
  sessionId?: string
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.expansion = { ...state.expansion, ...updates };
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Update planning phase data
 */
export function updatePlanning(
  directory: string,
  updates: Partial<AutopilotState['planning']>,
  sessionId?: string
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.planning = { ...state.planning, ...updates };
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Update execution phase data
 */
export function updateExecution(
  directory: string,
  updates: Partial<AutopilotState['execution']>,
  sessionId?: string
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.execution = { ...state.execution, ...updates };
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Update QA phase data
 */
export function updateQA(
  directory: string,
  updates: Partial<AutopilotState['qa']>,
  sessionId?: string
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.qa = { ...state.qa, ...updates };
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Update validation phase data
 */
export function updateValidation(
  directory: string,
  updates: Partial<AutopilotState['validation']>,
  sessionId?: string
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  state.validation = { ...state.validation, ...updates };
  return writeAutopilotState(directory, state, sessionId);
}

/**
 * Get the spec file path
 */
export function getSpecPath(directory: string): string {
  return join(directory, '.omc', SPEC_DIR, 'spec.md');
}

/**
 * Get the plan file path
 */
export function getPlanPath(directory: string): string {
  return join(directory, '.omc', 'plans', 'autopilot-impl.md');
}

// ============================================================================
// PHASE TRANSITIONS
// ============================================================================

export interface TransitionResult {
  success: boolean;
  error?: string;
  state?: AutopilotState;
}

/**
 * Transition from Ralph (Phase 2: Execution) to UltraQA (Phase 3: QA)
 *
 * This handles the mutual exclusion by:
 * 1. Saving Ralph's progress to autopilot state
 * 2. Cleanly terminating Ralph mode (and linked Ultrawork)
 * 3. Starting UltraQA mode
 * 4. Preserving context for potential rollback
 */
export function transitionRalphToUltraQA(
  directory: string,
  sessionId: string
): TransitionResult {
  const autopilotState = readAutopilotState(directory, sessionId);

  if (!autopilotState || autopilotState.phase !== 'execution') {
    return {
      success: false,
      error: 'Not in execution phase - cannot transition to QA'
    };
  }

  const ralphState = readRalphState(directory, sessionId);

  // Step 1: Preserve Ralph progress in autopilot state
  const executionUpdated = updateExecution(directory, {
    ralph_iterations: ralphState?.iteration ?? autopilotState.execution.ralph_iterations,
    ralph_completed_at: new Date().toISOString(),
    ultrawork_active: false
  }, sessionId);

  if (!executionUpdated) {
    return {
      success: false,
      error: 'Failed to update execution state'
    };
  }

  // Step 2: Cleanly terminate Ralph (and linked Ultrawork)
  if (ralphState?.linked_ultrawork) {
    clearLinkedUltraworkState(directory, sessionId);
  }
  const ralphCleared = clearRalphState(directory, sessionId);

  if (!ralphCleared) {
    return {
      success: false,
      error: 'Failed to clear Ralph state'
    };
  }

  // Step 3: Transition to QA phase
  const newState = transitionPhase(directory, 'qa', sessionId);
  if (!newState) {
    return {
      success: false,
      error: 'Failed to transition to QA phase'
    };
  }

  // Step 4: Start UltraQA
  const qaResult = startUltraQA(directory, 'tests', sessionId, { maxCycles: 5 });

  if (!qaResult.success) {
    // Rollback on failure - restore execution phase
    transitionPhase(directory, 'execution', sessionId);
    updateExecution(directory, { ralph_completed_at: undefined }, sessionId);

    return {
      success: false,
      error: qaResult.error || 'Failed to start UltraQA'
    };
  }

  return {
    success: true,
    state: newState
  };
}

/**
 * Transition from UltraQA (Phase 3: QA) to Validation (Phase 4)
 */
export function transitionUltraQAToValidation(
  directory: string,
  sessionId?: string
): TransitionResult {
  const autopilotState = readAutopilotState(directory, sessionId);

  if (!autopilotState || autopilotState.phase !== 'qa') {
    return {
      success: false,
      error: 'Not in QA phase - cannot transition to validation'
    };
  }

  const qaState = readUltraQAState(directory, sessionId);

  // Preserve QA progress
  const qaUpdated = updateQA(directory, {
    ultraqa_cycles: qaState?.cycle ?? autopilotState.qa.ultraqa_cycles,
    qa_completed_at: new Date().toISOString()
  }, sessionId);

  if (!qaUpdated) {
    return {
      success: false,
      error: 'Failed to update QA state'
    };
  }

  // Terminate UltraQA
  clearUltraQAState(directory, sessionId);

  // Transition to validation
  const newState = transitionPhase(directory, 'validation', sessionId);
  if (!newState) {
    return {
      success: false,
      error: 'Failed to transition to validation phase'
    };
  }

  return {
    success: true,
    state: newState
  };
}

/**
 * Transition from Validation (Phase 4) to Complete
 */
export function transitionToComplete(directory: string, sessionId?: string): TransitionResult {
  const state = transitionPhase(directory, 'complete', sessionId);

  if (!state) {
    return {
      success: false,
      error: 'Failed to transition to complete phase'
    };
  }

  return { success: true, state };
}

/**
 * Transition to failed state
 */
export function transitionToFailed(
  directory: string,
  error: string,
  sessionId?: string
): TransitionResult {
  const state = transitionPhase(directory, 'failed', sessionId);

  if (!state) {
    return {
      success: false,
      error: 'Failed to transition to failed phase'
    };
  }

  return { success: true, state };
}

/**
 * Get a prompt for Claude to execute the transition
 */
export function getTransitionPrompt(
  fromPhase: string,
  toPhase: string
): string {
  if (fromPhase === 'execution' && toPhase === 'qa') {
    return `## PHASE TRANSITION: Execution → QA

The execution phase is complete. Transitioning to QA phase.

**CRITICAL**: Ralph mode must be cleanly terminated before UltraQA can start.

The transition handler has:
1. Preserved Ralph iteration count and progress
2. Cleared Ralph state (and linked Ultrawork)
3. Started UltraQA in 'tests' mode

You are now in QA phase. Run the QA cycle:
1. Build: Run the project's build command
2. Lint: Run the project's lint command
3. Test: Run the project's test command

Fix any failures and repeat until all pass.

Signal when QA passes: QA_COMPLETE
`;
  }

  if (fromPhase === 'qa' && toPhase === 'validation') {
    return `## PHASE TRANSITION: QA → Validation

All QA checks have passed. Transitioning to validation phase.

The transition handler has:
1. Preserved UltraQA cycle count
2. Cleared UltraQA state
3. Updated phase to 'validation'

You are now in validation phase. Spawn parallel validation architects:

\`\`\`
// Spawn all three in parallel
Task(subagent_type="oh-my-claudecode:architect", model="opus",
  prompt="FUNCTIONAL COMPLETENESS REVIEW: Verify all requirements from spec are implemented")

Task(subagent_type="oh-my-claudecode:security-reviewer", model="opus",
  prompt="SECURITY REVIEW: Check for vulnerabilities, injection risks, auth issues")

Task(subagent_type="oh-my-claudecode:code-reviewer", model="opus",
  prompt="CODE QUALITY REVIEW: Check patterns, maintainability, test coverage")
\`\`\`

Aggregate verdicts:
- All APPROVED → Signal: AUTOPILOT_COMPLETE
- Any REJECTED → Fix issues and re-validate (max 3 rounds)
`;
  }

  if (fromPhase === 'expansion' && toPhase === 'planning') {
    return `## PHASE TRANSITION: Expansion → Planning

The idea has been expanded into a detailed specification.

Read the spec and create an implementation plan using the Architect agent (direct planning mode).

Signal when Critic approves the plan: PLANNING_COMPLETE
`;
  }

  if (fromPhase === 'planning' && toPhase === 'execution') {
    return `## PHASE TRANSITION: Planning → Execution

The plan has been approved. Starting execution phase with Ralph + Ultrawork.

Execute tasks from the plan in parallel where possible.

Signal when all tasks complete: EXECUTION_COMPLETE
`;
  }

  return '';
}
