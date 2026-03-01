/**
 * Shared Memory MCP Tools
 *
 * Provides tools for cross-session memory sync between agents
 * in /team and /pipeline workflows. Agents can write, read, list,
 * delete, and clean up shared key-value entries namespaced by
 * session group or pipeline run.
 *
 * Storage: .omc/state/shared-memory/{namespace}/{key}.json
 * Config gate: agents.sharedMemory.enabled in ~/.claude/.omc-config.json
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1119
 */

import { z } from 'zod';
import { validateWorkingDirectory } from '../lib/worktree-paths.js';
import {
  isSharedMemoryEnabled,
  writeEntry,
  readEntry,
  listEntries,
  deleteEntry,
  cleanupExpired,
  listNamespaces,
} from '../lib/shared-memory.js';
import type { ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISABLED_MSG = 'Shared memory is disabled. Set agents.sharedMemory.enabled = true in ~/.claude/.omc-config.json to enable.';

function disabledResponse() {
  return {
    content: [{ type: 'text' as const, text: DISABLED_MSG }],
    isError: true,
  };
}

function errorResponse(msg: string) {
  return {
    content: [{ type: 'text' as const, text: msg }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// shared_memory_write
// ---------------------------------------------------------------------------

export const sharedMemoryWriteTool: ToolDefinition<{
  key: z.ZodString;
  value: z.ZodUnknown;
  namespace: z.ZodString;
  ttl: z.ZodOptional<z.ZodNumber>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'shared_memory_write',
  description: 'Write a key-value pair to shared memory for cross-agent handoffs. Namespace by session group or pipeline run. Supports optional TTL for auto-expiry.',
  schema: {
    key: z.string().min(1).max(128).describe('Key identifier (alphanumeric, hyphens, underscores, dots)'),
    value: z.unknown().describe('JSON-serializable value to store'),
    namespace: z.string().min(1).max(128).describe('Namespace for grouping (e.g., team name, pipeline run ID, session group)'),
    ttl: z.number().int().min(1).max(604800).optional().describe('Time-to-live in seconds (max 7 days). Omit for no expiry.'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    if (!isSharedMemoryEnabled()) return disabledResponse();

    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const entry = writeEntry(args.namespace, args.key, args.value, args.ttl, root);

      let text = `Successfully wrote to shared memory.\n\n- **Namespace:** ${entry.namespace}\n- **Key:** ${entry.key}\n- **Updated:** ${entry.updatedAt}`;
      if (entry.ttl) {
        text += `\n- **TTL:** ${entry.ttl}s\n- **Expires:** ${entry.expiresAt}`;
      }

      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      return errorResponse(`Error writing shared memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// shared_memory_read
// ---------------------------------------------------------------------------

export const sharedMemoryReadTool: ToolDefinition<{
  key: z.ZodString;
  namespace: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'shared_memory_read',
  description: 'Read a value from shared memory by key and namespace. Returns null if the key does not exist or has expired.',
  schema: {
    key: z.string().min(1).max(128).describe('Key to read'),
    namespace: z.string().min(1).max(128).describe('Namespace to read from'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    if (!isSharedMemoryEnabled()) return disabledResponse();

    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const entry = readEntry(args.namespace, args.key, root);

      if (!entry) {
        return {
          content: [{
            type: 'text' as const,
            text: `Key "${args.key}" not found in namespace "${args.namespace}" (or has expired).`,
          }],
        };
      }

      const meta = [
        `- **Namespace:** ${entry.namespace}`,
        `- **Key:** ${entry.key}`,
        `- **Created:** ${entry.createdAt}`,
        `- **Updated:** ${entry.updatedAt}`,
      ];
      if (entry.expiresAt) {
        meta.push(`- **Expires:** ${entry.expiresAt}`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: `## Shared Memory Entry\n\n${meta.join('\n')}\n\n### Value\n\n\`\`\`json\n${JSON.stringify(entry.value, null, 2)}\n\`\`\``,
        }],
      };
    } catch (error) {
      return errorResponse(`Error reading shared memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// shared_memory_list
// ---------------------------------------------------------------------------

export const sharedMemoryListTool: ToolDefinition<{
  namespace: z.ZodOptional<z.ZodString>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'shared_memory_list',
  description: 'List keys in a shared memory namespace, or list all namespaces if no namespace is provided.',
  schema: {
    namespace: z.string().min(1).max(128).optional().describe('Namespace to list keys from. Omit to list all namespaces.'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    if (!isSharedMemoryEnabled()) return disabledResponse();

    try {
      const root = validateWorkingDirectory(args.workingDirectory);

      if (!args.namespace) {
        // List all namespaces
        const namespaces = listNamespaces(root);
        if (namespaces.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No shared memory namespaces found.' }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `## Shared Memory Namespaces\n\n${namespaces.map(ns => `- ${ns}`).join('\n')}`,
          }],
        };
      }

      // List keys in namespace
      const items = listEntries(args.namespace, root);
      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No entries in namespace "${args.namespace}".`,
          }],
        };
      }

      const lines = items.map(item => {
        let line = `- **${item.key}** (updated: ${item.updatedAt})`;
        if (item.expiresAt) line += ` [expires: ${item.expiresAt}]`;
        return line;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `## Shared Memory: ${args.namespace}\n\n${items.length} entries:\n\n${lines.join('\n')}`,
        }],
      };
    } catch (error) {
      return errorResponse(`Error listing shared memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// shared_memory_delete
// ---------------------------------------------------------------------------

export const sharedMemoryDeleteTool: ToolDefinition<{
  key: z.ZodString;
  namespace: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'shared_memory_delete',
  description: 'Delete a key from shared memory.',
  schema: {
    key: z.string().min(1).max(128).describe('Key to delete'),
    namespace: z.string().min(1).max(128).describe('Namespace to delete from'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    if (!isSharedMemoryEnabled()) return disabledResponse();

    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const deleted = deleteEntry(args.namespace, args.key, root);

      if (!deleted) {
        return {
          content: [{
            type: 'text' as const,
            text: `Key "${args.key}" not found in namespace "${args.namespace}".`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Deleted key "${args.key}" from namespace "${args.namespace}".`,
        }],
      };
    } catch (error) {
      return errorResponse(`Error deleting shared memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// shared_memory_cleanup
// ---------------------------------------------------------------------------

export const sharedMemoryCleanupTool: ToolDefinition<{
  namespace: z.ZodOptional<z.ZodString>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'shared_memory_cleanup',
  description: 'Remove expired entries from shared memory. Cleans a specific namespace or all namespaces.',
  schema: {
    namespace: z.string().min(1).max(128).optional().describe('Namespace to clean. Omit to clean all namespaces.'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    if (!isSharedMemoryEnabled()) return disabledResponse();

    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const result = cleanupExpired(args.namespace, root);

      if (result.removed === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No expired entries found.',
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `## Cleanup Results\n\n- **Removed:** ${result.removed} expired entries\n- **Namespaces cleaned:** ${result.namespaces.join(', ')}`,
        }],
      };
    } catch (error) {
      return errorResponse(`Error cleaning shared memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Export all tools
// ---------------------------------------------------------------------------

export const sharedMemoryTools = [
  sharedMemoryWriteTool,
  sharedMemoryReadTool,
  sharedMemoryListTool,
  sharedMemoryDeleteTool,
  sharedMemoryCleanupTool,
];
