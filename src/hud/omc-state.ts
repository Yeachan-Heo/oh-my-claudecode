/**
 * Sisyphus HUD - State Readers
 *
 * Read ralph, ultrawork, and PRD state from existing Sisyphus files.
 * These are read-only functions that don't modify the state files.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type {
  RalphStateForHud,
  UltraworkStateForHud,
  PrdStateForHud,
} from './types.js';

/**
 * Maximum age for state files to be considered "active".
 * Files older than this are treated as stale/abandoned.
 */
const MAX_STATE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Check if a state file is stale based on file modification time.
 */
function isStateFileStale(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    const age = Date.now() - stat.mtimeMs;
    return age > MAX_STATE_AGE_MS;
  } catch {
    return true; // Treat errors as stale
  }
}

// ============================================================================
// Ralph State
// ============================================================================

interface RalphLoopState {
  active: boolean;
  iteration: number;
  max_iterations: number;
  prd_mode?: boolean;
  current_story_id?: string;
}

/**
 * Read Ralph Loop state for HUD display.
 * Returns null if no state file exists or on error.
 */
export function readRalphStateForHud(directory: string): RalphStateForHud | null {
  const stateFile = join(directory, '.omc', 'ralph-state.json');

  if (!existsSync(stateFile)) {
    return null;
  }

  // Check for stale state file (abandoned session)
  if (isStateFileStale(stateFile)) {
    return null;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(content) as RalphLoopState;

    if (!state.active) {
      return null;
    }

    return {
      active: state.active,
      iteration: state.iteration,
      maxIterations: state.max_iterations,
      prdMode: state.prd_mode,
      currentStoryId: state.current_story_id,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Ultrawork State
// ============================================================================

interface UltraworkState {
  active: boolean;
  reinforcement_count: number;
}

/**
 * Read Ultrawork state for HUD display.
 * Checks both local .sisyphus and global ~/.claude locations.
 */
export function readUltraworkStateForHud(
  directory: string
): UltraworkStateForHud | null {
  // Check local state first
  const localFile = join(directory, '.omc', 'ultrawork-state.json');
  let state: UltraworkState | null = null;
  let stateFile: string | null = null;

  if (existsSync(localFile) && !isStateFileStale(localFile)) {
    try {
      const content = readFileSync(localFile, 'utf-8');
      state = JSON.parse(content) as UltraworkState;
      stateFile = localFile;
    } catch {
      // Try global
    }
  }

  // Check global state if local not found or stale
  if (!state) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const globalFile = join(homeDir, '.claude', 'ultrawork-state.json');

    if (existsSync(globalFile) && !isStateFileStale(globalFile)) {
      try {
        const content = readFileSync(globalFile, 'utf-8');
        state = JSON.parse(content) as UltraworkState;
        stateFile = globalFile;
      } catch {
        return null;
      }
    }
  }

  if (!state || !state.active) {
    return null;
  }

  return {
    active: state.active,
    reinforcementCount: state.reinforcement_count,
  };
}

// ============================================================================
// PRD State
// ============================================================================

interface UserStory {
  id: string;
  passes: boolean;
  priority: number;
}

interface PRD {
  userStories: UserStory[];
}

/**
 * Read PRD state for HUD display.
 * Checks both root prd.json and .sisyphus/prd.json.
 */
export function readPrdStateForHud(directory: string): PrdStateForHud | null {
  // Check root first
  let prdPath = join(directory, 'prd.json');

  if (!existsSync(prdPath)) {
    // Check .sisyphus
    prdPath = join(directory, '.omc', 'prd.json');

    if (!existsSync(prdPath)) {
      return null;
    }
  }

  try {
    const content = readFileSync(prdPath, 'utf-8');
    const prd = JSON.parse(content) as PRD;

    if (!prd.userStories || !Array.isArray(prd.userStories)) {
      return null;
    }

    const stories = prd.userStories;
    const completed = stories.filter((s) => s.passes).length;
    const total = stories.length;

    // Find current story (first incomplete, sorted by priority)
    const incomplete = stories
      .filter((s) => !s.passes)
      .sort((a, b) => a.priority - b.priority);

    return {
      currentStoryId: incomplete[0]?.id || null,
      completed,
      total,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Combined State Check
// ============================================================================

/**
 * Check if any Sisyphus mode is currently active
 */
export function isAnyModeActive(directory: string): boolean {
  const ralph = readRalphStateForHud(directory);
  const ultrawork = readUltraworkStateForHud(directory);

  return (ralph?.active ?? false) || (ultrawork?.active ?? false);
}

/**
 * Get active skill names for display
 */
export function getActiveSkills(directory: string): string[] {
  const skills: string[] = [];

  const ralph = readRalphStateForHud(directory);
  if (ralph?.active) {
    skills.push('ralph');
  }

  const ultrawork = readUltraworkStateForHud(directory);
  if (ultrawork?.active) {
    skills.push('ultrawork');
  }

  return skills;
}
