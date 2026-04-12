/**
 * Tool Registry for the Standalone MCP Server
 *
 * Single source of truth for the tool surface exposed by standalone-server.ts.
 * Extracted here so tests can import the same aggregation path without triggering
 * server-side effects (Server construction, transport startup, process.exit hooks).
 *
 * AST tools (ast_grep_search, ast_grep_replace) gracefully degrade at *runtime*
 * when @ast-grep/napi is unavailable — they are always present in the registry
 * but return a helpful error message instead of results.
 *
 * Team runtime tools (omc_run_team_start, omc_run_team_status) are intentionally
 * excluded: they live in the separate "team" MCP server (bridge/team-mcp.cjs).
 */

import { lspTools } from '../tools/lsp-tools.js';
import { astTools } from '../tools/ast-tools.js';
// IMPORTANT: Import from tool.js, NOT index.js!
// tool.js exports pythonReplTool with wrapped handler returning { content: [...] }
// index.js exports pythonReplTool with raw handler returning string
import { pythonReplTool } from '../tools/python-repl/tool.js';
import { stateTools } from '../tools/state-tools.js';
import { notepadTools } from '../tools/notepad-tools.js';
import { memoryTools } from '../tools/memory-tools.js';
import { traceTools } from '../tools/trace-tools.js';
import { sharedMemoryTools } from '../tools/shared-memory-tools.js';
import { deepinitManifestTool } from '../tools/deepinit-manifest.js';
import { wikiTools } from '../tools/wiki-tools.js';
import { skillsTools } from '../tools/skills-tools.js';
import { z } from 'zod';

/** Minimal tool definition shape shared across all tool families. */
export interface ToolDef {
  name: string;
  description: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>;
  handler: (
    args: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

/** All tools exposed by the standalone server, in registration order. */
export const allTools: ToolDef[] = [
  ...(lspTools as unknown as ToolDef[]),
  ...(astTools as unknown as ToolDef[]),
  pythonReplTool as unknown as ToolDef,
  ...(stateTools as unknown as ToolDef[]),
  ...(notepadTools as unknown as ToolDef[]),
  ...(memoryTools as unknown as ToolDef[]),
  ...(traceTools as unknown as ToolDef[]),
  ...(sharedMemoryTools as unknown as ToolDef[]),
  deepinitManifestTool as unknown as ToolDef,
  ...(wikiTools as unknown as ToolDef[]),
  ...(skillsTools as unknown as ToolDef[]),
];

// ---------------------------------------------------------------------------
// Zod → JSON Schema helpers (mirrors what the MCP server sends over the wire)
// ---------------------------------------------------------------------------

function zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!zodType || !zodType._def) {
    return { type: 'string' };
  }

  if (zodType instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(zodType._def.innerType);
  }

  if (zodType instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(zodType._def.innerType);
    inner.default = zodType._def.defaultValue();
    return inner;
  }

  const description = zodType._def?.description;
  if (description) {
    result.description = description;
  }

  if (zodType instanceof z.ZodString) {
    result.type = 'string';
  } else if (zodType instanceof z.ZodNumber) {
    result.type = zodType._def?.checks?.some((c: { kind: string }) => c.kind === 'int')
      ? 'integer'
      : 'number';
  } else if (zodType instanceof z.ZodBoolean) {
    result.type = 'boolean';
  } else if (zodType instanceof z.ZodArray) {
    result.type = 'array';
    result.items = zodType._def?.type ? zodTypeToJsonSchema(zodType._def.type) : { type: 'string' };
  } else if (zodType instanceof z.ZodEnum) {
    result.type = 'string';
    result.enum = zodType._def?.values;
  } else if (zodType instanceof z.ZodObject) {
    return zodToJsonSchema(zodType.shape);
  } else if (zodType instanceof z.ZodRecord) {
    result.type = 'object';
    if (zodType._def?.valueType) {
      result.additionalProperties = zodTypeToJsonSchema(zodType._def.valueType);
    }
  } else {
    result.type = 'string';
  }

  return result;
}

export function zodToJsonSchema(schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const rawShape = schema instanceof z.ZodObject ? schema.shape : schema;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(rawShape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(zodType);

    const isOptional =
      zodType && typeof zodType.isOptional === 'function' && zodType.isOptional();
    if (!isOptional) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required };
}

/** The exact payload returned by the ListTools MCP handler. */
export interface ListToolsEntry {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  annotations?: ToolDef['annotations'];
}

/**
 * Build the ListTools response payload exactly as standalone-server.ts sends it.
 * Tests call this directly to exercise the same code path as the live server.
 */
export function buildListToolsResponse(): { tools: ListToolsEntry[] } {
  return {
    tools: allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  };
}
