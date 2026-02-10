import { markTeamPhase } from './state.js';
const ALLOWED = {
    'team-plan': ['team-prd'],
    'team-prd': ['team-exec'],
    'team-exec': ['team-verify'],
    'team-verify': ['team-fix', 'complete', 'failed'],
    'team-fix': ['team-exec', 'team-verify', 'complete', 'failed'],
    complete: [],
    failed: [],
    cancelled: ['team-plan', 'team-exec'],
};
function isAllowedTransition(from, to) {
    return ALLOWED[from].includes(to);
}
/** Validates that a value is a non-negative finite integer */
export function isNonNegativeFiniteInteger(n) {
    return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}
function hasRequiredArtifactsForPhase(state, next) {
    if (next === 'team-exec') {
        if (!state.artifacts.plan_path && !state.artifacts.prd_path) {
            return 'team-exec requires plan_path or prd_path artifact';
        }
        return null;
    }
    if (next === 'team-verify') {
        if (!isNonNegativeFiniteInteger(state.execution.tasks_total)) {
            return `tasks_total must be a non-negative finite integer, got: ${state.execution.tasks_total}`;
        }
        if (!isNonNegativeFiniteInteger(state.execution.tasks_completed)) {
            return `tasks_completed must be a non-negative finite integer, got: ${state.execution.tasks_completed}`;
        }
        if (state.execution.tasks_total <= 0) {
            return 'tasks_total must be > 0 for team-verify transition';
        }
        if (state.execution.tasks_completed < state.execution.tasks_total) {
            return `tasks_completed (${state.execution.tasks_completed}) < tasks_total (${state.execution.tasks_total})`;
        }
        return null;
    }
    return null;
}
export function transitionTeamPhase(state, next, reason) {
    if (!isAllowedTransition(state.phase, next)) {
        return {
            ok: false,
            state,
            reason: `Illegal transition: ${state.phase} -> ${next}`,
        };
    }
    // When resuming from cancelled, require preserve_for_resume flag
    if (state.phase === 'cancelled') {
        if (!state.cancel.preserve_for_resume) {
            return {
                ok: false,
                state,
                reason: `Cannot resume from cancelled: preserve_for_resume is not set`,
            };
        }
        // Re-activate the state on resume
        const resumed = {
            ...state,
            active: true,
            completed_at: null,
        };
        return markTeamPhase(resumed, next, reason ?? 'resumed-from-cancelled');
    }
    const guardFailure = hasRequiredArtifactsForPhase(state, next);
    if (guardFailure !== null) {
        return {
            ok: false,
            state,
            reason: guardFailure,
        };
    }
    return markTeamPhase(state, next, reason);
}
export function requestTeamCancel(state, preserveForResume = true) {
    return {
        ...state,
        cancel: {
            ...state.cancel,
            requested: true,
            requested_at: new Date().toISOString(),
            preserve_for_resume: preserveForResume,
        },
        phase: 'cancelled',
        active: false,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        phase_history: [
            ...state.phase_history,
            {
                phase: 'cancelled',
                entered_at: new Date().toISOString(),
                reason: 'cancel-requested',
            },
        ],
    };
}
//# sourceMappingURL=transitions.js.map