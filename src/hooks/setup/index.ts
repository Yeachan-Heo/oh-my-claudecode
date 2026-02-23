/**
 * Setup Hook Module
 *
 * Handles OMC initialization and maintenance tasks.
 * Triggers:
 * - init: Create directory structure, validate configs, set environment
 * - maintenance: Prune old state files, cleanup orphaned state, vacuum SQLite
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

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
      } catch (_err) {
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
 * On Windows, replace sh+find-node.sh hook invocations with direct node calls.
 *
 * The sh->find-node.sh->node chain introduced in v4.3.4 (issue #892) is only
 * needed on Unix where nvm/fnm may not expose `node` on PATH in non-interactive
 * shells.  On Windows (MSYS2 / Git Bash) the same chain triggers Claude Code UI
 * bug #17088, which mislabels every successful hook as an error.
 *
 * This function reads the plugin's hooks.json and rewrites every command of the
 * form:
 *   sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
 * to:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
 *
 * The file is only written when at least one command was actually changed, so
 * the function is safe to call on every init (idempotent after first patch).
 */
export function patchHooksJsonForWindows(pluginRoot: string): void {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return;

  try {
    const content = readFileSync(hooksJsonPath, 'utf-8');
    const data = JSON.parse(content) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    // Matches: sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [optional args]
    const pattern =
      /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "(\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[^"]+)"(.*)$/;

    let patched = false;
    for (const groups of Object.values(data.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (typeof hook.command === 'string') {
            const m = hook.command.match(pattern);
            if (m) {
              hook.command = `node "${m[1]}"${m[2]}`;
              patched = true;
            }
          }
        }
      }
    }

    if (patched) {
      writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
    }
  } catch {
    // Non-fatal: hooks.json patching is best-effort
  }
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

  // On Windows, patch hooks.json to use direct node invocation (no sh wrapper).
  // The sh->find-node.sh->node chain triggers Claude Code UI bug #17088 on
  // MSYS2/Git Bash, mislabeling every successful hook as an error (issue #899).
  // find-node.sh is only needed on Unix for nvm/fnm PATH discovery.
  if (process.platform === 'win32') {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (pluginRoot) {
      patchHooksJsonForWindows(pluginRoot);
    }
  }

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
