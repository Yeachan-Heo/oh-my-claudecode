/**
 * Autopilot Cancellation
 *
 * Handles cancellation of autopilot, cleaning up all related state
 * including any active Ralph or UltraQA modes.
 */
import { readAutopilotState, clearAutopilotState, getAutopilotStateAge, updateAutopilotStateIfCurrent, updateAutopilotStateIfExact, } from './state.js';
import { clearRalphState, clearLinkedUltraworkState, readRalphState } from '../ralph/index.js';
import { clearUltraQAState, readUltraQAState } from '../ultraqa/index.js';
import { namedWorkflowRuntimeSupported, validateNamedWorkflowState, validateNamedWorkflowStateStructure } from './named-workflow-resume-validator.js';
import { clearModeStateFile, readModeState } from '../../lib/mode-state-io.js';
function hasNamedWorkflowMarkers(state) {
    return Boolean(state &&
        typeof state === 'object' &&
        ['workflow', 'workflowRunId', 'pipelineTracking'].some((marker) => Object.prototype.hasOwnProperty.call(state, marker)));
}
function validNamedWorkflowForMutation(state, sessionId) {
    return hasNamedWorkflowMarkers(state) && Boolean(validateNamedWorkflowStateStructure(state, sessionId));
}
function validNamedWorkflowForResume(state, sessionId) {
    return hasNamedWorkflowMarkers(state) && Boolean(namedWorkflowRuntimeSupported()
        ? validateNamedWorkflowState(state, sessionId)
        : validateNamedWorkflowStateStructure(state, sessionId));
}
function clearSessionOwnedNestedRalplanState(directory, sessionId) {
    if (!sessionId)
        return null;
    const state = readModeState('ralplan', directory, sessionId);
    if (!state || state.session_id !== sessionId)
        return null;
    return clearModeStateFile('ralplan', directory, sessionId, state);
}
function safePhase(phase) {
    return typeof phase === 'string' && phase.length > 0 && phase.length <= 128
        ? phase
        : 'unknown';
}
/**
 * Cancel autopilot and clean up all related state
 * Progress is preserved for potential resume
 */
export function cancelAutopilot(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state) {
        return {
            success: false,
            message: 'No active autopilot session found'
        };
    }
    const namedWorkflow = hasNamedWorkflowMarkers(state);
    if (namedWorkflow && !validNamedWorkflowForMutation(state, sessionId)) {
        return { success: false, message: 'workflow_descriptor_integrity_failed' };
    }
    // A named run may already be paused when a previous cancellation committed
    // the primary mutation but dependent cleanup failed. Retry only that cleanup.
    if (!state.active && !namedWorkflow) {
        return {
            success: false,
            message: 'Autopilot is not currently active'
        };
    }
    // Commit the primary run mutation before deleting any linked lifecycle state.
    // On a paused named run, the empty exact update acts as a conditional ownership
    // check without reactivating or otherwise replaying the primary state.
    const cancelledState = namedWorkflow
        ? updateAutopilotStateIfExact(directory, state, state.active ? { active: false } : {}, sessionId, (current) => validNamedWorkflowForMutation(current, sessionId))
        : updateAutopilotStateIfCurrent(directory, state, { active: false }, sessionId);
    if (!cancelledState) {
        return { success: false, message: 'Autopilot run changed before cancellation; retry /cancel.' };
    }
    const cleanedUp = [];
    const failedCleanup = [];
    // Named workflows can leave a session-owned ralplan enforcement state behind.
    // Remove it only after the exact primary run has been paused.
    if (hasNamedWorkflowMarkers(cancelledState)) {
        const cleared = clearSessionOwnedNestedRalplanState(directory, sessionId);
        if (cleared === true)
            cleanedUp.push('ralplan');
        else if (cleared === false)
            failedCleanup.push('ralplan');
    }
    const ralphState = sessionId ? readRalphState(directory, sessionId) : readRalphState(directory);
    if (ralphState?.active) {
        let mayClearRalph = true;
        if (ralphState.linked_ultrawork) {
            const cleared = sessionId ? clearLinkedUltraworkState(directory, sessionId) : clearLinkedUltraworkState(directory);
            if (cleared)
                cleanedUp.push('ultrawork');
            else {
                failedCleanup.push('ultrawork');
                mayClearRalph = false;
            }
        }
        if (mayClearRalph) {
            const cleared = sessionId ? clearRalphState(directory, sessionId) : clearRalphState(directory);
            if (cleared)
                cleanedUp.push('ralph');
            else
                failedCleanup.push('ralph');
        }
        else {
            failedCleanup.push('ralph');
        }
    }
    const ultraqaState = sessionId ? readUltraQAState(directory, sessionId) : readUltraQAState(directory);
    if (ultraqaState?.active) {
        const cleared = sessionId ? clearUltraQAState(directory, sessionId) : clearUltraQAState(directory);
        if (cleared)
            cleanedUp.push('ultraqa');
        else
            failedCleanup.push('ultraqa');
    }
    const cleanupMsg = cleanedUp.length > 0 ? ` Cleaned up: ${cleanedUp.join(', ')}.` : '';
    if (failedCleanup.length > 0) {
        return {
            success: false,
            message: `Autopilot paused at phase: ${safePhase(cancelledState.phase)}, but linked cleanup failed for: ${failedCleanup.join(', ')}. Retry /cancel.`,
            preservedState: cancelledState,
        };
    }
    return {
        success: true,
        message: `Autopilot cancelled at phase: ${safePhase(cancelledState.phase)}.${cleanupMsg} Progress preserved for resume.`,
        preservedState: cancelledState
    };
}
/**
 * Fully clear autopilot state (no preserve)
 */
