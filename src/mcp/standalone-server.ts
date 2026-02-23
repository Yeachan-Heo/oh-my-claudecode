#!/usr/bin/env node
/**
 * Standalone MCP Server for OMC Tools
 *
 * This server exposes LSP, AST, and Python REPL tools via stdio transport
 * for discovery by Claude Code's MCP management system.
 *
 * Usage: node dist/mcp/standalone-server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
import { z } from 'zod';

// Tool interface matching our tool definitions
interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

// Aggregate all tools - AST tools gracefully degrade if @ast-grep/napi is unavailable
// Team runtime tools (omc_run_team_start, omc_run_team_status) live in the
// separate "team" MCP server (bridge/team-mcp.cjs) registered in .mcp.json.
const allTools: ToolDef[] = [
  ...(lspTools as unknown as ToolDef[]),
  ...(astTools as unknown as ToolDef[]),
  pythonReplTool as unknown as ToolDef,
  ...(stateTools as unknown as ToolDef[]),
  ...(notepadTools as unknown as ToolDef[]),
  ...(memoryTools as unknown as ToolDef[]),
  ...(traceTools as unknown as ToolDef[]),
];

// Convert Zod schema to JSON Schema for MCP
function zodToJsonSchema(schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  // Handle both ZodObject and raw shape
  const rawShape = schema instanceof z.ZodObject ? schema.shape : schema;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(rawShape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(zodType);

    // Check if required (not optional) - with safety check
    const isOptional = zodType && typeof zodType.isOptional === 'function' && zodType.isOptional();
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required
  };
}

function zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Safety check for undefined zodType
  if (!zodType || !zodType._def) {
    return { type: 'string' };
  }

  // Handle optional wrapper
  if (zodType instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(zodType._def.innerType);
  }

  // Handle default wrapper
  if (zodType instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(zodType._def.innerType);
    inner.default = zodType._def.defaultValue();
    return inner;
  }

  // Get description if available
  const description = zodType._def?.description;
  if (description) {
    result.description = description;
  }

  // Handle basic types
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
    // Handle z.record() - maps to JSON object with additionalProperties
    result.type = 'object';
    if (zodType._def?.valueType) {
      result.additionalProperties = zodTypeToJsonSchema(zodType._def.valueType);
    }
  } else {
    result.type = 'string';
  }

  return result;
}

// Create the MCP server
const server = new Server(
  {
    name: 't',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema),
    })),
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = allTools.find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler((args ?? {}) as unknown);
    return {
      content: result.content,
      isError: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Graceful shutdown: disconnect LSP servers on process termination (#768).
// Without this, LSP child processes (e.g. jdtls) survive the MCP server exit
// and become orphaned, consuming memory indefinitely.
// The MCP server process owns the LSP child processes (spawned via
// child_process.spawn in LspClient.connect), so cleanup must happen here.
import { disconnectAll as disconnectAllLsp } from '../tools/lsp/index.js';

async function gracefulShutdown(signal: string): Promise<void> {
  // Hard deadline: exit even if cleanup hangs (e.g. unresponsive LSP server)
  const forceExitTimer = setTimeout(() => process.exit(1), 5_000);
  forceExitTimer.unref();

  console.error(`OMC MCP Server: received ${signal}, disconnecting LSP servers...`);

  try {
    await disconnectAllLsp();
  } catch {
    // Best-effort — do not block exit
  }
  try {
    await server.close();
  } catch {
    // Best-effort — MCP transport cleanup
  }
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OMC Tools MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
