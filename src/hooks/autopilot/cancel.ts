/**
 * Autopilot Cancellation
 *
 * Handles cancellation of autopilot, cleaning up all related state
 * including any active Ralph or UltraQA modes.
 */

import {
  readAutopilotState,
  clearAutopilotState,
  writeAutopilotState
} from './state.js';
import { clearRalphState, clearLinkedUltraworkState, readRalphState } from '../ralph/index.js';
import { clearUltraQAState, readUltraQAState } from '../ultraqa/index.js';
import type { AutopilotState } from './types.js';

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

  // Track what we cleaned up
  const cleanedUp: string[] = [];

  // Clean up any active Ralph state
  const ralphState = sessionId
    ? readRalphState(directory, sessionId)
    : readRalphState(directory);
  if (ralphState?.active) {
    if (ralphState.linked_ultrawork) {
      if (sessionId) {
        clearLinkedUltraworkState(directory, sessionId);
      } else {
        clearLinkedUltraworkState(directory);
      }
      cleanedUp.push('ultrawork');
    }
    if (sessionId) {
      clearRalphState(directory, sessionId);
    } else {
      clearRalphState(directory);
    }
    cleanedUp.push('ralph');
  }

  // Clean up any active UltraQA state
  const ultraqaState = sessionId
    ? readUltraQAState(directory, sessionId)
    : readUltraQAState(directory);
  if (ultraqaState?.active) {
    if (sessionId) {
      clearUltraQAState(directory, sessionId);
    } else {
      clearUltraQAState(directory);
    }
    cleanedUp.push('ultraqa');
  }

  // Mark autopilot as inactive but preserve state for resume
  state.active = false;
  writeAutopilotState(directory, state, sessionId);

  const cleanupMsg = cleanedUp.length > 0
    ? ` Cleaned up: ${cleanedUp.join(', ')}.`
    : '';

  return {
    success: true,
    message: `Autopilot cancelled at phase: ${state.phase}.${cleanupMsg} Progress preserved for resume.`,
    preservedState: state
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

  // Clean up all related state
  const ralphState = sessionId
    ? readRalphState(directory, sessionId)
    : readRalphState(directory);
  if (ralphState) {
    if (ralphState.linked_ultrawork) {
      if (sessionId) {
        clearLinkedUltraworkState(directory, sessionId);
      } else {
        clearLinkedUltraworkState(directory);
      }
    }
    if (sessionId) {
      clearRalphState(directory, sessionId);
    } else {
      clearRalphState(directory);
    }
  }

  const ultraqaState = sessionId
    ? readUltraQAState(directory, sessionId)
    : readUltraQAState(directory);
  if (ultraqaState) {
    if (sessionId) {
      clearUltraQAState(directory, sessionId);
    } else {
      clearUltraQAState(directory);
    }
  }

  // Clear autopilot state completely
  clearAutopilotState(directory, sessionId);

  return {
    success: true,
    message: 'Autopilot state cleared completely'
  };
}

/**
 * Check if autopilot can be resumed
 */
export function canResumeAutopilot(directory: string, sessionId?: string): {
  canResume: boolean;
  state?: AutopilotState;
  resumePhase?: string;
} {
  const state = readAutopilotState(directory, sessionId);

  if (!state) {
    return { canResume: false };
  }

  // Can resume if state exists and is not complete/failed
  const canResume = state.phase !== 'complete' && state.phase !== 'failed';

  return {
    canResume,
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
  const { canResume, state } = canResumeAutopilot(directory, sessionId);

  if (!canResume || !state) {
    return {
      success: false,
      message: 'No autopilot session available to resume'
    };
  }

  // Re-activate
  state.active = true;
  state.iteration++;

  if (!writeAutopilotState(directory, state, sessionId)) {
    return {
      success: false,
      message: 'Failed to update autopilot state'
    };
  }

  return {
    success: true,
    message: `Resuming autopilot at phase: ${state.phase}`,
    state
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
    lines.push('Progress Summary:');
    lines.push(`- Phase reached: ${state.phase}`);
    lines.push(`- Files created: ${state.execution.files_created.length}`);
    lines.push(`- Files modified: ${state.execution.files_modified.length}`);
    lines.push(`- Agents used: ${state.total_agents_spawned}`);
    lines.push('');
    lines.push('Run /autopilot to resume from where you left off.');
  }

  return lines.join('\n');
}