export function clearAutopilot(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state) {
        return {
            success: true,
            message: 'No autopilot state to clear'
        };
    }
    if (hasNamedWorkflowMarkers(state) && !validNamedWorkflowForMutation(state, sessionId)) {
        return { success: false, message: 'workflow_descriptor_integrity_failed' };
    }
    // Delete the primary run before deleting any linked lifecycle state.
    if (!clearAutopilotState(directory, sessionId, state)) {
        return { success: false, message: 'Autopilot run changed before clear; retry /cancel.' };
    }
    const failedCleanup = [];
    if (hasNamedWorkflowMarkers(state)) {
        const cleared = clearSessionOwnedNestedRalplanState(directory, sessionId);
        if (cleared === false)
            failedCleanup.push('ralplan');
    }
    const ralphState = sessionId ? readRalphState(directory, sessionId) : readRalphState(directory);
    if (ralphState) {
        let mayClearRalph = true;
        if (ralphState.linked_ultrawork) {
            const cleared = sessionId ? clearLinkedUltraworkState(directory, sessionId) : clearLinkedUltraworkState(directory);
            if (!cleared) {
                failedCleanup.push('ultrawork');
                mayClearRalph = false;
            }
        }
        if (mayClearRalph) {
            const cleared = sessionId ? clearRalphState(directory, sessionId) : clearRalphState(directory);
            if (!cleared)
                failedCleanup.push('ralph');
        }
        else {
            failedCleanup.push('ralph');
        }
    }
    const ultraqaState = sessionId ? readUltraQAState(directory, sessionId) : readUltraQAState(directory);
    if (ultraqaState) {
        const cleared = sessionId ? clearUltraQAState(directory, sessionId) : clearUltraQAState(directory);
        if (!cleared)
            failedCleanup.push('ultraqa');
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
export function canResumeAutopilot(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state) {
        return { canResume: false };
    }
    if (hasNamedWorkflowMarkers(state)) {
        if (!validNamedWorkflowForResume(state, sessionId)) {
            return { canResume: false, resumePhase: state.phase, integrityFailed: true };
        }
        if (!namedWorkflowRuntimeSupported()) {
            return { canResume: false, state, resumePhase: state.phase, unsupportedRuntime: true };
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
export function resumeAutopilot(directory, sessionId) {
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
    const resumedState = hasNamedWorkflowMarkers(state)
        ? updateAutopilotStateIfExact(directory, state, { active: true }, sessionId, (current) => validNamedWorkflowForResume(current, sessionId))
        : updateAutopilotStateIfCurrent(directory, state, { active: true, iteration: state.iteration + 1 }, sessionId);
    if (!resumedState) {
        return {
            success: false,
            message: hasNamedWorkflowMarkers(state) ? 'workflow_descriptor_integrity_failed' : 'Autopilot run changed before resume; retry.'
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
export function formatCancelMessage(result) {
    if (!result.success) {
        return `[AUTOPILOT] ${result.message}`;
    }
    const lines = [
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
        }
        else {
            lines.push('Progress Summary:');
            lines.push(`- Phase reached: ${safePhase(state.phase)}`);
            lines.push(`- Files created: ${state.execution?.files_created?.length ?? 0}`);
            lines.push(`- Files modified: ${state.execution?.files_modified?.length ?? 0}`);
            lines.push(`- Agents used: ${state.total_agents_spawned ?? 0}`);
            lines.push('');
            lines.push('Run /autopilot to resume from where you left off.');
        }
    }
    return lines.join('\n');
}
//# sourceMappingURL=cancel.js.map