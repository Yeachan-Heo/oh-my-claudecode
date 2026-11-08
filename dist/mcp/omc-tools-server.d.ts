/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for local Node.js Agent SDK integrations. This is not a VS Code
 * extension host or CI runner by itself.
 */
export { DISABLE_TOOLS_GROUP_MAP, parseDisabledGroups } from "./disable-tools.js";
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
interface ToolNameFilterOptions {
    includeLsp?: boolean;
    includeAst?: boolean;
    includePython?: boolean;
    includeSkills?: boolean;
    includeState?: boolean;
    includeNotepad?: boolean;
    includeMemory?: boolean;
    includeTrace?: boolean;
    includeInterop?: boolean;
    includeSharedMemory?: boolean;
    includeDeepinit?: boolean;
    includeWiki?: boolean;
}
/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export declare function getOmcToolNames(options?: ToolNameFilterOptions): string[];
/**
 * Test-only helper for deterministic category-filter verification independent of env startup state.
 */
export declare function _getAllToolNamesForTests(options?: ToolNameFilterOptions): string[];
//# sourceMappingURL=omc-tools-server.d.ts.map