/**
 * Ralph Hook
 *
 * Self-referential work loop that continues until cancelled via /oh-my-claudecode:cancel.
 * Named after the character who keeps working until the job is done.
 *
 * Enhanced with PRD (Product Requirements Document) support for structured task tracking.
 * When a prd.json exists, completion is based on all stories having passes: true.
 *
 * Ported from oh-my-opencode's ralph hook.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import {
  readPrd,
  getPrdStatus,
  formatNextStoryPrompt,
  formatPrdStatus,
  type PRDStatus,
  type UserStory,
} from "./prd.js";
import {
  getProgressContext,
  appendProgress,
  initProgress,
  addPattern,
} from "./progress.js";
import {
  UltraworkState,
  readUltraworkState as readUltraworkStateFromModule,
  writeUltraworkState as writeUltraworkStateFromModule,
} from "../ultrawork/index.js";
import { resolveSessionStatePath, ensureSessionStateDir, getOmcRoot } from "../../lib/worktree-paths.js";
import { readTeamPipelineState } from "../team-pipeline/state.js";
import type { TeamPipelinePhase } from "../team-pipeline/types.js";

// Forward declaration to avoid circular import - check ultraqa state file directly
export function isUltraQAActive(directory: string, sessionId?: string): boolean {
  // When sessionId is provided, ONLY check session-scoped path — no legacy fallback
  if (sessionId) {
    const sessionFile = resolveSessionStatePath('ultraqa', sessionId, directory);
    if (!existsSync(sessionFile)) {
      return false;
    }
    try {
      const content = readFileSync(sessionFile, "utf-8");
      const state = JSON.parse(content);
      return state && state.active === true;
    } catch {
      return false; // NO legacy fallback
    }
  }

  // No sessionId: legacy path (backward compat)
  const omcDir = getOmcRoot(directory);
  const stateFile = join(omcDir, "state", "ultraqa-state.json");
  if (!existsSync(stateFile)) {
    return false;
  }
  try {
    const content = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(content);
    return state && state.active === true;
  } catch {
    return false;
  }
}

export interface RalphLoopState {
  /** Whether the loop is currently active */
  active: boolean;
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations before stopping */
  max_iterations: number;
  /** When the loop started */
  started_at: string;
  /** The original prompt/task */
  prompt: string;
  /** Session ID the loop is bound to */
  session_id?: string;
  /** Project path for isolation */
  project_path?: string;
  /** Whether PRD mode is active */
  prd_mode?: boolean;
  /** Current story being worked on */
  current_story_id?: string;
  /** Whether ultrawork is linked/auto-activated with ralph */
  linked_ultrawork?: boolean;
}

export interface RalphLoopOptions {
  /** Maximum iterations (default: 10) */
  maxIterations?: number;
  /** Disable auto-activation of ultrawork (default: false - ultrawork is enabled) */
  disableUltrawork?: boolean;
}

export interface RalphLoopHook {
  startLoop: (
    sessionId: string | undefined,
    prompt: string,
    options?: RalphLoopOptions,
  ) => boolean;
  cancelLoop: (sessionId: string) => boolean;
  getState: () => RalphLoopState | null;
}

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Get the state file path for Ralph Loop
 */
function getStateFilePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('ralph', sessionId, directory);
  }
  const omcDir = getOmcRoot(directory);
  return join(omcDir, "state", "ralph-state.json");
}

/**
 * Ensure the .omc directory exists
 */
