/**
 * UltraQA Loop Hook
 *
 * QA cycling workflow that runs test → architect verify → fix → repeat
 * until the QA goal is met or max cycles reached.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readRalphState } from '../ralph/index.js';
import { resolveSessionStatePath, ensureSessionStateDir } from '../../lib/worktree-paths.js';

export type UltraQAGoalType = 'tests' | 'build' | 'lint' | 'typecheck' | 'custom';

export interface UltraQAState {
  /** Whether the loop is currently active */
  active: boolean;
  /** Type of QA goal */
  goal_type: UltraQAGoalType;
  /** Custom pattern to match (for custom goal type) */
  goal_pattern: string | null;
  /** Current cycle number */
  cycle: number;
  /** Maximum cycles before stopping */
  max_cycles: number;
  /** Array of failure descriptions for pattern detection */
  failures: string[];
  /** When the loop started */
  started_at: string;
  /** Session ID the loop is bound to */
  session_id?: string;
  /** Project path for isolation */
  project_path?: string;
}

export interface UltraQAOptions {
  /** Maximum cycles (default: 5) */
  maxCycles?: number;
  /** Custom pattern for custom goal type */
  customPattern?: string;
}

export interface UltraQAResult {
  /** Whether the goal was met */
  success: boolean;
  /** Number of cycles taken */
  cycles: number;
  /** Reason for exit */
  reason: 'goal_met' | 'max_cycles' | 'same_failure' | 'env_error' | 'cancelled';
  /** Diagnosis message if failed */
  diagnosis?: string;
}

const DEFAULT_MAX_CYCLES = 5;
const SAME_FAILURE_THRESHOLD = 3;

/**
 * Get the state file path for UltraQA
 */
function getStateFilePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('ultraqa', sessionId, directory);
  }
  const omcDir = join(directory, '.omc');
  return join(omcDir, 'state', 'ultraqa-state.json');
}

