/**
 * Autopilot Enforcement & Signal Detection
 *
 * Parallel to ralph-loop enforcement - intercepts stops and continues
 * until phase completion signals are detected.
 *
 * Also handles signal detection in session transcripts.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readAutopilotState,
  writeAutopilotState,
  transitionPhase,
  transitionRalphToUltraQA,
  transitionUltraQAToValidation,
  transitionToComplete
} from './state.js';
import { getPhasePrompt } from './prompts.js';
import type { AutopilotState, AutopilotPhase, AutopilotSignal } from './types.js';

export interface AutopilotEnforcementResult {
  /** Whether to block the stop event */
  shouldBlock: boolean;
  /** Message to inject into context */
  message: string;
  /** Current phase */
  phase: AutopilotPhase;
  /** Additional metadata */
  metadata?: {
    iteration?: number;
    maxIterations?: number;
    tasksCompleted?: number;
    tasksTotal?: number;
  };
}

// ============================================================================
// SIGNAL DETECTION
// ============================================================================

/**
 * Signal patterns - each signal can appear in transcript
 */
const SIGNAL_PATTERNS: Record<AutopilotSignal, RegExp> = {
  'EXPANSION_COMPLETE': /EXPANSION_COMPLETE/i,
  'PLANNING_COMPLETE': /PLANNING_COMPLETE/i,
  'EXECUTION_COMPLETE': /EXECUTION_COMPLETE/i,
  'QA_COMPLETE': /QA_COMPLETE/i,
  'VALIDATION_COMPLETE': /VALIDATION_COMPLETE/i,
  'AUTOPILOT_COMPLETE': /AUTOPILOT_COMPLETE/i,
  'TRANSITION_TO_QA': /TRANSITION_TO_QA/i,
  'TRANSITION_TO_VALIDATION': /TRANSITION_TO_VALIDATION/i,
};

/**
 * Detect a specific signal in the session transcript
 */