function ensureStateDir(directory: string, sessionId?: string): void {
  if (sessionId) {
    ensureSessionStateDir(sessionId, directory);
    return;
  }
  const stateDir = join(getOmcRoot(directory), "state");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Read Ralph Loop state from disk
 */
export function readRalphState(directory: string, sessionId?: string): RalphLoopState | null {
  // When sessionId is provided, ONLY check session-scoped path — no legacy fallback
  if (sessionId) {
    const sessionFile = getStateFilePath(directory, sessionId);
    if (!existsSync(sessionFile)) {
      return null;
    }
    try {
      const content = readFileSync(sessionFile, "utf-8");
      const state: RalphLoopState = JSON.parse(content);
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
    const content = readFileSync(stateFile, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[ralph] Failed to read state file:", error);
    return null;
  }
}

/**
 * Write Ralph Loop state to disk
 */
export function writeRalphState(
  directory: string,
  state: RalphLoopState,
  sessionId?: string
): boolean {
  try {
    ensureStateDir(directory, sessionId);
    const stateFile = getStateFilePath(directory, sessionId);
    writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear Ralph Loop state
 */
export function clearRalphState(directory: string, sessionId?: string): boolean {
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
 * Clear ultrawork state (only if linked to ralph)
 */
export function clearLinkedUltraworkState(directory: string, sessionId?: string): boolean {
  const state = readUltraworkStateFromModule(directory, sessionId);

  // Only clear if it was linked to ralph (auto-activated)
  if (!state || !state.linked_to_ralph) {
    return true;
  }

  // Try session-scoped path first
  if (sessionId) {
    const sessionFile = resolveSessionStatePath('ultrawork', sessionId, directory);
    if (existsSync(sessionFile)) {
      try {
        unlinkSync(sessionFile);
        return true;
      } catch {
        return false;
      }
    }
  }

  // Fallback to legacy path
  const omcDir = getOmcRoot(directory);
  const stateFile = join(omcDir, "state", "ultrawork-state.json");
  try {
    unlinkSync(stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment Ralph Loop iteration
 */
export function incrementRalphIteration(
  directory: string,
  sessionId?: string
): RalphLoopState | null {
  const state = readRalphState(directory, sessionId);

  if (!state || !state.active) {
    return null;
  }

  state.iteration += 1;

  if (writeRalphState(directory, state, sessionId)) {
    return state;
  }

  return null;
}

/**
 * Create a Ralph Loop hook instance
 */
export function createRalphLoopHook(directory: string): RalphLoopHook {
  const startLoop = (
    sessionId: string | undefined,
    prompt: string,
    options?: RalphLoopOptions,
  ): boolean => {
    // Mutual exclusion check: cannot start Ralph Loop if UltraQA is active
    if (isUltraQAActive(directory, sessionId)) {
      console.error(
        "Cannot start Ralph Loop while UltraQA is active. Cancel UltraQA first with /oh-my-claudecode:cancel.",
      );
      return false;
    }

    const enableUltrawork = !options?.disableUltrawork;
    const now = new Date().toISOString();

    const state: RalphLoopState = {
      active: true,
      iteration: 1,
      max_iterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      started_at: now,
      prompt,
      session_id: sessionId,
      project_path: directory,
      linked_ultrawork: enableUltrawork,
    };

    const ralphSuccess = writeRalphState(directory, state, sessionId);

    // Auto-activate ultrawork (linked to ralph) by default
    // Include session_id and project_path for proper isolation
    if (ralphSuccess && enableUltrawork) {
      const ultraworkState: UltraworkState = {
        active: true,
        reinforcement_count: 0,
        original_prompt: prompt,
        started_at: now,
        last_checked_at: now,
        linked_to_ralph: true,
        session_id: sessionId,
        project_path: directory,
      };
      writeUltraworkStateFromModule(ultraworkState, directory, sessionId);
    }

    return ralphSuccess;
  };

  const cancelLoop = (sessionId: string): boolean => {
    const state = readRalphState(directory, sessionId);

    if (!state || state.session_id !== sessionId) {
      return false;
    }

    // Also clear linked ultrawork state if it was auto-activated
    if (state.linked_ultrawork) {
      clearLinkedUltraworkState(directory, sessionId);
    }

    return clearRalphState(directory, sessionId);
  };

  const getState = (sessionId?: string): RalphLoopState | null => {
    return readRalphState(directory, sessionId);
  };

  return {
    startLoop,
    cancelLoop,
    getState,
  };
}

// ============================================================================
// PRD Integration
// ============================================================================

/**
 * Check if PRD mode is available (prd.json exists)
 */
export function hasPrd(directory: string): boolean {
  const prd = readPrd(directory);
  return prd !== null;
}

/**
 * Get PRD completion status for ralph
 */
export function getPrdCompletionStatus(directory: string): {
  hasPrd: boolean;
  allComplete: boolean;
  status: PRDStatus | null;
  nextStory: UserStory | null;
} {
  const prd = readPrd(directory);

  if (!prd) {
    return {
      hasPrd: false,
      allComplete: false,
      status: null,
      nextStory: null,
    };
  }

  const status = getPrdStatus(prd);

  return {
    hasPrd: true,
    allComplete: status.allComplete,
    status,
    nextStory: status.nextStory,
  };
}

/**
 * Get context injection for ralph continuation
 * Includes PRD current story and progress memory
 */
export function getRalphContext(directory: string): string {
  const parts: string[] = [];

  // Add progress context (patterns, learnings)
  const progressContext = getProgressContext(directory);
  if (progressContext) {
    parts.push(progressContext);
  }

  // Add current story from PRD
  const prdStatus = getPrdCompletionStatus(directory);
  if (prdStatus.hasPrd && prdStatus.nextStory) {
    parts.push(formatNextStoryPrompt(prdStatus.nextStory));
  }

  // Add PRD status summary
  if (prdStatus.status) {
    parts.push(
      `<prd-status>\n${formatPrdStatus(prdStatus.status)}\n</prd-status>\n`,
    );
  }

  return parts.join("\n");
}

/**
 * Update ralph state with current story
 */
export function setCurrentStory(directory: string, storyId: string): boolean {
  const state = readRalphState(directory);
  if (!state) {
    return false;
  }

  state.current_story_id = storyId;
  return writeRalphState(directory, state);
}

/**
 * Enable PRD mode in ralph state
 */
export function enablePrdMode(directory: string): boolean {
  const state = readRalphState(directory);
  if (!state) {
    return false;
  }

  state.prd_mode = true;

  // Initialize progress.txt if it doesn't exist
  initProgress(directory);

  return writeRalphState(directory, state);
}

/**
 * Record progress after completing a story
 */
export function recordStoryProgress(
  directory: string,
  storyId: string,
  implementation: string[],
  filesChanged: string[],
  learnings: string[],
): boolean {
  return appendProgress(directory, {
    storyId,
    implementation,
    filesChanged,
    learnings,
  });
}

/**
 * Add a codebase pattern discovered during work
 */
export function recordPattern(directory: string, pattern: string): boolean {
  return addPattern(directory, pattern);
}

/**
 * Check if an active team pipeline should influence ralph loop continuation.
 * Returns:
 *  - 'continue' if team is in a phase where ralph should keep looping (team-verify, team-fix, team-exec)
 *  - 'complete' if team reached a terminal state (complete, failed)
 *  - null if no team state is active (ralph operates independently)
 */
export function getTeamPhaseDirective(
  directory: string,
  sessionId?: string,
): 'continue' | 'complete' | null {
  const teamState = readTeamPipelineState(directory, sessionId);
  if (!teamState || !teamState.active) {
    // Check terminal states even when active=false
    if (teamState) {
      const terminalPhases: TeamPipelinePhase[] = ['complete', 'failed'];
      if (terminalPhases.includes(teamState.phase)) {
        return 'complete';
      }
    }
    return null;
  }

  const continuePhases: TeamPipelinePhase[] = ['team-verify', 'team-fix', 'team-exec', 'team-plan', 'team-prd'];
  if (continuePhases.includes(teamState.phase)) {
    return 'continue';
  }

  return null;
}

/**
 * Check if ralph should complete based on PRD status
 */
export function shouldCompleteByPrd(directory: string): boolean {
  const status = getPrdCompletionStatus(directory);
  return status.hasPrd && status.allComplete;
}

// Re-export PRD types for convenience
export type { PRD, PRDStatus, UserStory } from "./prd.js";
