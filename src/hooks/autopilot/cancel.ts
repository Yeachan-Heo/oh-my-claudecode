/**
 * Autopilot Cancellation
 *
 * Handles cancellation of autopilot, cleaning up all related state
 * including any active Ralph or UltraQA modes.
 */

import {
  readAutopilotState,
  clearAutopilotState,
  getAutopilotStateAge,
  updateAutopilotStateIfCurrent,
  updateAutopilotStateIfExact,
} from './state.js';
import { clearRalphState, clearLinkedUltraworkState, readRalphState } from '../ralph/index.js';
import { clearUltraQAState, readUltraQAState } from '../ultraqa/index.js';
import type { AutopilotState } from './types.js';
import { namedWorkflowRuntimeSupported, validateNamedWorkflowState } from './named-workflow-resume-validator.js';

export interface CancelResult {
  success: boolean;
  message: string;
  preservedState?: AutopilotState;
}

/**
 * Cancel autopilot and clean up all related state
 * Progress is preserved for potential resume
 */
export function cancelAutopilot(directory: string, sessionId?: string): CancelResult {
  const state = readAutopilotState(directory, sessionId);

  if (!state) {
    return {
      success: false,
      message: 'No active autopilot session found'
    };
  }

  if (!state.active) {
    return {
      success: false,
      message: 'Autopilot is not currently active'
    };
  }


  // Commit the primary run mutation before deleting any linked lifecycle state.
  const cancelledState = updateAutopilotStateIfCurrent(directory, state, { active: false }, sessionId);
  if (!cancelledState) {
    return { success: false, message: 'Autopilot run changed before cancellation; retry /cancel.' };
  }

  const cleanedUp: string[] = [];
  const failedCleanup: string[] = [];
  const ralphState = sessionId ? readRalphState(directory, sessionId) : readRalphState(directory);
  if (ralphState?.active) {
    let mayClearRalph = true;
    if (ralphState.linked_ultrawork) {
      const cleared = sessionId ? clearLinkedUltraworkState(directory, sessionId) : clearLinkedUltraworkState(directory);
      if (cleared) cleanedUp.push('ultrawork');
      else { failedCleanup.push('ultrawork'); mayClearRalph = false; }
    }
    if (mayClearRalph) {
      const cleared = sessionId ? clearRalphState(directory, sessionId) : clearRalphState(directory);
      if (cleared) cleanedUp.push('ralph');
      else failedCleanup.push('ralph');
    } else {
      failedCleanup.push('ralph');
    }
  }

  const ultraqaState = sessionId ? readUltraQAState(directory, sessionId) : readUltraQAState(directory);
  if (ultraqaState?.active) {
    const cleared = sessionId ? clearUltraQAState(directory, sessionId) : clearUltraQAState(directory);
    if (cleared) cleanedUp.push('ultraqa');
    else failedCleanup.push('ultraqa');
  }

  const cleanupMsg = cleanedUp.length > 0 ? ` Cleaned up: ${cleanedUp.join(', ')}.` : '';
  if (failedCleanup.length > 0) {
    return {
      success: false,
      message: `Autopilot paused at phase: ${cancelledState.phase}, but linked cleanup failed for: ${failedCleanup.join(', ')}. Retry /cancel.`,
      preservedState: cancelledState,
    };
  }
  return {
    success: true,
    message: `Autopilot cancelled at phase: ${cancelledState.phase}.${cleanupMsg} Progress preserved for resume.`,
    preservedState: cancelledState
  };
}

/**
 * Fully clear autopilot state (no preserve)
 */
export function clearAutopilot(directory: string, sessionId?: string): CancelResult {
  const state = readAutopilotState(directory, sessionId);

  if (!state) {
    return {
      success: true,
      message: 'No autopilot state to clear'
    };
  }


  // Delete the primary run before deleting any linked lifecycle state.
  if (!clearAutopilotState(directory, sessionId, state)) {
    return { success: false, message: 'Autopilot run changed before clear; retry /cancel.' };
  }

  const failedCleanup: string[] = [];
  const ralphState = sessionId ? readRalphState(directory, sessionId) : readRalphState(directory);
  if (ralphState) {
    let mayClearRalph = true;
    if (ralphState.linked_ultrawork) {
      const cleared = sessionId ? clearLinkedUltraworkState(directory, sessionId) : clearLinkedUltraworkState(directory);
      if (!cleared) { failedCleanup.push('ultrawork'); mayClearRalph = false; }
    }
    if (mayClearRalph) {
      const cleared = sessionId ? clearRalphState(directory, sessionId) : clearRalphState(directory);
      if (!cleared) failedCleanup.push('ralph');
    } else {
      failedCleanup.push('ralph');
    }
  }

  const ultraqaState = sessionId ? readUltraQAState(directory, sessionId) : readUltraQAState(directory);
  if (ultraqaState) {
    const cleared = sessionId ? clearUltraQAState(directory, sessionId) : clearUltraQAState(directory);
    if (!cleared) failedCleanup.push('ultraqa');
  }

  if (failedCleanup.length > 0) {
    return { success: false, message: `Autopilot state cleared, but linked cleanup failed for: ${failedCleanup.join(', ')}. Retry /cancel --force.` };
  }
  return {
    success: true,
    message: 'Autopilot state cleared completely'
  };
}

