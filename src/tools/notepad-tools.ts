/**
 * Notepad MCP Tools
 *
 * Provides tools for reading and writing notepad sections
 * (Priority Context, Working Memory, MANUAL).
 */

import { z } from 'zod';
import {
  getWorktreeNotepadPath,
  ensureOmcDir,
  validateWorkingDirectory,
} from '../lib/worktree-paths.js';
import {
  getPriorityContext,
  getWorkingMemory,
  getManualSection,
  setPriorityContext,
  addWorkingMemoryEntry,
  addManualEntry,
  pruneOldEntries,
  getNotepadStats,
  formatFullNotepad,
  DEFAULT_CONFIG,
} from '../hooks/notepad/index.js';
import { ToolDefinition } from './types.js';

const SECTION_NAMES: [string, ...string[]] = ['all', 'priority', 'working', 'manual'];

// ============================================================================
// notepad_read - Read notepad content
// ============================================================================

export const notepadReadTool: ToolDefinition<{
  section: z.ZodOptional<z.ZodEnum<typeof SECTION_NAMES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_read',
  description: 'Read the notepad content. Can read the full notepad or a specific section (priority, working, manual).',
  schema: {
    section: z.enum(SECTION_NAMES).optional().describe('Section to read: "all" (default), "priority", "working", or "manual"'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { section = 'all', workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      if (section === 'all') {
        const content = formatFullNotepad(root);
        if (!content) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Notepad does not exist. Use notepad_write_* tools to create it.'
            }]
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `## Notepad\n\nPath: ${getWorktreeNotepadPath(root)}\n\n${content}`
          }]
        };
      }

      let sectionContent: string | null = null;
      let sectionTitle = '';

      switch (section) {
        case 'priority':
          sectionContent = getPriorityContext(root);
          sectionTitle = 'Priority Context';
          break;
        case 'working':
          sectionContent = getWorkingMemory(root);
          sectionTitle = 'Working Memory';
          break;
        case 'manual':
          sectionContent = getManualSection(root);
          sectionTitle = 'MANUAL';
          break;
      }

      if (!sectionContent) {
        return {
          content: [{
            type: 'text' as const,
            text: `## ${sectionTitle}\n\n(Empty or notepad does not exist)`
          }]
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `## ${sectionTitle}\n\n${sectionContent}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading notepad: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// notepad_write_priority - Write to Priority Context
// ============================================================================

export const notepadWritePriorityTool: ToolDefinition<{
  content: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_write_priority',
  description: 'Write to the Priority Context section. This REPLACES the existing content. Keep under 500 chars - this is always loaded at session start.',
  schema: {
    content: z.string().max(2000).describe('Content to write (recommend under 500 chars)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { content, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure .omc directory exists
      ensureOmcDir('', root);

      const result = setPriorityContext(root, content);

      if (!result.success) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to write to Priority Context. Check file permissions.'
          }]
        };
      }

      let response = `Successfully wrote to Priority Context (${content.length} chars)`;
      if (result.warning) {
        response += `\n\n**Warning:** ${result.warning}`;
      }

      return {
        content: [{
          type: 'text' as const,
          text: response
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing to Priority Context: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// notepad_write_working - Add to Working Memory
// ============================================================================

export const notepadWriteWorkingTool: ToolDefinition<{
  content: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_write_working',
  description: 'Add an entry to Working Memory section. Entries are timestamped and auto-pruned after 7 days.',
  schema: {
    content: z.string().max(4000).describe('Content to add as a new entry'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { content, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure .omc directory exists
      ensureOmcDir('', root);

      const success = addWorkingMemoryEntry(root, content);

      if (!success) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to add entry to Working Memory. Check file permissions.'
          }]
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully added entry to Working Memory (${content.length} chars)`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing to Working Memory: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// notepad_write_manual - Add to MANUAL section
// ============================================================================

export const notepadWriteManualTool: ToolDefinition<{
  content: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_write_manual',
  description: 'Add an entry to the MANUAL section. Content in this section is never auto-pruned.',
  schema: {
    content: z.string().max(4000).describe('Content to add as a new entry'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { content, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure .omc directory exists
      ensureOmcDir('', root);

      const success = addManualEntry(root, content);

      if (!success) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to add entry to MANUAL section. Check file permissions.'
          }]
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully added entry to MANUAL section (${content.length} chars)`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing to MANUAL: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// notepad_prune - Prune old Working Memory entries
// ============================================================================

export const notepadPruneTool: ToolDefinition<{
  daysOld: z.ZodOptional<z.ZodNumber>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_prune',
  description: 'Prune Working Memory entries older than N days (default: 7 days).',
  schema: {
    daysOld: z.number().int().min(1).max(365).optional().describe('Remove entries older than this many days (default: 7)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { daysOld = DEFAULT_CONFIG.workingMemoryDays, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const result = pruneOldEntries(root, daysOld);

      return {
        content: [{
          type: 'text' as const,
          text: `## Prune Results\n\n- Pruned: ${result.pruned} entries\n- Remaining: ${result.remaining} entries\n- Threshold: ${daysOld} days`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error pruning notepad: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// notepad_stats - Get notepad statistics
// ============================================================================

export const notepadStatsTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'notepad_stats',
  description: 'Get statistics about the notepad (size, entry count, oldest entry).',
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const stats = getNotepadStats(root);

      if (!stats.exists) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Notepad Statistics\n\nNotepad does not exist yet.'
          }]
        };
      }

      const lines = [
        '## Notepad Statistics\n',
        `- **Total Size:** ${stats.totalSize} bytes`,
        `- **Priority Context Size:** ${stats.prioritySize} bytes`,
        `- **Working Memory Entries:** ${stats.workingMemoryEntries}`,
        `- **Oldest Entry:** ${stats.oldestEntry || 'None'}`,
        `- **Path:** ${getWorktreeNotepadPath(root)}`,
      ];

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
          text: `Error getting notepad stats: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

/**
 * All notepad tools for registration
 */
export const notepadTools = [
  notepadReadTool,
  notepadWritePriorityTool,
  notepadWriteWorkingTool,
  notepadWriteManualTool,
  notepadPruneTool,
  notepadStatsTool,
];
