/**
 * Shared Tool Definition Types
 *
 * Common interfaces for MCP tool definitions used across
 * state-tools, notepad-tools, memory-tools, and lsp-tools.
 */

import { z } from 'zod';
import type { ToolCategory } from '../constants/index.js';

/**
 * Tool Definition interface for MCP tools.
 *
 * Each tool defines:
 * - name: Tool identifier (used as mcp__t__{name})
 * - description: Human-readable description for tool discovery
 * - schema: Zod schema defining input parameters
 * - handler: Async function that processes the tool call
 * - category: Tool category for filtering (lsp, ast, state, etc.)
 */
export interface ToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  category?: ToolCategory;
  schema: T;
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}