/** Maximum age (ms) for state to be considered resumable (1 hour) */
export const STALE_STATE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Check if autopilot can be resumed.
 *
 * Guards against stale state reuse (issue #609):
 * - Rejects terminal phases (complete/failed)
 * - Rejects states still marked active (session may still be running)
 * - Rejects stale states older than STALE_STATE_MAX_AGE_MS
 * - Auto-cleans stale state files to prevent future false positives
 */
export function canResumeAutopilot(directory: string, sessionId?: string): {
  canResume: boolean;
  state?: AutopilotState;
  resumePhase?: string;
  integrityFailed?: boolean;
  unsupportedRuntime?: boolean;
} {
  const state = readAutopilotState(directory, sessionId);

  if (!state) {
    return { canResume: false };
  }

  if (state.workflow) {
    if (!namedWorkflowRuntimeSupported()) {
      return { canResume: false, resumePhase: state.phase, unsupportedRuntime: true };
    }
    if (!validateNamedWorkflowState(state, sessionId)) {
      return { canResume: false, resumePhase: state.phase, integrityFailed: true };
    }
  }

  // Cannot resume terminal states
  if (state.phase === 'complete' || state.phase === 'failed') {
    return { canResume: false, state, resumePhase: state.phase };
  }

  // Cannot resume a state that claims to be actively running — it may belong
  // to another session that is still alive.
  if (state.active) {
    return { canResume: false, state, resumePhase: state.phase };
  }

  // Reject stale states: if the state file hasn't been touched in over an hour
  // it is from a previous session and should not be resumed.
  const ageMs = getAutopilotStateAge(directory, sessionId);
  if (ageMs !== null && ageMs > STALE_STATE_MAX_AGE_MS) {
    // Auto-cleanup stale state to prevent future false positives
    clearAutopilotState(directory, sessionId, state);
    return { canResume: false, state, resumePhase: state.phase };
  }

  return {
    canResume: true,
    state,
    resumePhase: state.phase
  };
}

/**
 * Resume a paused autopilot session
 */
export function resumeAutopilot(directory: string, sessionId?: string): {
  success: boolean;
  message: string;
  state?: AutopilotState;
} {
  const { canResume, state, integrityFailed, unsupportedRuntime } = canResumeAutopilot(directory, sessionId);

  if (!canResume || !state) {
    return {
      success: false,
      message: unsupportedRuntime
        ? 'unsupported-runtime'
        : integrityFailed
          ? 'workflow_descriptor_integrity_failed'
          : 'No autopilot session available to resume'
    };
  }

  // Re-activate only the exact paused run observed by canResumeAutopilot.
  const resumedState = state.workflow
    ? updateAutopilotStateIfExact(
        directory,
        state,
        { active: true },
        sessionId,
        (current) => Boolean(validateNamedWorkflowState(current, sessionId)),
      )
    : updateAutopilotStateIfCurrent(
        directory,
        state,
        { active: true, iteration: state.iteration + 1 },
        sessionId,
      );
  if (!resumedState) {
    return {
      success: false,
      message: state.workflow ? 'workflow_descriptor_integrity_failed' : 'Autopilot run changed before resume; retry.'
    };
  }

  return {
    success: true,
    message: `Resuming autopilot at phase: ${state.phase}`,
    state: resumedState
  };
}

/**
 * Format cancel message for display
 */
export function formatCancelMessage(result: CancelResult): string {
  if (!result.success) {
    return `[AUTOPILOT] ${result.message}`;
  }

  const lines: string[] = [
    '',
    '[AUTOPILOT CANCELLED]',
    '',
    result.message,
    ''
  ];

  if (result.preservedState) {
    const state = result.preservedState;
    if (state.workflow) {
      lines.push('');
      lines.push('Run /autopilot to resume from where you left off.');
    } else {
      lines.push('Progress Summary:');
      lines.push(`- Phase reached: ${state.phase}`);
      lines.push(`- Files created: ${state.execution?.files_created?.length ?? 0}`);
      lines.push(`- Files modified: ${state.execution?.files_modified?.length ?? 0}`);
      lines.push(`- Agents used: ${state.total_agents_spawned ?? 0}`);
      lines.push('');
      lines.push('Run /autopilot to resume from where you left off.');
    }
  }

  return lines.join('\n');
}
