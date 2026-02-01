/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for use by subagents.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { lspTools } from "../tools/lsp-tools.js";
import { astTools } from "../tools/ast-tools.js";
import { pythonReplTool } from "../tools/python-repl/index.js";
import { skillsTools } from "../tools/skills-tools.js";

// Type for our tool definitions
interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

// Aggregate all custom tools
const allTools: ToolDef[] = [
  ...(lspTools as unknown as ToolDef[]),
  ...(astTools as unknown as ToolDef[]),
  pythonReplTool as unknown as ToolDef,
  ...(skillsTools as unknown as ToolDef[])
];

// Convert to SDK tool format
// The SDK's tool() expects a ZodRawShape directly (not wrapped in z.object())
const sdkTools = allTools.map(t =>
  tool(
    t.name,
    t.description,
    t.schema as Parameters<typeof tool>[2],
    async (args: unknown) => await t.handler(args)
  )
);

/**
 * In-process MCP server exposing all OMC custom tools
 *
 * Tools will be available as mcp__t__<tool_name>
 */
export const omcToolsServer = createSdkMcpServer({
  name: "t",
  version: "1.0.0",
  tools: sdkTools
});

/**
 * Tool names in MCP format for allowedTools configuration
 */
export const omcToolNames = allTools.map(t => `mcp__t__${t.name}`);

/**
 * Get tool names filtered by category
 */
export function getOmcToolNames(options?: {
  includeLsp?: boolean;
  includeAst?: boolean;
  includePython?: boolean;
  includeSkills?: boolean;
}): string[] {
  const { includeLsp = true, includeAst = true, includePython = true, includeSkills = true } = options || {};

  return omcToolNames.filter(name => {
    if (!includeLsp && name.includes('lsp_')) return false;
    if (!includeAst && name.includes('ast_')) return false;
    if (!includePython && name.includes('python_repl')) return false;
    if (!includeSkills && (name.includes('load_omc_skills') || name.includes('list_omc_skills'))) return false;
    return true;
  });
}
