/**
 * Ralph Fresh Context - Handoff State Operations
 *
 * Manages the handoff state file that persists between fresh-context iterations.
 * The handoff state contains:
 * - Iteration metadata (current, max)
 * - Original task prompt
 * - PRD status summary
 * - Progress patterns and learnings
 * - Git history and status
 * - Stuck detection state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { readPrd, getPrdStatus } from './prd.js';
import { getPatterns, getRecentLearnings } from './progress.js';

// ============================================================================
// Types
// ============================================================================

export interface RalphFreshConfig {
  /** Maximum iterations before stopping (default: 20) */
  maxIterations?: number;
  /** Completion promise phrase (default: "TASK_COMPLETE") */
  completionPromise?: string;
  /** Stuck detection threshold (default: 3) */
  stuckThreshold?: number;
}

export interface RalphFreshHandoff {
  // Orchestration metadata
  version: '1.0';
  created_at: string;
  iteration: number;
  max_iterations: number;

  // Original task
  original_prompt: string;
  completion_promise: string;

  // Completion state (set by subagent)
  completed: boolean;
  completion_message?: string;

  // PRD State (from .omc/prd.json)
  prd?: {
    project: string;
    branchName: string;
    description: string;
    storiesTotal: number;
    storiesCompleted: number;
    nextStoryId: string | null;
    incompleteIds: string[];
  };

  // Progress State (from .omc/progress.txt)
  progress: {
    patterns: string[];
    recentLearnings: string[];
    lastCompletedStory?: string;
  };

  // Git State
  git: {
    recentCommits: Array<{
      hash: string;
      message: string;
    }>;
    branch: string;
    hasUncommittedChanges: boolean;
  };

  // Stuck detection
  stuckDetection: {
    lastPrdStatus: string[];
    iterationsOnSameStory: number;
    lastActionAttempted?: string;
  };

  // Error tracking
  lastError?: {
    iteration: number;
    message: string;
    recoveryAttempt?: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_COMPLETION_PROMISE = 'TASK_COMPLETE';
const HANDOFF_FILENAME = 'ralph-fresh-handoff.json';

// ============================================================================
// Path Operations
// ============================================================================

/**
 * Get path to handoff state file
 */
export function getHandoffPath(directory: string): string {
  return join(directory, '.omc', 'state', HANDOFF_FILENAME);
}

/**
 * Ensure .omc/state directory exists
 */
function ensureStateDir(directory: string): void {
  const stateDir = join(directory, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

// ============================================================================
// Handoff Operations
// ============================================================================

/**
 * Initialize a new handoff state
 */
export function initHandoff(
  prompt: string,
  config: Partial<RalphFreshConfig>
): RalphFreshHandoff {
  const now = new Date().toISOString();

  return {
    version: '1.0',
    created_at: now,
    iteration: 1,
    max_iterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    original_prompt: prompt,
    completion_promise: config.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
    completed: false,
    progress: {
      patterns: [],
      recentLearnings: []
    },
    git: {
      recentCommits: [],
      branch: '',
      hasUncommittedChanges: false
    },
    stuckDetection: {
      lastPrdStatus: [],
      iterationsOnSameStory: 0
    }
  };
}

/**
 * Read handoff from disk
 */
export function readHandoff(directory: string): RalphFreshHandoff | null {
  const handoffPath = getHandoffPath(directory);

  if (!existsSync(handoffPath)) {
    return null;
  }

  try {
    const content = readFileSync(handoffPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write handoff to disk
 */
export function writeHandoff(handoff: RalphFreshHandoff, directory: string): boolean {
  try {
    ensureStateDir(directory);
    const handoffPath = getHandoffPath(directory);
    writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear/delete handoff state
 */
export function clearHandoff(directory: string): boolean {
  const handoffPath = getHandoffPath(directory);

  if (!existsSync(handoffPath)) {
    return true;
  }

  try {
    unlinkSync(handoffPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh handoff with current state from PRD, progress.txt, git
 */
export function refreshHandoffFromFiles(
  handoff: RalphFreshHandoff,
  directory: string
): RalphFreshHandoff {
  const refreshed = { ...handoff };

  // Read PRD state
  const prd = readPrd(directory);
  if (prd) {
    const status = getPrdStatus(prd);

    refreshed.prd = {
      project: prd.project,
      branchName: prd.branchName,
      description: prd.description,
      storiesTotal: status.total,
      storiesCompleted: status.completed,
      nextStoryId: status.nextStory?.id || null,
      incompleteIds: status.incompleteIds
    };
  }

  // Read progress patterns and learnings
  const patterns = getPatterns(directory);
  const learnings = getRecentLearnings(directory, 10);

  refreshed.progress = {
    ...refreshed.progress,
    patterns,
    recentLearnings: learnings
  };

  // Read git state
  try {
    // Get recent commits (last 5)
    const gitLog = execSync('git log --oneline -5', {
      cwd: directory,
      encoding: 'utf-8'
    });

    refreshed.git.recentCommits = gitLog
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const spaceIndex = line.indexOf(' ');
        if (spaceIndex === -1) {
          return { hash: line, message: '' };
        }
        return {
          hash: line.slice(0, spaceIndex),
          message: line.slice(spaceIndex + 1)
        };
      });

    // Check for uncommitted changes
    const status = execSync('git status --porcelain', {
      cwd: directory,
      encoding: 'utf-8'
    });
    refreshed.git.hasUncommittedChanges = status.trim().length > 0;

    // Get current branch
    const branch = execSync('git branch --show-current', {
      cwd: directory,
      encoding: 'utf-8'
    });
    refreshed.git.branch = branch.trim();
  } catch {
    // Not a git repo or git error - leave git state as is
  }

  // Update stuck detection
  const prevStories = refreshed.stuckDetection.lastPrdStatus;
  const currStory = refreshed.prd?.nextStoryId;

  if (currStory && prevStories.includes(currStory)) {
    // Still on same story
    refreshed.stuckDetection.iterationsOnSameStory++;
  } else {
    // Moved to different story or no story
    refreshed.stuckDetection.iterationsOnSameStory = 1;
  }

  return refreshed;
}
