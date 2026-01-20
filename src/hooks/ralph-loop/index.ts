/**
 * Ralph Hook
 *
 * Self-referential work loop that continues until a completion promise is detected.
 * Named after the character who keeps working until the job is done.
 *
 * Enhanced with PRD (Product Requirements Document) support for structured task tracking.
 * When a prd.json exists, completion is based on all stories having passes: true.
 *
 * Ported from oh-my-opencode's ralph hook.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readPrd,
  getPrdStatus,
  formatNextStoryPrompt,
  formatPrdStatus,
  type PRDStatus,
  type UserStory
} from '../ralph-prd/index.js';
import {
  getProgressContext,
  appendProgress,
  initProgress,
  addPattern
} from '../ralph-progress/index.js';

// Forward declaration to avoid circular import - check ultraqa state file directly
export function isUltraQAActive(directory: string): boolean {
  const sisyphusDir = join(directory, '.omc');
  const stateFile = join(sisyphusDir, 'ultraqa-state.json');
  if (!existsSync(stateFile)) {
    return false;
  }
  try {
    const content = readFileSync(stateFile, 'utf-8');
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
  /** The promise phrase to detect for completion */
  completion_promise: string;
  /** When the loop started */
  started_at: string;
  /** The original prompt/task */
  prompt: string;
  /** Session ID the loop is bound to */
  session_id?: string;
  /** Whether PRD mode is active */
  prd_mode?: boolean;
  /** Current story being worked on */
  current_story_id?: string;
}

export interface RalphLoopOptions {
  /** Maximum iterations (default: 10) */
  maxIterations?: number;
  /** Custom completion promise (default: "TASK_COMPLETE") */
  completionPromise?: string;
}

export interface RalphLoopHook {
  startLoop: (sessionId: string, prompt: string, options?: RalphLoopOptions) => boolean;
  cancelLoop: (sessionId: string) => boolean;
  getState: () => RalphLoopState | null;
}

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_COMPLETION_PROMISE = 'TASK_COMPLETE';

/**
 * Get the state file path for Ralph Loop
 */
function getStateFilePath(directory: string): string {
  const sisyphusDir = join(directory, '.omc');
  return join(sisyphusDir, 'ralph-state.json');
}

/**
 * Ensure the .sisyphus directory exists
 */
function ensureStateDir(directory: string): void {
  const sisyphusDir = join(directory, '.omc');
  if (!existsSync(sisyphusDir)) {
    mkdirSync(sisyphusDir, { recursive: true });
  }
}

/**
 * Read Ralph Loop state from disk
 */
export function readRalphState(directory: string): RalphLoopState | null {
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
 * Write Ralph Loop state to disk
 */
export function writeRalphState(directory: string, state: RalphLoopState): boolean {
  try {
    ensureStateDir(directory);
    const stateFile = getStateFilePath(directory);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear Ralph Loop state
 */
export function clearRalphState(directory: string): boolean {
  const stateFile = getStateFilePath(directory);

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
 * Increment Ralph Loop iteration
 */
export function incrementRalphIteration(directory: string): RalphLoopState | null {
  const state = readRalphState(directory);

  if (!state || !state.active) {
    return null;
  }

  state.iteration += 1;

  if (writeRalphState(directory, state)) {
    return state;
  }

  return null;
}

/**
 * Detect completion promise in session transcript
 */
export function detectCompletionPromise(
  sessionId: string,
  promise: string
): boolean {
  // Try to find transcript in Claude's session directory
  const claudeDir = join(homedir(), '.claude');
  const possiblePaths = [
    join(claudeDir, 'sessions', sessionId, 'transcript.md'),
    join(claudeDir, 'sessions', sessionId, 'messages.json'),
    join(claudeDir, 'transcripts', `${sessionId}.md`)
  ];

  for (const transcriptPath of possiblePaths) {
    if (existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        const pattern = new RegExp(`<promise>\\s*${escapeRegex(promise)}\\s*</promise>`, 'is');
        if (pattern.test(content)) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }

  return false;
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a Ralph Loop hook instance
 */
export function createRalphLoopHook(directory: string): RalphLoopHook {
  const startLoop = (
    sessionId: string,
    prompt: string,
    options?: RalphLoopOptions
  ): boolean => {
    // Mutual exclusion check: cannot start Ralph Loop if UltraQA is active
    if (isUltraQAActive(directory)) {
      console.error('Cannot start Ralph Loop while UltraQA is active. Cancel UltraQA first with /cancel-ultraqa.');
      return false;
    }

    const state: RalphLoopState = {
      active: true,
      iteration: 1,
      max_iterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      completion_promise: options?.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
      started_at: new Date().toISOString(),
      prompt,
      session_id: sessionId
    };

    return writeRalphState(directory, state);
  };

  const cancelLoop = (sessionId: string): boolean => {
    const state = readRalphState(directory);

    if (!state || state.session_id !== sessionId) {
      return false;
    }

    return clearRalphState(directory);
  };

  const getState = (): RalphLoopState | null => {
    return readRalphState(directory);
  };

  return {
    startLoop,
    cancelLoop,
    getState
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
      nextStory: null
    };
  }

  const status = getPrdStatus(prd);

  return {
    hasPrd: true,
    allComplete: status.allComplete,
    status,
    nextStory: status.nextStory
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
    parts.push(`<prd-status>\n${formatPrdStatus(prdStatus.status)}\n</prd-status>\n`);
  }

  return parts.join('\n');
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
  learnings: string[]
): boolean {
  return appendProgress(directory, {
    storyId,
    implementation,
    filesChanged,
    learnings
  });
}

/**
 * Add a codebase pattern discovered during work
 */
export function recordPattern(directory: string, pattern: string): boolean {
  return addPattern(directory, pattern);
}

/**
 * Check if ralph should complete based on PRD status
 */
export function shouldCompleteByPrd(directory: string): boolean {
  const status = getPrdCompletionStatus(directory);
  return status.hasPrd && status.allComplete;
}

// Re-export PRD types for convenience
export type { PRD, PRDStatus, UserStory } from '../ralph-prd/index.js';