/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory: string, sessionId?: string): void {
  if (sessionId) {
    ensureSessionStateDir(sessionId, directory);
    return;
  }
  const stateDir = join(directory, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Read UltraQA state from disk
 */
export function readUltraQAState(directory: string, sessionId?: string): UltraQAState | null {
  // When sessionId is provided, ONLY check session-scoped path — no legacy fallback
  if (sessionId) {
    const sessionFile = getStateFilePath(directory, sessionId);
    if (!existsSync(sessionFile)) {
      return null;
    }
    try {
      const content = readFileSync(sessionFile, 'utf-8');
      const state: UltraQAState = JSON.parse(content);
      // Validate session identity
      if (state.session_id && state.session_id !== sessionId) {
        return null;
      }
      return state;
    } catch {
      return null; // NO legacy fallback
    }
  }

  // No sessionId: legacy path (backward compat)
  const stateFile = getStateFilePath(directory);
  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write UltraQA state to disk
 */
export function writeUltraQAState(directory: string, state: UltraQAState, sessionId?: string): boolean {
  try {
    ensureStateDir(directory, sessionId);
    const stateFile = getStateFilePath(directory, sessionId);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear UltraQA state
 */
export function clearUltraQAState(directory: string, sessionId?: string): boolean {
  const stateFile = getStateFilePath(directory, sessionId);

  if (!existsSync(stateFile)) {
    return true;
  }

  try {
    unlinkSync(stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Ralph Loop is active (mutual exclusion check)
 */
export function isRalphLoopActive(directory: string, sessionId?: string): boolean {
  const ralphState = readRalphState(directory, sessionId);
  return ralphState !== null && ralphState.active === true;
}

/**
 * Start a new UltraQA cycle
 * Returns false if Ralph Loop is already active (mutual exclusion)
 */
export function startUltraQA(
  directory: string,
  goalType: UltraQAGoalType,
  sessionId: string,
  options?: UltraQAOptions
): { success: boolean; error?: string } {
  // Mutual exclusion check: cannot start UltraQA if Ralph Loop is active
  if (isRalphLoopActive(directory, sessionId)) {
    return {
      success: false,
      error: 'Cannot start UltraQA while Ralph Loop is active. Cancel Ralph Loop first with /oh-my-claudecode:cancel.'
    };
  }

  const state: UltraQAState = {
    active: true,
    goal_type: goalType,
    goal_pattern: options?.customPattern ?? null,
    cycle: 1,
    max_cycles: options?.maxCycles ?? DEFAULT_MAX_CYCLES,
    failures: [],
    started_at: new Date().toISOString(),
    session_id: sessionId,
    project_path: directory
  };

  const written = writeUltraQAState(directory, state, sessionId);
  return { success: written };
}

/**
 * Record a failure and increment cycle
 */
export function recordFailure(
  directory: string,
  failureDescription: string,
  sessionId?: string
): { state: UltraQAState | null; shouldExit: boolean; reason?: string } {
  const state = readUltraQAState(directory, sessionId);

  if (!state || !state.active) {
    return { state: null, shouldExit: true, reason: 'not_active' };
  }

  // Add failure to array
  state.failures.push(failureDescription);

  // Check for repeated same failure
  const recentFailures = state.failures.slice(-SAME_FAILURE_THRESHOLD);
  if (recentFailures.length >= SAME_FAILURE_THRESHOLD) {
    const allSame = recentFailures.every(f => normalizeFailure(f) === normalizeFailure(recentFailures[0]));
    if (allSame) {
      return {
        state,
        shouldExit: true,
        reason: `Same failure detected ${SAME_FAILURE_THRESHOLD} times: ${recentFailures[0]}`
      };
    }
  }

  // Increment cycle
  state.cycle += 1;

  // Check max cycles
  if (state.cycle > state.max_cycles) {
    return {
      state,
      shouldExit: true,
      reason: `Max cycles (${state.max_cycles}) reached`
    };
  }

  writeUltraQAState(directory, state, sessionId);
  return { state, shouldExit: false };
}

/**
 * Mark UltraQA as successful
 */
export function completeUltraQA(directory: string, sessionId?: string): UltraQAResult | null {
  const state = readUltraQAState(directory, sessionId);

  if (!state) {
    return null;
  }

  const result: UltraQAResult = {
    success: true,
    cycles: state.cycle,
    reason: 'goal_met'
  };

  clearUltraQAState(directory, sessionId);
  return result;
}

/**
 * Stop UltraQA with failure
 */
export function stopUltraQA(
  directory: string,
  reason: 'max_cycles' | 'same_failure' | 'env_error',
  diagnosis: string,
  sessionId?: string
): UltraQAResult | null {
  const state = readUltraQAState(directory, sessionId);

  if (!state) {
    return null;
  }

  const result: UltraQAResult = {
    success: false,
    cycles: state.cycle,
    reason,
    diagnosis
  };

  clearUltraQAState(directory, sessionId);
  return result;
}

/**
 * Cancel UltraQA
 */
export function cancelUltraQA(directory: string, sessionId?: string): boolean {
  return clearUltraQAState(directory, sessionId);
}

/**
 * Normalize failure description for comparison
 */
function normalizeFailure(failure: string): string {
  // Remove timestamps, line numbers, and other variable parts
  return failure
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '') // ISO timestamps
    .replace(/:\d+:\d+/g, '') // line:col numbers
    .replace(/\d+ms/g, '') // timing
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Get goal command based on goal type
 */
export function getGoalCommand(goalType: UltraQAGoalType): string {
  switch (goalType) {
    case 'tests':
      return '# Run the project test command (e.g., npm test, pytest, go test ./..., cargo test)';
    case 'build':
      return '# Run the project build command (e.g., npm run build, go build ./..., cargo build)';
    case 'lint':
      return '# Run the project lint command (e.g., npm run lint, ruff check ., golangci-lint run)';
    case 'typecheck':
      return '# Run the project type check command (e.g., tsc --noEmit, mypy ., cargo check)';
    case 'custom':
      return '# Custom command based on goal pattern';
  }
}

/**
 * Format progress message
 */
export function formatProgressMessage(
  cycle: number,
  maxCycles: number,
  status: string
): string {
  return `[ULTRAQA Cycle ${cycle}/${maxCycles}] ${status}`;
}
