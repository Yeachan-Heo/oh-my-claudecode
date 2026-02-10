/**
 * OMC HUD - Autopilot Element
 *
 * Renders autopilot phase and progress display.
 */
import { RESET } from '../colors.js';
// ANSI color codes
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const PHASE_NAMES = {
    expansion: 'Expand',
    planning: 'Plan',
    execution: 'Build',
    qa: 'QA',
    validation: 'Verify',
    complete: 'Done',
    failed: 'Failed'
};
const PHASE_INDEX = {
    expansion: 1,
    planning: 2,
    execution: 3,
    qa: 4,
    validation: 5,
    complete: 5,
    failed: 0
};
/**
 * Render autopilot state.
 * Returns null if autopilot is not active.
 *
 * Format: [AUTOPILOT] Phase 2/5: Plan | Tasks: 5/12
 */
export function renderAutopilot(state, _thresholds) {
    if (!state?.active) {
        return null;
    }
    const { phase, iteration, maxIterations, tasksCompleted, tasksTotal, filesCreated } = state;
    const phaseNum = PHASE_INDEX[phase] || 0;
    const phaseName = PHASE_NAMES[phase] || phase;
    // Color based on phase
    let phaseColor;
    switch (phase) {
        case 'complete':
            phaseColor = GREEN;
            break;
        case 'failed':
            phaseColor = RED;
            break;
        case 'validation':
            phaseColor = MAGENTA;
            break;
        case 'qa':
            phaseColor = YELLOW;
            break;
        default:
            phaseColor = CYAN;
    }
    let output = `${CYAN}[AUTOPILOT]${RESET} Phase ${phaseColor}${phaseNum}/5${RESET}: ${phaseName}`;
    // Add iteration count if not first iteration
    if (iteration > 1) {
        output += ` (iter ${iteration}/${maxIterations})`;
    }
    // Add task progress if in execution phase
    if (phase === 'execution' && tasksTotal && tasksTotal > 0) {
        const taskColor = tasksCompleted === tasksTotal ? GREEN : YELLOW;
        output += ` | Tasks: ${taskColor}${tasksCompleted || 0}/${tasksTotal}${RESET}`;
    }
    // Add file count if available
    if (filesCreated && filesCreated > 0) {
        output += ` | ${filesCreated} files`;
    }
    return output;
}
/**
 * Render compact autopilot status for minimal displays.
 *
 * Format: AP:3/5 or AP:Done
 */
export function renderAutopilotCompact(state) {
    if (!state?.active) {
        return null;
    }
    const { phase } = state;
    const phaseNum = PHASE_INDEX[phase] || 0;
    if (phase === 'complete') {
        return `${GREEN}AP:Done${RESET}`;
    }
    if (phase === 'failed') {
        return `${RED}AP:Fail${RESET}`;
    }
    return `${CYAN}AP:${phaseNum}/5${RESET}`;
}
//# sourceMappingURL=autopilot.js.map