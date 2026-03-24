/**
 * Ralphthon Orchestrator
 *
 * Monitors the leader pane for idle/completion, injects tasks via tmux send-keys,
 * manages phase transitions (execution -> hardening), and implements failure recovery.
 *
 * Dual trigger: idle detection (30s) + periodic poll (2min).
 * Terminates after N consecutive hardening waves with no new issues.
 */

import { execFileSync } from 'child_process';
import {
  writeModeState,
  readModeState,
  clearModeStateFile,
} from '../lib/mode-state-io.js';
import {
  readRalphthonPrd,
  getRalphthonPrdStatus,
  formatTaskPrompt,
  formatHardeningTaskPrompt,
  formatHardeningGenerationPrompt,
} from './prd.js';
import type {
  RalphthonState,
  RalphthonPhase,
  RalphthonConfig,
  OrchestratorEventHandler,
} from './types.js';
import { RALPHTHON_DEFAULTS } from './types.js';

// ============================================================================
// State Management
// ============================================================================

const MODE_NAME = 'ralphthon';

/**
 * Read ralphthon state from disk
 */
export function readRalphthonState(
  directory: string,
  sessionId?: string,
): RalphthonState | null {
  const state = readModeState<RalphthonState>(MODE_NAME, directory, sessionId);
  if (state && sessionId && state.sessionId && state.sessionId !== sessionId) {
    return null;
  }
  return state;
}

/**
 * Write ralphthon state to disk
 */
