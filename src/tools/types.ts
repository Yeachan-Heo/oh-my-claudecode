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
/**
 * MCP Tool Annotations per the MCP specification.
 * Used by clients (e.g. Claude Code) to prioritize tool loading
 * and avoid deferring critical tools.
 */
export interface ToolAnnotations {
  /** If true, the tool does not modify any state. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive operations (only meaningful when readOnlyHint is false). */
  destructiveHint?: boolean;
  /** If true, the tool may interact with the "real world" outside the computing environment. */
  openWorldHint?: boolean;
}

export interface ToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  category?: ToolCategory;
  annotations?: ToolAnnotations;
  schema: T;
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}