export function detectSignal(sessionId: string, signal: AutopilotSignal): boolean {
  const claudeDir = join(homedir(), '.claude');
  const possiblePaths = [
    join(claudeDir, 'sessions', sessionId, 'transcript.md'),
    join(claudeDir, 'sessions', sessionId, 'messages.json'),
    join(claudeDir, 'transcripts', `${sessionId}.md`)
  ];

  const pattern = SIGNAL_PATTERNS[signal];
  if (!pattern) return false;

  for (const transcriptPath of possiblePaths) {
    if (existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        if (pattern.test(content)) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Get the expected signal for the current phase
 */
export function getExpectedSignalForPhase(phase: string): AutopilotSignal | null {
  switch (phase) {
    case 'expansion': return 'EXPANSION_COMPLETE';
    case 'planning': return 'PLANNING_COMPLETE';
    case 'execution': return 'EXECUTION_COMPLETE';
    case 'qa': return 'QA_COMPLETE';
    case 'validation': return 'VALIDATION_COMPLETE';
    default: return null;
  }
}

/**
 * Detect any autopilot signal in transcript (for phase advancement)
 */
export function detectAnySignal(sessionId: string): AutopilotSignal | null {
  for (const signal of Object.keys(SIGNAL_PATTERNS) as AutopilotSignal[]) {
    if (detectSignal(sessionId, signal)) {
      return signal;
    }
  }
  return null;
}

// ============================================================================
// ENFORCEMENT
// ============================================================================

/**
 * Get the next phase after current phase
 */
function getNextPhase(current: AutopilotPhase): AutopilotPhase | null {
  switch (current) {
    case 'expansion': return 'planning';
    case 'planning': return 'execution';
    case 'execution': return 'qa';
    case 'qa': return 'validation';
    case 'validation': return 'complete';
    default: return null;
  }
}

/**
 * Check autopilot state and determine if it should continue
 * This is the main enforcement function called by persistent-mode hook
 */
export async function checkAutopilot(
  sessionId?: string,
  directory?: string
): Promise<AutopilotEnforcementResult | null> {
  const workingDir = directory || process.cwd();
  const state = readAutopilotState(workingDir);

  if (!state || !state.active) {
    return null;
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return null;
  }

  // Check max iterations (safety limit)
  if (state.iteration >= state.max_iterations) {
    transitionPhase(workingDir, 'failed');
    return {
      shouldBlock: false,
      message: `[AUTOPILOT STOPPED] Max iterations (${state.max_iterations}) reached. Consider reviewing progress.`,
      phase: 'failed'
    };
  }

  // Check for completion
  if (state.phase === 'complete') {
    return {
      shouldBlock: false,
      message: `[AUTOPILOT COMPLETE] All phases finished successfully!`,
      phase: 'complete'
    };
  }

  if (state.phase === 'failed') {
    return {
      shouldBlock: false,
      message: `[AUTOPILOT FAILED] Session ended in failure state.`,
      phase: 'failed'
    };
  }

  // Check for phase completion signal
  const expectedSignal = getExpectedSignalForPhase(state.phase);
  if (expectedSignal && sessionId && detectSignal(sessionId, expectedSignal)) {
    // Phase complete - transition to next phase
    const nextPhase = getNextPhase(state.phase);
    if (nextPhase) {
      // Handle special transitions
      if (state.phase === 'execution' && nextPhase === 'qa') {
        const result = transitionRalphToUltraQA(workingDir, sessionId);
        if (!result.success) {
          // Transition failed, continue in current phase
          return generateContinuationPrompt(state, workingDir);
        }
      } else if (state.phase === 'qa' && nextPhase === 'validation') {
        const result = transitionUltraQAToValidation(workingDir);
        if (!result.success) {
          return generateContinuationPrompt(state, workingDir);
        }
      } else if (nextPhase === 'complete') {
        transitionToComplete(workingDir);
        return {
          shouldBlock: false,
          message: `[AUTOPILOT COMPLETE] All phases finished successfully!`,
          phase: 'complete'
        };
      } else {
        transitionPhase(workingDir, nextPhase);
      }

      // Get new state and generate prompt for next phase
      const newState = readAutopilotState(workingDir);
      if (newState) {
        return generateContinuationPrompt(newState, workingDir);
      }
    }
  }

  // No signal detected - continue current phase
  return generateContinuationPrompt(state, workingDir);
}

/**
 * Generate continuation prompt for current phase
 */
function generateContinuationPrompt(
  state: AutopilotState,
  directory: string
): AutopilotEnforcementResult {
  // Increment iteration
  state.iteration += 1;
  writeAutopilotState(directory, state);

  const phasePrompt = getPhasePrompt(state.phase, {
    idea: state.originalIdea,
    specPath: state.expansion.spec_path || '.omc/autopilot/spec.md',
    planPath: state.planning.plan_path || '.omc/plans/autopilot-impl.md'
  });

  const continuationPrompt = `<autopilot-continuation>

[AUTOPILOT - PHASE: ${state.phase.toUpperCase()} | ITERATION ${state.iteration}/${state.max_iterations}]

Your previous response did not signal phase completion. Continue working on the current phase.

${phasePrompt}

IMPORTANT: When the phase is complete, output the appropriate signal:
- Expansion: EXPANSION_COMPLETE
- Planning: PLANNING_COMPLETE
- Execution: EXECUTION_COMPLETE
- QA: QA_COMPLETE
- Validation: AUTOPILOT_COMPLETE

</autopilot-continuation>

---

`;

  return {
    shouldBlock: true,
    message: continuationPrompt,
    phase: state.phase,
    metadata: {
      iteration: state.iteration,
      maxIterations: state.max_iterations,
      tasksCompleted: state.execution.tasks_completed,
      tasksTotal: state.execution.tasks_total
    }
  };
}
