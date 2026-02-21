/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for use by subagents.
 */
import { type ToolCategory } from "../constants/index.js";
/**
 * Map from user-facing OMC_DISABLE_TOOLS group names to ToolCategory values.
 * Supports both canonical names and common aliases.
 */
export declare const DISABLE_TOOLS_GROUP_MAP: Record<string, ToolCategory>;
/**
 * Parse OMC_DISABLE_TOOLS env var value into a Set of disabled ToolCategory values.
 *
 * Accepts a comma-separated list of group names (case-insensitive).
 * Unknown names are silently ignored.
 *
 * @param envValue - The env var value to parse. Defaults to process.env.OMC_DISABLE_TOOLS.
 * @returns Set of ToolCategory values that should be disabled.
 *
 * @example
 * // OMC_DISABLE_TOOLS=lsp,python-repl,project-memory
 * parseDisabledGroups(); // Set { 'lsp', 'python', 'memory' }
 */
export declare function parseDisabledGroups(envValue?: string): Set<ToolCategory>;
/**
 * In-process MCP server exposing all OMC custom tools
 *
 * Tools will be available as mcp__t__<tool_name>.
 * Tools in disabled groups (via OMC_DISABLE_TOOLS) are excluded at startup.
 */
export declare const omcToolsServer: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
/**
 * Tool names in MCP format for allowedTools configuration.
 * Only includes tools that are enabled (not disabled via OMC_DISABLE_TOOLS).
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