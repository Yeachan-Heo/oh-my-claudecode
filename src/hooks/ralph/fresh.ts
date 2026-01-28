/**
 * Ralph Fresh-Context Hook - Types and Core Interfaces
 *
 * Fresh-context ralph operates without memory compaction, spawning fresh subagents
 * each iteration with complete context handoff. This file defines the core types
 * and lightweight helper functions.
 *
 * Key differences from standard ralph:
 * - No memory/conversation persistence between iterations
 * - Full context state passed explicitly via handoff object
 * - Subagent spawned fresh each iteration
 * - Optimized for long-running tasks without token limits
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Core Handoff Interface
// ============================================================================

/**
 * PRD (Product Requirements Document) state snapshot
 */
export interface RalphFreshPrd {
  /** Project name */
  project: string;
  /** Git branch name */
  branchName: string;
  /** Project description */
  description: string;
  /** Total number of stories */
  storiesTotal: number;
  /** Number of completed stories */
  storiesCompleted: number;
  /** Next story ID to work on, or null if all complete */
  nextStoryId: string | null;
  /** Array of incomplete story IDs */
  incompleteIds: string[];
}

/**
 * Progress tracking state
 */
export interface RalphFreshProgress {
  /** Codebase patterns discovered */
  patterns: string[];
  /** Recent learnings (limited to last 5) */
  recentLearnings: string[];
  /** Last completed story ID */
  lastCompletedStory?: string;
}

/**
 * Git repository state
 */
export interface RalphFreshGit {
  /** Recent commits (limited to last 5) */
  recentCommits: Array<{
    hash: string;
    message: string;
  }>;
  /** Current branch name */
  branch: string;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
}

/**
 * Stuck detection tracking
 */
export interface RalphFreshStuckDetection {
  /** Story IDs from previous iteration for comparison */
  lastPrdStatus: string[];
  /** Number of iterations stuck on same story */
  iterationsOnSameStory: number;
  /** Last action attempted before detecting stuck */
  lastActionAttempted?: string;
}

/**
 * Error tracking
 */
export interface RalphFreshError {
  /** Iteration number when error occurred */
  iteration: number;
  /** Error message */
  message: string;
  /** What was attempted to recover */
  recoveryAttempt?: string;
}

/**
 * Complete handoff object passed between ralph iterations
 *
 * This is the primary data structure for fresh-context ralph.
 * Each iteration receives this as input and may update it before
 * spawning the next iteration.
 */
export interface RalphFreshHandoff {
  // Orchestration metadata
  /** Handoff format version */
  version: '1.0';
  /** When this handoff was created (ISO timestamp) */
  created_at: string;
  /** Current iteration number (1-indexed) */
  iteration: number;
  /** Maximum iterations before stopping */
  max_iterations: number;

  // Original task
  /** User's original task description */
  original_prompt: string;
  /** Signal phrase that indicates task completion */
  completion_promise: string;

  // Completion state (set by subagent)
  /** Whether the task is complete */
  completed: boolean;
  /** Final summary message if completed */
  completion_message?: string;

  // PRD State (from .omc/prd.json)
  /** Current PRD state, if PRD mode is active */
  prd?: RalphFreshPrd;

  // Progress State (from .omc/progress.txt)
  /** Accumulated progress and learnings */
  progress: RalphFreshProgress;

  // Git State
  /** Current git repository state */
  git: RalphFreshGit;

  // Stuck detection
  /** Tracking to detect when stuck on same story */
  stuckDetection: RalphFreshStuckDetection;

  // Error tracking
  /** Last error encountered, if any */
  lastError?: RalphFreshError;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for fresh-context ralph execution
 */
export interface RalphFreshConfig {
  /** Maximum number of iterations before stopping */
  maxIterations: number;
  /** Maximum turns per iteration before forcing completion */
  maxTurnsPerIteration: number;
  /** Signal phrase that indicates task completion */
  completionPromise: string;
  /** Working directory for the task */
  workingDir: string;
  /** Enable verbose logging */
  verbose: boolean;
  /** Number of retry attempts for failed operations */
  retryAttempts: number;
  /** Delay between retry attempts in milliseconds */
  retryDelayMs: number;
  /** Number of iterations stuck on same story before intervention */
  stuckThreshold: number;
}

/**
 * Default configuration for fresh-context ralph
 */
export const DEFAULT_FRESH_CONFIG: RalphFreshConfig = {
  maxIterations: 20,
  maxTurnsPerIteration: 100,
  completionPromise: 'TASK_COMPLETE',
  workingDir: process.cwd(),
  verbose: false,
  retryAttempts: 3,
  retryDelayMs: 5000,
  stuckThreshold: 3
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the state file path for fresh-context ralph
 */
function getFreshStateFilePath(directory: string): string {
  return join(directory, '.omc', 'state', 'ralph-fresh-state.json');
}

/**
 * Get the state file path for standard ralph
 */
function getStandardRalphStateFilePath(directory: string): string {
  return join(directory, '.omc', 'state', 'ralph-state.json');
}

/**
 * Check if fresh-context ralph is currently active
 *
 * @param directory - Working directory to check
 * @returns true if fresh-context ralph state exists and is active
 */
export function isRalphFreshActive(directory: string): boolean {
  const stateFile = getFreshStateFilePath(directory);

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

/**
 * Check if standard ralph (not fresh-context) is currently active
 *
 * This is used for mutual exclusion - only one ralph variant should run at a time.
 *
 * @param directory - Working directory to check
 * @returns true if standard ralph state exists and is active
 */
export function isStandardRalphActive(directory: string): boolean {
  const stateFile = getStandardRalphStateFilePath(directory);

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
