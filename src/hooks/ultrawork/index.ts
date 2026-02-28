/**
 * Ultrawork State Management
 *
 * Manages persistent ultrawork mode state across sessions.
 * When ultrawork is activated and todos remain incomplete,
 * this module ensures the mode persists until all work is done.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { writeModeState, readModeState } from '../../lib/mode-state-io.js';
import { resolveStatePath, resolveSessionStatePath } from '../../lib/worktree-paths.js';

export interface UltraworkState {
  /** Whether ultrawork mode is currently active */
  active: boolean;
  /** When ultrawork was activated */
  started_at: string;
  /** The original prompt that triggered ultrawork */
  original_prompt: string;
  /** Session ID the mode is bound to */
  session_id?: string;
  /** Project path for isolation */
  project_path?: string;
  /** Number of times the mode has been reinforced (for metrics) */
  reinforcement_count: number;
  /** Last time the mode was checked/reinforced */
  last_checked_at: string;
  /** Whether this ultrawork session is linked to a ralph-loop session */
  linked_to_ralph?: boolean;
}

const _DEFAULT_STATE: UltraworkState = {
  active: false,
  started_at: '',
  original_prompt: '',
  reinforcement_count: 0,
  last_checked_at: ''
};

/**
 * Get the state file path for Ultrawork (used only by deactivateUltrawork for ghost-legacy cleanup)
 */
function getStateFilePath(directory?: string, sessionId?: string): string {
  const baseDir = directory || process.cwd();
  if (sessionId) {
    return resolveSessionStatePath('ultrawork', sessionId, baseDir);
  }
  return resolveStatePath('ultrawork', baseDir);
}


/**
 * Read Ultrawork state from disk (local only)
 *
 * When sessionId is provided, ONLY reads session-scoped file — no legacy fallback.
 * This prevents cross-session state leakage.
 */
export function readUltraworkState(directory?: string, sessionId?: string): UltraworkState | null {
  const state = readModeState<UltraworkState>('ultrawork', directory, sessionId);

  // Validate session identity: state must belong to this session
  if (state && sessionId && state.session_id && state.session_id !== sessionId) {
    return null;
  }

  return state;
}

/**
 * Write Ultrawork state to disk (local only)
 */
export function writeUltraworkState(state: UltraworkState, directory?: string, sessionId?: string): boolean {
  return writeModeState('ultrawork', state as unknown as Record<string, unknown>, directory, sessionId);
}

/**
 * Activate ultrawork mode
 */
export function activateUltrawork(
  prompt: string,
  sessionId?: string,
  directory?: string,
  linkedToRalph?: boolean
): boolean {
  const state: UltraworkState = {
    active: true,
    started_at: new Date().toISOString(),
    original_prompt: prompt,
    session_id: sessionId,
    project_path: directory || process.cwd(),
    reinforcement_count: 0,
    last_checked_at: new Date().toISOString(),
    linked_to_ralph: linkedToRalph
  };

  return writeUltraworkState(state, directory, sessionId);
}

/**
 * Deactivate ultrawork mode
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped state file
 * 2. Cleans up ghost legacy files that belong to this session (or have no session_id)
 *    to prevent stale legacy files from leaking into other sessions.
 */
export function deactivateUltrawork(directory?: string, sessionId?: string): boolean {
  let success = true;

  // Delete session-scoped state file
  const stateFile = getStateFilePath(directory, sessionId);
  if (existsSync(stateFile)) {
    try {
      unlinkSync(stateFile);
    } catch {
      success = false;
    }
  }

  // Ghost legacy cleanup: if sessionId provided, also remove legacy file
  // if it belongs to this session or has no session_id (orphaned)
  if (sessionId) {
    const legacyFile = getStateFilePath(directory); // no sessionId = legacy path
    if (existsSync(legacyFile)) {
      try {
        const content = readFileSync(legacyFile, 'utf-8');
        const legacyState = JSON.parse(content);

        // Only remove if it belongs to this session or is unowned (no session_id)
        if (!legacyState.session_id || legacyState.session_id === sessionId) {
          unlinkSync(legacyFile);
        }
        // Do NOT delete another session's legacy data
      } catch {
        // If we can't read/parse, leave it alone
      }
    }
  }

  return success;
}

/**
 * Increment reinforcement count (called when mode is reinforced on stop)
 */
export function incrementReinforcement(directory?: string, sessionId?: string): UltraworkState | null {
  const state = readUltraworkState(directory, sessionId);

  if (!state || !state.active) {
    return null;
  }

  state.reinforcement_count += 1;
  state.last_checked_at = new Date().toISOString();

  if (writeUltraworkState(state, directory, sessionId)) {
    return state;
  }

  return null;
}

/**
 * Check if ultrawork should be reinforced (active with pending todos)
 */
export function shouldReinforceUltrawork(
  sessionId?: string,
  directory?: string
): boolean {
  const state = readUltraworkState(directory, sessionId);

  if (!state || !state.active) {
    return false;
  }

  // Strict session isolation: state must match the requesting session
  // Both must be defined and equal - prevent cross-session contamination
  // when both are undefined (Bug #5 fix)
  if (!state.session_id || !sessionId || state.session_id !== sessionId) {
    return false;
  }

  return true;
}

/**
 * Get ultrawork persistence message for injection
 */
export function getUltraworkPersistenceMessage(state: UltraworkState): string {
  return `<ultrawork-persistence>

[ULTRAWORK MODE STILL ACTIVE - Reinforcement #${state.reinforcement_count + 1}]

Your ultrawork session is NOT complete. Incomplete todos remain.

REMEMBER THE ULTRAWORK RULES:
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent)
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each
- **VERIFY**: Check ALL requirements met before done
- **NO Premature Stopping**: ALL TODOs must be complete

Continue working on the next pending task. DO NOT STOP until all tasks are marked complete.

Original task: ${state.original_prompt}

</ultrawork-persistence>

---

`;
}

/**
 * Create an Ultrawork State hook instance
 */
export function createUltraworkStateHook(directory: string) {
  return {
    activate: (prompt: string, sessionId?: string) =>
      activateUltrawork(prompt, sessionId, directory),
    deactivate: (sessionId?: string) => deactivateUltrawork(directory, sessionId),
    getState: (sessionId?: string) => readUltraworkState(directory, sessionId),
    shouldReinforce: (sessionId?: string) =>
      shouldReinforceUltrawork(sessionId, directory),
    incrementReinforcement: (sessionId?: string) => incrementReinforcement(directory, sessionId)
  };
}
