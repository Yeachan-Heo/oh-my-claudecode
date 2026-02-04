/**
 * Shared Tool Definition Types
 *
 * Common interfaces for MCP tool definitions used across
 * state-tools, notepad-tools, memory-tools, and lsp-tools.
 */

import { z } from 'zod';

/**
 * Tool Definition interface for MCP tools.
 *
 * Each tool defines:
 * - name: Tool identifier (used as mcp__t__{name})
 * - description: Human-readable description for tool discovery
 * - schema: Zod schema defining input parameters
 * - handler: Async function that processes the tool call
 */
export interface ToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}
