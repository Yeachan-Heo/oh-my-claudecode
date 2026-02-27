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
import { getClaudeConfigDir } from '../../utils/paths.js';
import { OmcPaths } from '../../lib/worktree-paths.js';
import { readAutopilotState, writeAutopilotState, transitionPhase, transitionRalphToUltraQA, transitionUltraQAToValidation, transitionToComplete } from './state.js';
import { getPhasePrompt } from './prompts.js';
import { readLastToolError, getToolErrorRetryGuidance } from '../persistent-mode/index.js';
import { readPipelineTracking, hasPipelineTracking, getCurrentStageAdapter, getCurrentCompletionSignal, advanceStage, incrementStageIteration, generateTransitionPrompt, formatPipelineHUD, } from './pipeline.js';
// ============================================================================
// SIGNAL DETECTION
// ============================================================================
/**
 * Signal patterns - each signal can appear in transcript
 */
const SIGNAL_PATTERNS = {
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
export function detectSignal(sessionId, signal) {
    const claudeDir = getClaudeConfigDir();
    const possiblePaths = [
        join(claudeDir, 'sessions', sessionId, 'transcript.md'),
        join(claudeDir, 'sessions', sessionId, 'messages.json'),
        join(claudeDir, 'transcripts', `${sessionId}.md`)
    ];
    const pattern = SIGNAL_PATTERNS[signal];
    if (!pattern)
        return false;
    for (const transcriptPath of possiblePaths) {
        if (existsSync(transcriptPath)) {
            try {
                const content = readFileSync(transcriptPath, 'utf-8');
                if (pattern.test(content)) {
                    return true;
                }
            }
            catch {
                continue;
            }
        }
    }
    return false;
}
/**
 * Get the expected signal for the current phase
 */
export function getExpectedSignalForPhase(phase) {
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
export function detectAnySignal(sessionId) {
    for (const signal of Object.keys(SIGNAL_PATTERNS)) {
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
function getNextPhase(current) {
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
export async function checkAutopilot(sessionId, directory) {
    const workingDir = directory || process.cwd();
    const state = readAutopilotState(workingDir, sessionId);
    if (!state || !state.active) {
        return null;
    }
    // Strict session isolation: only process state for matching session
    if (state.session_id !== sessionId) {
        return null;
    }
    // Check max iterations (safety limit)
    if (state.iteration >= state.max_iterations) {
        transitionPhase(workingDir, 'failed', sessionId);
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
    // ====================================================================
    // PIPELINE-AWARE ENFORCEMENT
    // If the state has pipeline tracking, use the pipeline orchestrator
    // for signal detection and stage transitions instead of legacy phases.
    // ====================================================================
    if (hasPipelineTracking(state)) {
        return checkPipelineAutopilot(state, sessionId, workingDir);
    }
    // ====================================================================
    // LEGACY ENFORCEMENT (pre-pipeline states)
    // ====================================================================
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
            }
            else if (state.phase === 'qa' && nextPhase === 'validation') {
                const result = transitionUltraQAToValidation(workingDir, sessionId);
                if (!result.success) {
                    return generateContinuationPrompt(state, workingDir, sessionId);
                }
            }
            else if (nextPhase === 'complete') {
                transitionToComplete(workingDir, sessionId);
                return {
                    shouldBlock: false,
                    message: `[AUTOPILOT COMPLETE] All phases finished successfully!`,
                    phase: 'complete'
                };
            }
            else {
                transitionPhase(workingDir, nextPhase, sessionId);
            }
            // Get new state and generate prompt for next phase
            const newState = readAutopilotState(workingDir, sessionId);
            if (newState) {
                return generateContinuationPrompt(newState, workingDir, sessionId);
            }
        }
    }
    // No signal detected - continue current phase
    return generateContinuationPrompt(state, workingDir, sessionId);
}
/**
 * Generate continuation prompt for current phase
 */
function generateContinuationPrompt(state, directory, sessionId) {
    // Read tool error before generating message
    const toolError = readLastToolError(directory);
    const errorGuidance = getToolErrorRetryGuidance(toolError);
    // Increment iteration
    state.iteration += 1;
    writeAutopilotState(directory, state, sessionId);
    const phasePrompt = getPhasePrompt(state.phase, {
        idea: state.originalIdea,
        specPath: state.expansion.spec_path || `${OmcPaths.AUTOPILOT}/spec.md`,
        planPath: state.planning.plan_path || `${OmcPaths.PLANS}/autopilot-impl.md`
    });
    const continuationPrompt = `<autopilot-continuation>
${errorGuidance ? errorGuidance + '\n' : ''}
[AUTOPILOT - PHASE: ${state.phase.toUpperCase()} | ITERATION ${state.iteration}/${state.max_iterations}]

Your previous response did not signal phase completion. Continue working on the current phase.

${phasePrompt}

IMPORTANT: When the phase is complete, output the appropriate signal:
- Expansion: EXPANSION_COMPLETE
- Planning: PLANNING_COMPLETE
- Execution: EXECUTION_COMPLETE
- QA: QA_COMPLETE
- Validation: VALIDATION_COMPLETE

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
            tasksTotal: state.execution.tasks_total,
            toolError: toolError || undefined
        }
    };
}
// ============================================================================
// PIPELINE-AWARE ENFORCEMENT
// ============================================================================
/**
 * Pipeline-aware enforcement for autopilot states that have pipeline tracking.
 * Uses the pipeline orchestrator for signal detection and stage transitions.
 */
function checkPipelineAutopilot(state, sessionId, directory) {
    const tracking = readPipelineTracking(state);
    if (!tracking)
        return null;
    const currentAdapter = getCurrentStageAdapter(tracking);
    if (!currentAdapter) {
        // No more stages — pipeline is complete
        return {
            shouldBlock: false,
            message: '[AUTOPILOT COMPLETE] All pipeline stages finished successfully!',
            phase: 'complete',
        };
    }
    // Check if the current stage's completion signal has been emitted
    const completionSignal = getCurrentCompletionSignal(tracking);
    if (completionSignal && sessionId && detectPipelineSignal(sessionId, completionSignal)) {
        // Current stage complete — advance to next stage
        const { adapter: nextAdapter, phase: nextPhase } = advanceStage(directory, sessionId);
        if (!nextAdapter || nextPhase === 'complete') {
            // Pipeline complete
            transitionPhase(directory, 'complete', sessionId);
            return {
                shouldBlock: false,
                message: '[AUTOPILOT COMPLETE] All pipeline stages finished successfully!',
                phase: 'complete',
            };
        }
        if (nextPhase === 'failed') {
            return {
                shouldBlock: false,
                message: '[AUTOPILOT FAILED] Pipeline stage transition failed.',
                phase: 'failed',
            };
        }
        // Generate transition + next stage prompt
        const transitionMsg = generateTransitionPrompt(currentAdapter.id, nextAdapter.id);
        // Re-read tracking to get updated state
        const updatedState = readAutopilotState(directory, sessionId);
        const updatedTracking = updatedState ? readPipelineTracking(updatedState) : null;
        const hudLine = updatedTracking ? formatPipelineHUD(updatedTracking) : '';
        const context = {
            idea: state.originalIdea,
            directory: state.project_path || directory,
            sessionId,
            specPath: state.expansion.spec_path || '.omc/autopilot/spec.md',
            planPath: state.planning.plan_path || '.omc/plans/autopilot-impl.md',
            config: tracking.pipelineConfig,
        };
        const stagePrompt = nextAdapter.getPrompt(context);
        return {
            shouldBlock: true,
            message: `<autopilot-pipeline-transition>
${hudLine}

${transitionMsg}

${stagePrompt}
</autopilot-pipeline-transition>

---

`,
            phase: state.phase,
            metadata: {
                iteration: state.iteration,
                maxIterations: state.max_iterations,
            },
        };
    }
    // No signal detected — continue current stage
    incrementStageIteration(directory, sessionId);
    const toolError = readLastToolError(directory);
    const errorGuidance = getToolErrorRetryGuidance(toolError);
    // Increment overall iteration
    state.iteration += 1;
    writeAutopilotState(directory, state, sessionId);
    const updatedTracking = readPipelineTracking(readAutopilotState(directory, sessionId));
    const hudLine = updatedTracking ? formatPipelineHUD(updatedTracking) : '';
    const context = {
        idea: state.originalIdea,
        directory: state.project_path || directory,
        sessionId,
        specPath: state.expansion.spec_path || '.omc/autopilot/spec.md',
        planPath: state.planning.plan_path || '.omc/plans/autopilot-impl.md',
        config: tracking.pipelineConfig,
    };
    const stagePrompt = currentAdapter.getPrompt(context);
    const continuationPrompt = `<autopilot-pipeline-continuation>
${errorGuidance ? errorGuidance + '\n' : ''}
${hudLine}

[AUTOPILOT PIPELINE - STAGE: ${currentAdapter.name.toUpperCase()} | ITERATION ${state.iteration}/${state.max_iterations}]

Your previous response did not signal stage completion. Continue working on the current stage.

${stagePrompt}

IMPORTANT: When this stage is complete, output the signal: ${currentAdapter.completionSignal}

</autopilot-pipeline-continuation>

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
            tasksTotal: state.execution.tasks_total,
            toolError: toolError || undefined,
        },
    };
}
/**
 * Detect a pipeline-specific signal in the session transcript.
 */
function detectPipelineSignal(sessionId, signal) {
    const claudeDir = getClaudeConfigDir();
    const possiblePaths = [
        join(claudeDir, 'sessions', sessionId, 'transcript.md'),
        join(claudeDir, 'sessions', sessionId, 'messages.json'),
        join(claudeDir, 'transcripts', `${sessionId}.md`),
    ];
    const pattern = new RegExp(signal, 'i');
    for (const transcriptPath of possiblePaths) {
        if (existsSync(transcriptPath)) {
            try {
                const content = readFileSync(transcriptPath, 'utf-8');
                if (pattern.test(content)) {
                    return true;
                }
            }
            catch {
                continue;
            }
        }
    }
    return false;
}
//# sourceMappingURL=enforcement.js.map