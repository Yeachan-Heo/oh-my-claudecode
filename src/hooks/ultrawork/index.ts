/**
 * Ultrawork State Management
 *
 * Manages persistent ultrawork mode state across sessions.
 * When ultrawork is activated and todos remain incomplete,
 * this module ensures the mode persists until all work is done.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

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
 * Get the state file path for Ultrawork
 */
function getStateFilePath(directory?: string): string {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');
  return join(omcDir, 'state', 'ultrawork-state.json');
}


/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory?: string): void {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc', 'state');
  if (!existsSync(omcDir)) {
    mkdirSync(omcDir, { recursive: true });
  }
}


/**
 * Read Ultrawork state from disk (local only)
 */
export function readUltraworkState(directory?: string): UltraworkState | null {
  const localStateFile = getStateFilePath(directory);
  if (existsSync(localStateFile)) {
    try {
      const content = readFileSync(localStateFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[ultrawork] Failed to read state file:', error);
      return null;
    }
  }

  return null;
}

/**
 * Write Ultrawork state to disk (local only)
 */
export function writeUltraworkState(state: UltraworkState, directory?: string): boolean {
  try {
    ensureStateDir(directory);
    const localStateFile = getStateFilePath(directory);
    writeFileSync(localStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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

  return writeUltraworkState(state, directory);
}

/**
 * Deactivate ultrawork mode
 */
export function deactivateUltrawork(directory?: string): boolean {
  const localStateFile = getStateFilePath(directory);
  if (existsSync(localStateFile)) {
    try {
      unlinkSync(localStateFile);
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Increment reinforcement count (called when mode is reinforced on stop)
 */
export function incrementReinforcement(directory?: string): UltraworkState | null {
  const state = readUltraworkState(directory);

  if (!state || !state.active) {
    return null;
  }

  state.reinforcement_count += 1;
  state.last_checked_at = new Date().toISOString();

  if (writeUltraworkState(state, directory)) {
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
  const state = readUltraworkState(directory);

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
    deactivate: () => deactivateUltrawork(directory),
    getState: () => readUltraworkState(directory),
    shouldReinforce: (sessionId?: string) =>
      shouldReinforceUltrawork(sessionId, directory),
    incrementReinforcement: () => incrementReinforcement(directory)
  };
}
