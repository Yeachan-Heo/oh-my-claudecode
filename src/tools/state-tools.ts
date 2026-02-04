/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */

import { z } from 'zod';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import {
  getWorktreeRoot,
  resolveStatePath,
  ensureOmcDir,
  OmcPaths
} from '../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import {
  isModeActive,
  getActiveModes,
  getAllModeStatuses,
  clearModeState,
  getStateFilePath,
  MODE_CONFIGS,
  type ExecutionMode
} from '../hooks/mode-registry/index.js';
import { ToolDefinition } from './types.js';

// ExecutionMode from mode-registry (8 modes - NO ralplan)
const EXECUTION_MODES: [string, ...string[]] = [
  'autopilot', 'ultrapilot', 'swarm', 'pipeline',
  'ralph', 'ultrawork', 'ultraqa', 'ecomode'
];

// Extended type for state tools - includes ralplan which has state but isn't in mode-registry
const STATE_TOOL_MODES: [string, ...string[]] = [...EXECUTION_MODES, 'ralplan'];
type StateToolMode = typeof STATE_TOOL_MODES[number];

/**
 * Get the state file path for any mode (including swarm and ralplan).
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For ralplan (not in registry): uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getStatePath(mode: StateToolMode, root: string): string {
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return getStateFilePath(root, mode as ExecutionMode);
  }
  // Fallback for modes not in registry (e.g., ralplan)
  return resolveStatePath(mode, root);
}

// ============================================================================
// state_read - Read state for a mode
// ============================================================================

export const stateReadTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_read',
  description: 'Read the current state for a specific mode (ralph, ultrawork, autopilot, etc.). Returns the JSON state data or indicates if no state exists.',
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to read state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { mode, workingDirectory } = args;
    const cwd = workingDirectory || process.cwd();

    try {
      const root = getWorktreeRoot(cwd) || cwd;
      const statePath = getStatePath(mode, root);

      // Special handling for swarm (SQLite database)
      if (mode === 'swarm') {
        if (!existsSync(statePath)) {
          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: swarm\nNote: Swarm uses SQLite (swarm.db), not JSON. Expected path: ${statePath}`
            }]
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `## State for swarm\n\nPath: ${statePath}\n\nNote: Swarm uses SQLite database. Use swarm-specific tools to query state.`
          }]
        };
      }

      if (!existsSync(statePath)) {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found for mode: ${mode}\nExpected path: ${statePath}`
          }]
        };
      }

      const content = readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content);

      return {
        content: [{
          type: 'text' as const,
          text: `## State for ${mode}\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// state_write - Write state for a mode
// ============================================================================

export const stateWriteTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  state: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_write',
  description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Use with caution - prefer using mode-specific APIs when available. Note: swarm uses SQLite and cannot be written via this tool.',
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to write state for'),
    state: z.record(z.string(), z.unknown()).describe('The state object to write (JSON)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { mode, state, workingDirectory } = args;
    const cwd = workingDirectory || process.cwd();

    try {
      const root = getWorktreeRoot(cwd) || cwd;

      // Swarm uses SQLite - cannot be written via this tool
      if (mode === 'swarm') {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: Swarm uses SQLite database (swarm.db), not JSON. Use swarm-specific APIs to modify state.`
          }]
        };
      }

      // Ensure state directory exists
      ensureOmcDir('state', root);

      const statePath = getStatePath(mode, root);

      // Add metadata
      const stateWithMeta = {
        ...state,
        _meta: {
          mode,
          updatedAt: new Date().toISOString(),
          updatedBy: 'state_write_tool'
        }
      };

      atomicWriteJsonSync(statePath, stateWithMeta);

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully wrote state for ${mode}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(stateWithMeta, null, 2)}\n\`\`\``
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================

export const stateClearTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_clear',
  description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files.',
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to clear state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { mode, workingDirectory } = args;
    const cwd = workingDirectory || process.cwd();

    try {
      const root = getWorktreeRoot(cwd) || cwd;

      // Use mode registry's clearModeState for known modes
      if (MODE_CONFIGS[mode as ExecutionMode]) {
        const success = clearModeState(mode as ExecutionMode, root);

        if (success) {
          return {
            content: [{
              type: 'text' as const,
              text: `Successfully cleared state for mode: ${mode}`
            }]
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: `Warning: Some files could not be removed for mode: ${mode}`
            }]
          };
        }
      }

      // Fallback for modes not in registry (e.g., ralplan)
      const statePath = getStatePath(mode, root);
      if (existsSync(statePath)) {
        unlinkSync(statePath);
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully cleared state for mode: ${mode}\nRemoved: ${statePath}`
          }]
        };
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found to clear for mode: ${mode}`
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// state_list_active - List all active modes
// ============================================================================

export const stateListActiveTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_list_active',
  description: 'List all currently active modes. Returns which modes have active state files.',
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { workingDirectory } = args;
    const cwd = workingDirectory || process.cwd();

    try {
      const root = getWorktreeRoot(cwd) || cwd;

      // Get active modes from registry (8 modes)
      const activeModes: string[] = [...getActiveModes(root)];

      // Also check ralplan (not in MODE_CONFIGS but has state file)
      const ralplanPath = getStatePath('ralplan', root);
      if (existsSync(ralplanPath)) {
        try {
          const content = readFileSync(ralplanPath, 'utf-8');
          const state = JSON.parse(content);
          if (state.active) {
            activeModes.push('ralplan');
          }
        } catch {
          // Ignore parse errors
        }
      }

      if (activeModes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Active Modes\n\nNo modes are currently active.'
          }]
        };
      }

      const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `## Active Modes (${activeModes.length})\n\n${modeList}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================

export const stateGetStatusTool: ToolDefinition<{
  mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_get_status',
  description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
  schema: {
    mode: z.enum(STATE_TOOL_MODES).optional().describe('Specific mode to check (omit for all modes)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { mode, workingDirectory } = args;
    const cwd = workingDirectory || process.cwd();

    try {
      const root = getWorktreeRoot(cwd) || cwd;

      if (mode) {
        // Single mode status
        const statePath = getStatePath(mode, root);
        const active = MODE_CONFIGS[mode as ExecutionMode]
          ? isModeActive(mode as ExecutionMode, root)
          : existsSync(statePath) && (() => {
              try {
                const content = readFileSync(statePath, 'utf-8');
                const state = JSON.parse(content);
                return state.active === true;
              } catch { return false; }
            })();
        let statePreview = 'No state file';

        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            statePreview = JSON.stringify(state, null, 2).slice(0, 500);
            if (statePreview.length >= 500) statePreview += '\n...(truncated)';
          } catch {
            statePreview = 'Error reading state file';
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `## Status: ${mode}\n\n- **Active:** ${active ? 'Yes' : 'No'}\n- **State Path:** ${statePath}\n- **Exists:** ${existsSync(statePath) ? 'Yes' : 'No'}\n\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``
          }]
        };
      }

      // All modes status
      const statuses = getAllModeStatuses(root);
      const lines = ['## All Mode Statuses\n'];

      for (const status of statuses) {
        const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${status.stateFilePath}\``);
      }

      // Also check ralplan (not in MODE_CONFIGS)
      const ralplanPath = getStatePath('ralplan', root);
      let ralplanActive = false;
      if (existsSync(ralplanPath)) {
        try {
          const content = readFileSync(ralplanPath, 'utf-8');
          const state = JSON.parse(content);
          ralplanActive = state.active === true;
        } catch {
          // Ignore parse errors
        }
      }
      const ralplanIcon = ralplanActive ? '[ACTIVE]' : '[INACTIVE]';
      lines.push(`${ralplanIcon} **ralplan**: ${ralplanActive ? 'Active' : 'Inactive'}`);
      lines.push(`   Path: \`${ralplanPath}\``);

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

/**
 * All state tools for registration
 */
export const stateTools = [
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
];
