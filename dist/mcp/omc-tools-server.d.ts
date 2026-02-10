/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for use by subagents.
 */
/**
 * In-process MCP server exposing all OMC custom tools
 *
 * Tools will be available as mcp__t__<tool_name>
 */
export declare const omcToolsServer: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
/**
 * Tool names in MCP format for allowedTools configuration
 */
export declare const omcToolNames: string[];
/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export declare function getOmcToolNames(options?: {
    includeLsp?: boolean;
    includeAst?: boolean;
    includePython?: boolean;
    includeSkills?: boolean;
    includeState?: boolean;
    includeNotepad?: boolean;
    includeMemory?: boolean;
    includeTrace?: boolean;
}): string[];
//# sourceMappingURL=omc-tools-server.d.ts.map