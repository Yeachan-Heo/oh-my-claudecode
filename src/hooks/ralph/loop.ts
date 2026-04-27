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

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { basename, join } from "path";
import {
  writeModeState,
  readModeState,
  clearModeStateFile,
} from "../../lib/mode-state-io.js";
import {
  ensurePrdForStartup,
  findPrdPath,
  readPrd,
  getPrdStatus,
  formatNextStoryPrompt,
  formatPrdStatus,
  type PRDStatus,
  type UserStory,
} from "./prd.js";
import {
  findProgressPath,
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
import {
  resolveSessionStatePath,
  getOmcRoot,
} from "../../lib/worktree-paths.js";
import { readTeamPipelineState } from "../team-pipeline/state.js";
import type { TeamPipelinePhase } from "../team-pipeline/types.js";

// Forward declaration to avoid circular import - check ultraqa state file directly
export function isUltraQAActive(
  directory: string,
  sessionId?: string,
): boolean {
  // When sessionId is provided, ONLY check session-scoped path — no legacy fallback
  if (sessionId) {
    const sessionFile = resolveSessionStatePath(
      "ultraqa",
      sessionId,
      directory,
    );
    try {
      const content = readFileSync(sessionFile, "utf-8");
      const state = JSON.parse(content);
      return state && state.active === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      return false; // NO legacy fallback
    }
  }

  // No sessionId: legacy path (backward compat)
  const omcDir = getOmcRoot(directory);
  const stateFile = join(omcDir, "state", "ultraqa-state.json");
  try {
    const content = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(content);
    return state && state.active === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
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
  /** Reviewer mode for Ralph completion verification */
  critic_mode?: RalphCriticMode;
}

export const RALPH_CRITIC_MODES = ['architect', 'critic', 'codex'] as const;
export type RalphCriticMode = typeof RALPH_CRITIC_MODES[number];

export interface RalphLoopOptions {
  /** Maximum iterations (default: 10) */
  maxIterations?: number;
  /** Disable auto-activation of ultrawork (default: false - ultrawork is enabled) */
  disableUltrawork?: boolean;
  /** Reviewer mode for Ralph completion verification */
  criticMode?: RalphCriticMode;
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
const DEFAULT_RALPH_CRITIC_MODE: RalphCriticMode = 'architect';

/**
 * Read Ralph Loop state from disk
 */
export function readRalphState(
  directory: string,
  sessionId?: string,
): RalphLoopState | null {
  const state = readModeState<RalphLoopState>("ralph", directory, sessionId);

  // Validate session identity
  if (
    state &&
    sessionId &&
    state.session_id &&
    state.session_id !== sessionId
  ) {
    return null;
  }

  return state;
}

/**
 * Write Ralph Loop state to disk
 */
export function writeRalphState(
  directory: string,
  state: RalphLoopState,
  sessionId?: string,
): boolean {
  return writeModeState(
    "ralph",
    state as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/**
 * Clear Ralph Loop state (includes ghost-legacy cleanup)
 */
export function clearRalphState(
  directory: string,
  sessionId?: string,
): boolean {
  return clearModeStateFile("ralph", directory, sessionId);
}

/**
 * Clear ultrawork state (only if linked to ralph)
 */
export function clearLinkedUltraworkState(
  directory: string,
  sessionId?: string,
): boolean {
  const state = readUltraworkStateFromModule(directory, sessionId);

  // Only clear if it was linked to ralph (auto-activated)
  if (!state || !state.linked_to_ralph) {
    return true;
  }

  return clearModeStateFile("ultrawork", directory, sessionId);
}

/**
 * Increment Ralph Loop iteration
 */
export function incrementRalphIteration(
  directory: string,
  sessionId?: string,
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

// ============================================================================
// PRD Flag Helpers
// ============================================================================

/**
 * Detect if prompt contains --no-prd flag (case-insensitive)
 */
export function detectNoPrdFlag(prompt: string): boolean {
  return /--no-prd/i.test(prompt);
}

/**
 * Strip --no-prd flag from prompt text and trim whitespace
 */
export function stripNoPrdFlag(prompt: string): string {
  return prompt
    .replace(/--no-prd/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a Ralph critic mode flag value.
 */
export function normalizeRalphCriticMode(value: string | null | undefined): RalphCriticMode | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return (RALPH_CRITIC_MODES as readonly string[]).includes(normalized)
    ? normalized as RalphCriticMode
    : null;
}

/**
 * Detect --critic=<mode> flag (case-insensitive).
 */
export function detectCriticModeFlag(prompt: string): RalphCriticMode | null {
  const match = prompt.match(/--critic(?:=|\s+)([^\s]+)/i);
  return normalizeRalphCriticMode(match?.[1]);
}

/**
 * Strip --critic=<mode> flag from prompt text and trim whitespace.
 */
export function stripCriticModeFlag(prompt: string): string {
  return prompt
    .replace(/--critic(?:=|\s+)([^\s]+)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
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
    const normalizedPrompt = stripCriticModeFlag(stripNoPrdFlag(prompt));

    let branchName = "ralph/task";
    try {
      branchName = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: directory,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      // Fallback outside git repos.
    }

    const startupPrd = ensurePrdForStartup(
      directory,
      basename(directory),
      branchName,
      normalizedPrompt,
      undefined,
      sessionId,
    );

    if (!startupPrd.ok) {
      console.error(`[RALPH PRD REQUIRED] ${startupPrd.error}`);
      return false;
    }

    if (!findProgressPath(directory)) {
      initProgress(directory);
    }

    const state: RalphLoopState = {
      active: true,
      iteration: 1,
      max_iterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      started_at: now,
      prompt: normalizedPrompt,
      session_id: sessionId,
      project_path: directory,
      linked_ultrawork: enableUltrawork,
      critic_mode: options?.criticMode ?? detectCriticModeFlag(prompt) ?? DEFAULT_RALPH_CRITIC_MODE,
      prd_mode: true,
    };

    const prdCompletion = getPrdCompletionStatus(directory, sessionId);
    if (prdCompletion.nextStory) {
      state.current_story_id = prdCompletion.nextStory.id;
    }

    const ralphSuccess = writeRalphState(directory, state, sessionId);

    // Auto-activate ultrawork (linked to ralph) by default
    // Include session_id and project_path for proper isolation
    if (ralphSuccess && enableUltrawork) {
      const ultraworkState: UltraworkState = {
        active: true,
        reinforcement_count: 0,
        original_prompt: normalizedPrompt,
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
export function hasPrd(directory: string, sessionId?: string): boolean {
  const prd = readPrd(directory, sessionId);
  return prd !== null;
}

/**
 * Get PRD completion status for ralph
 */
export function getPrdCompletionStatus(directory: string, sessionId?: string): {
  hasPrd: boolean;
  allComplete: boolean;
  status: PRDStatus | null;
  nextStory: UserStory | null;
} {
  const prd = readPrd(directory, sessionId);

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
export function getRalphContext(directory: string, sessionId?: string): string {
  const parts: string[] = [];

  // Add progress context (patterns, learnings)
  const progressContext = getProgressContext(directory);
  if (progressContext) {
    parts.push(progressContext);
  }

  // Add current story from PRD
  const prdStatus = getPrdCompletionStatus(directory, sessionId);
  if (prdStatus.hasPrd && prdStatus.nextStory) {
    parts.push(formatNextStoryPrompt(prdStatus.nextStory, findPrdPath(directory, sessionId) ?? undefined));
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
export function setCurrentStory(directory: string, storyId: string, sessionId?: string): boolean {
  const state = readRalphState(directory, sessionId);
  if (!state) {
    return false;
  }

  state.current_story_id = storyId;
  return writeRalphState(directory, state, sessionId);
}

/**
 * Enable PRD mode in ralph state
 */
export function enablePrdMode(directory: string, sessionId?: string): boolean {
  const state = readRalphState(directory, sessionId);
  if (!state) {
    return false;
  }

  state.prd_mode = true;

  // Initialize progress.txt if it doesn't exist
  initProgress(directory);

  return writeRalphState(directory, state, sessionId);
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
): "continue" | "complete" | null {
  const teamState = readTeamPipelineState(directory, sessionId);
  if (!teamState || !teamState.active) {
    // Check terminal states even when active=false
    if (teamState) {
      const terminalPhases: TeamPipelinePhase[] = ["complete", "failed"];
      if (terminalPhases.includes(teamState.phase)) {
        return "complete";
      }
    }
    return null;
  }

  const continuePhases: TeamPipelinePhase[] = [
    "team-verify",
    "team-fix",
    "team-exec",
    "team-plan",
    "team-prd",
  ];
  if (continuePhases.includes(teamState.phase)) {
    return "continue";
  }

  return null;
}

/**
 * Check if ralph should complete based on PRD status
 */
export function shouldCompleteByPrd(directory: string, sessionId?: string): boolean {
  const status = getPrdCompletionStatus(directory, sessionId);
  return status.hasPrd && status.allComplete;
}

// Re-export PRD types for convenience
export type { PRD, PRDStatus, UserStory } from "./prd.js";