export function writeRalphthonState(
  directory: string,
  state: RalphthonState,
  sessionId?: string,
): boolean {
  return writeModeState(
    MODE_NAME,
    state as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/**
 * Clear ralphthon state
 */
export function clearRalphthonState(
  directory: string,
  sessionId?: string,
): boolean {
  return clearModeStateFile(MODE_NAME, directory, sessionId);
}

// ============================================================================
// Tmux Interaction
// ============================================================================

/**
 * Check if a tmux pane is idle (no running foreground process).
 * Returns true if the pane's current command is a shell (bash/zsh/fish).
 */
export function isPaneIdle(paneId: string): boolean {
  try {
    const output = execFileSync(
      'tmux', ['display-message', '-t', paneId, '-p', '#{pane_current_command}'],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const shellNames = ['bash', 'zsh', 'fish', 'sh', 'dash'];
    return shellNames.includes(output);
  } catch {
    return false;
  }
}

/**
 * Check if a tmux pane exists
 */
export function paneExists(paneId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', paneId], { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send keys to a tmux pane (inject a command/prompt)
 */
export function sendKeysToPane(paneId: string, text: string): boolean {
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, text, 'Enter'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current content of a tmux pane
 */
export function capturePaneContent(paneId: string, lines = 50): string {
  try {
    return execFileSync(
      'tmux', ['capture-pane', '-t', paneId, '-p', '-S', `-${lines}`],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
  } catch {
    return '';
  }
}

// ============================================================================
// Idle Detection
// ============================================================================

/**
 * Detect if the leader pane has been idle for longer than the threshold.
 * Uses pane content analysis to detect completion patterns.
 */
export function detectLeaderIdle(
  paneId: string,
  state: RalphthonState,
  config: RalphthonConfig,
): { idle: boolean; durationMs: number } {
  const isIdle = isPaneIdle(paneId);

  if (!isIdle) {
    return { idle: false, durationMs: 0 };
  }

  const now = Date.now();

  if (!state.lastIdleDetectedAt) {
    // First idle detection — mark it but don't trigger yet
    return { idle: false, durationMs: 0 };
  }

  const idleSince = new Date(state.lastIdleDetectedAt).getTime();
  const durationMs = now - idleSince;

  return {
    idle: durationMs >= config.idleThresholdMs,
    durationMs,
  };
}

/**
 * Check pane content for completion signals
 */
export function detectCompletionSignal(paneId: string): boolean {
  const content = capturePaneContent(paneId, 20);

  const completionPatterns = [
    /all\s+(?:stories|tasks)\s+(?:are\s+)?(?:complete|done)/i,
    /ralphthon\s+complete/i,
    /hardening\s+complete/i,
    /no\s+(?:new\s+)?issues?\s+found/i,
  ];

  return completionPatterns.some(p => p.test(content));
}

// ============================================================================
// Orchestrator Core
// ============================================================================

export interface OrchestratorOptions {
  directory: string;
  sessionId?: string;
  config: RalphthonConfig;
  onEvent?: OrchestratorEventHandler;
}

/**
 * Initialize a new ralphthon orchestrator state
 */
export function initOrchestrator(
  directory: string,
  tmuxSession: string,
  leaderPaneId: string,
  prdPath: string,
  sessionId?: string,
  _config?: Partial<RalphthonConfig>,
): RalphthonState {
  const state: RalphthonState = {
    active: true,
    phase: 'execution',
    sessionId,
    projectPath: directory,
    prdPath,
    tmuxSession,
    leaderPaneId,
    startedAt: new Date().toISOString(),
    currentWave: 0,
    consecutiveCleanWaves: 0,
    tasksCompleted: 0,
    tasksSkipped: 0,
  };

  writeRalphthonState(directory, state, sessionId);
  return state;
}

/**
 * Determine the next action the orchestrator should take.
 * Returns a command string to inject, or null if no action needed.
 */
export function getNextAction(
  directory: string,
  sessionId?: string,
): { action: 'inject_task' | 'inject_hardening' | 'generate_hardening' | 'complete' | 'wait'; prompt?: string } {
  const state = readRalphthonState(directory, sessionId);
  if (!state || !state.active) {
    return { action: 'complete' };
  }

  const prd = readRalphthonPrd(directory);
  if (!prd) {
    return { action: 'wait' };
  }

  const status = getRalphthonPrdStatus(prd);
  const config = prd.config;

  switch (state.phase) {
    case 'execution': {
      if (status.allStoriesDone) {
        // Transition to hardening phase
        return { action: 'generate_hardening' };
      }

      if (status.nextTask) {
        return {
          action: 'inject_task',
          prompt: formatTaskPrompt(status.nextTask.storyId, status.nextTask.task),
        };
      }

      // All tasks in progress or failed, wait
      return { action: 'wait' };
    }

    case 'hardening': {
      // Check termination condition
      if (state.consecutiveCleanWaves >= config.cleanWavesForTermination) {
        return { action: 'complete' };
      }

      if (state.currentWave >= config.maxWaves) {
        return { action: 'complete' };
      }

      if (status.nextHardeningTask) {
        return {
          action: 'inject_hardening',
          prompt: formatHardeningTaskPrompt(status.nextHardeningTask),
        };
      }

      // All hardening tasks for current wave done — generate new wave
      if (status.allHardeningDone || status.totalHardeningTasks === 0) {
        return { action: 'generate_hardening' };
      }

      return { action: 'wait' };
    }

    case 'complete':
    case 'failed':
      return { action: 'complete' };

    case 'interview':
      return { action: 'wait' };

    default:
      return { action: 'wait' };
  }
}

/**
 * Transition the orchestrator to a new phase
 */
export function transitionPhase(
  directory: string,
  newPhase: RalphthonPhase,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): boolean {
  const state = readRalphthonState(directory, sessionId);
  if (!state) return false;

  const oldPhase = state.phase;
  state.phase = newPhase;

  if (newPhase === 'complete') {
    state.active = false;
  }

  const success = writeRalphthonState(directory, state, sessionId);

  if (success && onEvent) {
    onEvent({ type: 'phase_transition', from: oldPhase, to: newPhase });
  }

  return success;
}

/**
 * Start a new hardening wave
 */
export function startHardeningWave(
  directory: string,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): { wave: number; prompt: string } | null {
  const state = readRalphthonState(directory, sessionId);
  if (!state) return null;

  const prd = readRalphthonPrd(directory);
  if (!prd) return null;

  // Transition to hardening if not already
  if (state.phase !== 'hardening') {
    state.phase = 'hardening';
  }

  state.currentWave += 1;
  writeRalphthonState(directory, state, sessionId);

  if (onEvent) {
    onEvent({ type: 'hardening_wave_start', wave: state.currentWave });
  }

  return {
    wave: state.currentWave,
    prompt: formatHardeningGenerationPrompt(state.currentWave, prd),
  };
}

/**
 * End a hardening wave and check if new issues were found
 */
export function endHardeningWave(
  directory: string,
  newIssueCount: number,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): { shouldTerminate: boolean } {
  const state = readRalphthonState(directory, sessionId);
  if (!state) return { shouldTerminate: true };

  const prd = readRalphthonPrd(directory);
  if (!prd) return { shouldTerminate: true };

  if (newIssueCount === 0) {
    state.consecutiveCleanWaves += 1;
  } else {
    state.consecutiveCleanWaves = 0;
  }

  writeRalphthonState(directory, state, sessionId);

  if (onEvent) {
    onEvent({ type: 'hardening_wave_end', wave: state.currentWave, newIssues: newIssueCount });
  }

  const shouldTerminate =
    state.consecutiveCleanWaves >= prd.config.cleanWavesForTermination ||
    state.currentWave >= prd.config.maxWaves;

  return { shouldTerminate };
}

/**
 * Record a task completion
 */
export function recordTaskCompletion(
  directory: string,
  taskId: string,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): boolean {
  const state = readRalphthonState(directory, sessionId);
  if (!state) return false;

  state.tasksCompleted += 1;
  state.currentTaskId = undefined;
  const success = writeRalphthonState(directory, state, sessionId);

  if (success && onEvent) {
    onEvent({ type: 'task_completed', taskId });
  }

  return success;
}

/**
 * Record a task skip (after max retries)
 */
export function recordTaskSkip(
  directory: string,
  taskId: string,
  reason: string,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): boolean {
  const state = readRalphthonState(directory, sessionId);
  if (!state) return false;

  state.tasksSkipped += 1;
  state.currentTaskId = undefined;
  const success = writeRalphthonState(directory, state, sessionId);

  if (success && onEvent) {
    onEvent({ type: 'task_skipped', taskId, reason });
  }

  return success;
}

/**
 * Execute one orchestrator tick.
 * This is the main loop body — called by the poll interval and idle detector.
 *
 * Returns true if an action was taken, false if waiting.
 */
export function orchestratorTick(
  directory: string,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): boolean {
  const state = readRalphthonState(directory, sessionId);
  if (!state || !state.active) return false;

  const prd = readRalphthonPrd(directory);
  if (!prd) return false;

  // Check if leader pane still exists
  if (!paneExists(state.leaderPaneId)) {
    transitionPhase(directory, 'failed', sessionId, onEvent);
    if (onEvent) {
      onEvent({ type: 'error', message: 'Leader pane no longer exists' });
    }
    return false;
  }

  // Get next action
  const next = getNextAction(directory, sessionId);

  switch (next.action) {
    case 'inject_task':
    case 'inject_hardening': {
      if (!next.prompt) return false;

      // Check if pane is idle before injecting
      if (!isPaneIdle(state.leaderPaneId)) {
        return false; // Leader is busy, wait
      }

      const sent = sendKeysToPane(state.leaderPaneId, next.prompt);
      if (sent) {
        // Update state with current task
        state.lastPollAt = new Date().toISOString();
        state.lastIdleDetectedAt = undefined; // Reset idle tracking
        writeRalphthonState(directory, state, sessionId);

        if (onEvent) {
          onEvent({
            type: 'task_injected',
            taskId: 'current',
            taskTitle: next.prompt.slice(0, 80),
          });
        }
      }
      return sent;
    }

    case 'generate_hardening': {
      // Transition to hardening and inject generation prompt
      const wave = startHardeningWave(directory, sessionId, onEvent);
      if (!wave) return false;

      if (!isPaneIdle(state.leaderPaneId)) {
        return false;
      }

      return sendKeysToPane(state.leaderPaneId, wave.prompt);
    }

    case 'complete': {
      transitionPhase(directory, 'complete', sessionId, onEvent);
      if (onEvent) {
        onEvent({
          type: 'session_complete',
          tasksCompleted: state.tasksCompleted,
          tasksSkipped: state.tasksSkipped,
        });
      }
      return true;
    }

    case 'wait':
    default:
      return false;
  }
}

// ============================================================================
// Orchestrator Run Loop
// ============================================================================

/**
 * Start the orchestrator run loop.
 * Runs until the session is complete or cancelled.
 *
 * This is an async function that uses setInterval for polling
 * and returns a cleanup function.
 */
export function startOrchestratorLoop(
  directory: string,
  sessionId?: string,
  onEvent?: OrchestratorEventHandler,
): { stop: () => void } {
  const state = readRalphthonState(directory, sessionId);
  if (!state) {
    return { stop: () => {} };
  }

  const prd = readRalphthonPrd(directory);
  const config = prd?.config ?? RALPHTHON_DEFAULTS;

  let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;

    const currentState = readRalphthonState(directory, sessionId);
    if (!currentState || !currentState.active) {
      stop();
      return;
    }

    orchestratorTick(directory, sessionId, onEvent);
  };

  const idleCheck = () => {
    if (stopped) return;

    const currentState = readRalphthonState(directory, sessionId);
    if (!currentState || !currentState.active) {
      stop();
      return;
    }

    const idleResult = detectLeaderIdle(
      currentState.leaderPaneId,
      currentState,
      config,
    );

    if (isPaneIdle(currentState.leaderPaneId)) {
      if (!currentState.lastIdleDetectedAt) {
        currentState.lastIdleDetectedAt = new Date().toISOString();
        writeRalphthonState(directory, currentState, sessionId);
      }
    } else {
      if (currentState.lastIdleDetectedAt) {
        currentState.lastIdleDetectedAt = undefined;
        writeRalphthonState(directory, currentState, sessionId);
      }
    }

    if (idleResult.idle) {
      if (onEvent) {
        onEvent({ type: 'idle_detected', durationMs: idleResult.durationMs });
      }
      // Trigger a tick on idle detection
      tick();
    }
  };

  const stop = () => {
    stopped = true;
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (pollInterval) clearInterval(pollInterval);
  };

  // Idle detection: check every 5 seconds for 30s threshold
  idleCheckInterval = setInterval(idleCheck, 5000);

  // Periodic poll
  pollInterval = setInterval(tick, config.pollIntervalMs);

  // Run first tick immediately
  tick();

  return { stop };
}
