/**
 * Project Memory MCP Tools
 *
 * Provides tools for reading and writing project memory.
 */

import { z } from 'zod';
import {
  getWorktreeRoot,
  getWorktreeProjectMemoryPath,
  ensureOmcDir,
  validateWorkingDirectory,
} from '../lib/worktree-paths.js';
import {
  loadProjectMemory,
  saveProjectMemory,
  addCustomNote,
  addDirective,
  formatDirectivesForContext,
  type ProjectMemory,
  type CustomNote,
  type UserDirective,
} from '../hooks/project-memory/index.js';
import { ToolDefinition } from './types.js';

// ============================================================================
// project_memory_read - Read project memory
// ============================================================================

export const projectMemoryReadTool: ToolDefinition<{
  section: z.ZodOptional<z.ZodEnum<['all', 'techStack', 'build', 'conventions', 'structure', 'notes', 'directives']>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'project_memory_read',
  description: 'Read the project memory. Can read the full memory or a specific section.',
  schema: {
    section: z.enum(['all', 'techStack', 'build', 'conventions', 'structure', 'notes', 'directives']).optional()
      .describe('Section to read (default: all)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { section = 'all', workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const memory = await loadProjectMemory(root);

      if (!memory) {
        return {
          content: [{
            type: 'text' as const,
            text: `Project memory does not exist.\nExpected path: ${getWorktreeProjectMemoryPath(root)}\n\nRun a session to auto-detect project environment, or use project_memory_write to create manually.`
          }]
        };
      }

      if (section === 'all') {
        return {
          content: [{
            type: 'text' as const,
            text: `## Project Memory\n\nPath: ${getWorktreeProjectMemoryPath(root)}\n\n\`\`\`json\n${JSON.stringify(memory, null, 2)}\n\`\`\``
          }]
        };
      }

      // Return specific section
      const sectionMap: Record<string, keyof ProjectMemory | 'notes' | 'directives'> = {
        techStack: 'techStack',
        build: 'build',
        conventions: 'conventions',
        structure: 'structure',
        notes: 'customNotes',
        directives: 'userDirectives',
      };

      const key = sectionMap[section];
      const data = key === 'notes' ? memory.customNotes
                 : key === 'directives' ? memory.userDirectives
                 : memory[key as keyof ProjectMemory];

      return {
        content: [{
          type: 'text' as const,
          text: `## Project Memory: ${section}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading project memory: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// project_memory_write - Write project memory
// ============================================================================

export const projectMemoryWriteTool: ToolDefinition<{
  memory: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  merge: z.ZodOptional<z.ZodBoolean>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'project_memory_write',
  description: 'Write/update project memory. Can replace entirely or merge with existing memory.',
  schema: {
    memory: z.record(z.string(), z.unknown()).describe('The memory object to write'),
    merge: z.boolean().optional().describe('If true, merge with existing memory (default: false = replace)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { memory, merge = false, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure .omc directory exists
      ensureOmcDir('', root);

      let finalMemory: ProjectMemory;

      if (merge) {
        const existing = await loadProjectMemory(root);
        if (existing) {
          finalMemory = { ...existing, ...memory } as unknown as ProjectMemory;
        } else {
          finalMemory = memory as unknown as ProjectMemory;
        }
      } else {
        finalMemory = memory as unknown as ProjectMemory;
      }

      // Ensure required fields
      if (!finalMemory.version) finalMemory.version = '1.0.0';
      if (!finalMemory.lastScanned) finalMemory.lastScanned = Date.now();
      if (!finalMemory.projectRoot) finalMemory.projectRoot = root;

      await saveProjectMemory(root, finalMemory);

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully ${merge ? 'merged' : 'wrote'} project memory.\nPath: ${getWorktreeProjectMemoryPath(root)}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing project memory: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// project_memory_add_note - Add a custom note
// ============================================================================

export const projectMemoryAddNoteTool: ToolDefinition<{
  category: z.ZodString;
  content: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'project_memory_add_note',
  description: 'Add a custom note to project memory. Notes are categorized and persisted across sessions.',
  schema: {
    category: z.string().max(50).describe('Note category (e.g., "build", "test", "deploy", "env", "architecture")'),
    content: z.string().max(1000).describe('Note content'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { category, content, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure memory exists
      let memory = await loadProjectMemory(root);
      if (!memory) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Project memory does not exist. Run a session first to auto-detect project environment.'
          }]
        };
      }

      await addCustomNote(root, category, content);

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully added note to project memory.\n\n- **Category:** ${category}\n- **Content:** ${content}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error adding note: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// project_memory_add_directive - Add a user directive
// ============================================================================

export const projectMemoryAddDirectiveTool: ToolDefinition<{
  directive: z.ZodString;
  context: z.ZodOptional<z.ZodString>;
  priority: z.ZodOptional<z.ZodEnum<['high', 'normal']>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'project_memory_add_directive',
  description: 'Add a user directive to project memory. Directives are instructions that persist across sessions and survive compaction.',
  schema: {
    directive: z.string().max(500).describe('The directive (e.g., "Always use TypeScript strict mode")'),
    context: z.string().max(500).optional().describe('Additional context for the directive'),
    priority: z.enum(['high', 'normal']).optional().describe('Priority level (default: normal)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { directive, context = '', priority = 'normal', workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);

      // Ensure memory exists
      let memory = await loadProjectMemory(root);
      if (!memory) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Project memory does not exist. Run a session first to auto-detect project environment.'
          }]
        };
      }

      const newDirective: UserDirective = {
        timestamp: Date.now(),
        directive,
        context,
        source: 'explicit',
        priority,
      };

      memory.userDirectives = addDirective(memory.userDirectives, newDirective);
      await saveProjectMemory(root, memory);

      return {
        content: [{
          type: 'text' as const,
          text: `Successfully added directive to project memory.\n\n- **Directive:** ${directive}\n- **Priority:** ${priority}\n- **Context:** ${context || '(none)'}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error adding directive: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

/**
 * All memory tools for registration
 */
export const memoryTools = [
  projectMemoryReadTool,
  projectMemoryWriteTool,
  projectMemoryAddNoteTool,
  projectMemoryAddDirectiveTool,
];
