/**
 * Setup Hook Module
 *
 * Handles OMC initialization and maintenance tasks.
 * Triggers:
 * - init: Create directory structure, validate configs, set environment
 * - maintenance: Prune old state files, cleanup orphaned state, vacuum SQLite
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';

import { registerBeadsContext } from '../beads-context/index.js';

// ============================================================================
// Types
// ============================================================================

export interface SetupInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'Setup';
  trigger: 'init' | 'maintenance';
}

export interface SetupResult {
  directories_created: string[];
  configs_validated: string[];
  errors: string[];
  env_vars_set: string[];
}

export interface HookOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: 'Setup';
    additionalContext: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const REQUIRED_DIRECTORIES = [
  '.omc/state',
  '.omc/logs',
  '.omc/notepads',
  '.omc/state/checkpoints',
  '.omc/plans',
];

const CONFIG_FILES = [
  '.omc-config.json',
];

const DEFAULT_STATE_MAX_AGE_DAYS = 7;

// ============================================================================
// Init Functions
// ============================================================================

/**
 * Ensure all required directories exist
 */
export function ensureDirectoryStructure(directory: string): string[] {
  const created: string[] = [];

  for (const dir of REQUIRED_DIRECTORIES) {
    const fullPath = join(directory, dir);
    if (!existsSync(fullPath)) {
      try {
        mkdirSync(fullPath, { recursive: true });
        created.push(fullPath);
      } catch (err) {
        // Will be reported in errors
      }
    }
  }

  return created;
}

/**
 * Validate that config files exist and are readable
 */
export function validateConfigFiles(directory: string): string[] {
  const validated: string[] = [];

  for (const configFile of CONFIG_FILES) {
    const fullPath = join(directory, configFile);
    if (existsSync(fullPath)) {
      try {
        // Try to read to ensure it's valid
        readFileSync(fullPath, 'utf-8');
        validated.push(fullPath);
      } catch {
        // Silently skip if unreadable
      }
    }
  }

  return validated;
}

/**
 * Set environment variables for OMC initialization
 */
export function setEnvironmentVariables(): string[] {
  const envVars: string[] = [];

  // Check if CLAUDE_ENV_FILE is available
  if (process.env.CLAUDE_ENV_FILE) {
    try {
      const envContent = `export OMC_INITIALIZED=true\n`;
      appendFileSync(process.env.CLAUDE_ENV_FILE, envContent);
      envVars.push('OMC_INITIALIZED');
    } catch {
      // Silently fail if can't write
    }
  }

  return envVars;
}

/**
 * Process setup init trigger
 */
export async function processSetupInit(input: SetupInput): Promise<HookOutput> {
  const result: SetupResult = {
    directories_created: [],
    configs_validated: [],
    errors: [],
    env_vars_set: [],
  };

  try {
    // Create directory structure
    result.directories_created = ensureDirectoryStructure(input.cwd);

    // Validate config files
    result.configs_validated = validateConfigFiles(input.cwd);

    // Set environment variables
    result.env_vars_set = setEnvironmentVariables();
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  // Register beads context if configured
  try {
    registerBeadsContext(input.session_id);
  } catch {
    // Silently fail - beads context is optional
  }

  const context = [
    `OMC initialized:`,
    `- ${result.directories_created.length} directories created`,
    `- ${result.configs_validated.length} configs validated`,
    result.env_vars_set.length > 0 ? `- Environment variables set: ${result.env_vars_set.join(', ')}` : null,
    result.errors.length > 0 ? `- Errors: ${result.errors.length}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'Setup',
      additionalContext: context,
    },
  };
}

// ============================================================================
// Maintenance Functions
// ============================================================================

/**
 * Prune old state files from .omc/state directory
 */
export function pruneOldStateFiles(directory: string, maxAgeDays: number = DEFAULT_STATE_MAX_AGE_DAYS): number {
  const stateDir = join(directory, '.omc/state');
  if (!existsSync(stateDir)) {
    return 0;
  }

  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = readdirSync(stateDir);

    for (const file of files) {
      const filePath = join(stateDir, file);

      try {
        const stats = statSync(filePath);

        // Skip directories
        if (stats.isDirectory()) {
          continue;
        }

        // Check file age
        if (stats.mtimeMs < cutoffTime) {
          // For mode state files, only skip if the mode is still active.
          // Inactive (cancelled/completed) mode states should be pruned
          // to prevent stale state reuse across sessions (issue #609).
          const modeStateFiles = [
            'autopilot-state.json',
            'ultrapilot-state.json',
            'ralph-state.json',
            'ultrawork-state.json',
            'swarm-state.json'
          ];
          if (modeStateFiles.includes(file)) {
            try {
              const content = readFileSync(filePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active === true) {
                continue; // Skip active mode states
              }
              // Inactive + old → safe to prune
            } catch {
              // If we can't parse the file, it's safe to prune
            }
          }

          unlinkSync(filePath);
          deletedCount++;
        }
      } catch {
        // Skip files we can't read/delete
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return deletedCount;
}

/**
 * Clean up orphaned state files (state files without corresponding active sessions)
 */
export function cleanupOrphanedState(directory: string): number {
  const stateDir = join(directory, '.omc/state');
  if (!existsSync(stateDir)) {
    return 0;
  }

  let cleanedCount = 0;

  try {
    const files = readdirSync(stateDir);

    // Look for session-specific state files (pattern: *-session-*.json)
    const sessionFilePattern = /-session-[a-f0-9-]+\.json$/;

    for (const file of files) {
      if (sessionFilePattern.test(file)) {
        const filePath = join(stateDir, file);

        try {
          // Check if file is older than 24 hours (likely orphaned)
          const stats = statSync(filePath);
          const fileAge = Date.now() - stats.mtimeMs;
          const oneDayMs = 24 * 60 * 60 * 1000;

          if (fileAge > oneDayMs) {
            unlinkSync(filePath);
            cleanedCount++;
          }
        } catch {
          // Skip files we can't access
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return cleanedCount;
}


/**
 * Process setup maintenance trigger
 */
export async function processSetupMaintenance(input: SetupInput): Promise<HookOutput> {
  const result: SetupResult = {
    directories_created: [],
    configs_validated: [],
    errors: [],
    env_vars_set: [],
  };

  let prunedFiles = 0;
  let orphanedCleaned = 0;

  try {
    // Prune old state files
    prunedFiles = pruneOldStateFiles(input.cwd, DEFAULT_STATE_MAX_AGE_DAYS);

    // Cleanup orphaned state
    orphanedCleaned = cleanupOrphanedState(input.cwd);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  const context = [
    `OMC maintenance completed:`,
    prunedFiles > 0 ? `- ${prunedFiles} old state files pruned` : null,
    orphanedCleaned > 0 ? `- ${orphanedCleaned} orphaned state files cleaned` : null,
    result.errors.length > 0 ? `- Errors: ${result.errors.length}` : null,
    prunedFiles === 0 && orphanedCleaned === 0 && result.errors.length === 0
      ? '- No maintenance needed'
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'Setup',
      additionalContext: context,
    },
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Process setup hook based on trigger type
 */
export async function processSetup(input: SetupInput): Promise<HookOutput> {
  if (input.trigger === 'init') {
    return processSetupInit(input);
  } else if (input.trigger === 'maintenance') {
    return processSetupMaintenance(input);
  } else {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'Setup',
        additionalContext: `Unknown trigger: ${input.trigger}`,
      },
    };
  }
}
