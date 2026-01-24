/**
 * OMC HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 * Follows patterns from ultrawork-state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { OmcHudState, BackgroundTask, HudConfig } from './types.js';
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from './types.js';
import { cleanupStaleBackgroundTasks, markOrphanedTasksAsStale } from './background-cleanup.js';

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the HUD state file path in the project's .omc directory
 */
function getLocalStateFilePath(directory?: string): string {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');
  return join(omcDir, 'hud-state.json');
}

/**
 * Get global HUD state file path (for cross-session persistence)
 */
function getGlobalStateFilePath(): string {
  return join(homedir(), '.claude', 'hud-state.json');
}

/**
 * Get the HUD config file path
 */
function getConfigFilePath(): string {
  return join(homedir(), '.claude', '.omc', 'hud-config.json');
}

/**
 * Ensure the .omc directory exists
 */
function ensureStateDir(directory?: string): void {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');
  if (!existsSync(omcDir)) {
    mkdirSync(omcDir, { recursive: true });
  }
}

/**
 * Ensure the ~/.claude/.omc directory exists
 */
function ensureGlobalConfigDir(): void {
  const configDir = join(homedir(), '.claude', '.omc');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Ensure the ~/.claude directory exists
 */
function ensureGlobalStateDir(): void {
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
}

// ============================================================================
// HUD State Operations
// ============================================================================

/**
 * Read HUD state from disk (checks both local and global)
 */
export function readHudState(directory?: string): OmcHudState | null {
  // Check local state first
  const localStateFile = getLocalStateFilePath(directory);
  if (existsSync(localStateFile)) {
    try {
      const content = readFileSync(localStateFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      // Fall through to global check
    }
  }

  // Check global state
  const globalStateFile = getGlobalStateFilePath();
  if (existsSync(globalStateFile)) {
    try {
      const content = readFileSync(globalStateFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Write HUD state to disk (both local and global for redundancy)
 */
export function writeHudState(
  state: OmcHudState,
  directory?: string
): boolean {
  try {
    // Write to local .omc
    ensureStateDir(directory);
    const localStateFile = getLocalStateFilePath(directory);
    writeFileSync(localStateFile, JSON.stringify(state, null, 2));

    // Write to global ~/.claude for cross-session persistence
    ensureGlobalStateDir();
    const globalStateFile = getGlobalStateFilePath();
    writeFileSync(globalStateFile, JSON.stringify(state, null, 2));

    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new empty HUD state
 */
export function createEmptyHudState(): OmcHudState {
  return {
    timestamp: new Date().toISOString(),
    backgroundTasks: [],
  };
}

/**
 * Get running background tasks from state
 */
export function getRunningTasks(state: OmcHudState | null): BackgroundTask[] {
  if (!state) return [];
  return state.backgroundTasks.filter((task) => task.status === 'running');
}

/**
 * Get background task count string (e.g., "3/5")
 */
export function getBackgroundTaskCount(state: OmcHudState | null): {
  running: number;
  max: number;
} {
  const MAX_CONCURRENT = 5;
  const running = state
    ? state.backgroundTasks.filter((t) => t.status === 'running').length
    : 0;
  return { running, max: MAX_CONCURRENT };
}

// ============================================================================
// HUD Config Operations
// ============================================================================

/**
 * Read HUD configuration from disk
 */
export function readHudConfig(): HudConfig {
  const configFile = getConfigFilePath();
  if (!existsSync(configFile)) {
    return DEFAULT_HUD_CONFIG;
  }

  try {
    const content = readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content) as Partial<HudConfig>;

    // Merge with defaults to ensure all fields exist
    return {
      preset: config.preset ?? DEFAULT_HUD_CONFIG.preset,
      elements: {
        ...DEFAULT_HUD_CONFIG.elements,
        ...config.elements,
      },
      thresholds: {
        ...DEFAULT_HUD_CONFIG.thresholds,
        ...config.thresholds,
      },
    };
  } catch {
    return DEFAULT_HUD_CONFIG;
  }
}

/**
 * Write HUD configuration to disk
 */
export function writeHudConfig(config: HudConfig): boolean {
  try {
    ensureGlobalConfigDir();
    const configFile = getConfigFilePath();
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a preset to the configuration
 */
export function applyPreset(preset: HudConfig['preset']): HudConfig {
  const config = readHudConfig();
  const presetElements = PRESET_CONFIGS[preset];

  const newConfig: HudConfig = {
    ...config,
    preset,
    elements: {
      ...config.elements,
      ...presetElements,
    },
  };

  writeHudConfig(newConfig);
  return newConfig;
}

/**
 * Initialize HUD state with cleanup of stale/orphaned tasks.
 * Should be called on HUD startup.
 */
export async function initializeHUDState(): Promise<void> {
  // Clean up stale background tasks from previous sessions
  const removedStale = await cleanupStaleBackgroundTasks();
  const markedOrphaned = await markOrphanedTasksAsStale();

  if (removedStale > 0 || markedOrphaned > 0) {
    console.error(`HUD cleanup: removed ${removedStale} stale tasks, marked ${markedOrphaned} orphaned tasks`);
  }
}
