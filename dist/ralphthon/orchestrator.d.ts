/**
 * Ralphthon Orchestrator
 *
 * Monitors the leader pane for idle/completion, injects tasks via tmux send-keys,
 * manages phase transitions (execution -> hardening), and implements failure recovery.
 *
 * Dual trigger: idle detection (30s) + periodic poll (2min).
 * Terminates after N consecutive hardening waves with no new issues.
 */
import type { RalphthonState, RalphthonPhase, RalphthonConfig, OrchestratorEventHandler } from './types.js';
/**
 * Read ralphthon state from disk
 */
export declare function readRalphthonState(directory: string, sessionId?: string): RalphthonState | null;
/**
 * Write ralphthon state to disk
 */
export declare function writeRalphthonState(directory: string, state: RalphthonState, sessionId?: string): boolean;
/**
 * Clear ralphthon state
 */
export declare function clearRalphthonState(directory: string, sessionId?: string): boolean;
/**
 * Check if a tmux pane is idle (no running foreground process).
 * Returns true if the pane's current command is a shell (bash/zsh/fish).
 */
export declare function isPaneIdle(paneId: string): boolean;
/**
 * Check if a tmux pane exists
 */
export declare function paneExists(paneId: string): boolean;
/**
 * Send keys to a tmux pane (inject a command/prompt)
 */
export declare function sendKeysToPane(paneId: string, text: string): boolean;
/**
 * Capture the current content of a tmux pane
 */
export declare function capturePaneContent(paneId: string, lines?: number): string;
/**
 * Detect if the leader pane has been idle for longer than the threshold.
 * Uses pane content analysis to detect completion patterns.
 */
export declare function detectLeaderIdle(paneId: string, state: RalphthonState, config: RalphthonConfig): {
    idle: boolean;
    durationMs: number;
};
/**
 * Check pane content for completion signals
 */
export declare function detectCompletionSignal(paneId: string): boolean;
export interface OrchestratorOptions {
    directory: string;
    sessionId?: string;
    config: RalphthonConfig;
    onEvent?: OrchestratorEventHandler;
}
/**
 * Initialize a new ralphthon orchestrator state
 */
export declare function initOrchestrator(directory: string, tmuxSession: string, leaderPaneId: string, prdPath: string, sessionId?: string, _config?: Partial<RalphthonConfig>): RalphthonState;
/**
 * Determine the next action the orchestrator should take.
 * Returns a command string to inject, or null if no action needed.
 */
export declare function getNextAction(directory: string, sessionId?: string): {
    action: 'inject_task' | 'inject_hardening' | 'generate_hardening' | 'complete' | 'wait';
    prompt?: string;
};
/**
 * Transition the orchestrator to a new phase
 */
export declare function transitionPhase(directory: string, newPhase: RalphthonPhase, sessionId?: string, onEvent?: OrchestratorEventHandler): boolean;
/**
 * Start a new hardening wave
 */
export declare function startHardeningWave(directory: string, sessionId?: string, onEvent?: OrchestratorEventHandler): {
    wave: number;
    prompt: string;
} | null;
/**
 * End a hardening wave and check if new issues were found
 */
export declare function endHardeningWave(directory: string, newIssueCount: number, sessionId?: string, onEvent?: OrchestratorEventHandler): {
    shouldTerminate: boolean;
};
/**
 * Record a task completion
 */
export declare function recordTaskCompletion(directory: string, taskId: string, sessionId?: string, onEvent?: OrchestratorEventHandler): boolean;
/**
 * Record a task skip (after max retries)
 */
export declare function recordTaskSkip(directory: string, taskId: string, reason: string, sessionId?: string, onEvent?: OrchestratorEventHandler): boolean;
/**
 * Execute one orchestrator tick.
 * This is the main loop body — called by the poll interval and idle detector.
 *
 * Returns true if an action was taken, false if waiting.
 */
export declare function orchestratorTick(directory: string, sessionId?: string, onEvent?: OrchestratorEventHandler): boolean;
/**
 * Start the orchestrator run loop.
 * Runs until the session is complete or cancelled.
 *
 * This is an async function that uses setInterval for polling
 * and returns a cleanup function.
 */
export declare function startOrchestratorLoop(directory: string, sessionId?: string, onEvent?: OrchestratorEventHandler): {
    stop: () => void;
};
//# sourceMappingURL=orchestrator.d.ts.map