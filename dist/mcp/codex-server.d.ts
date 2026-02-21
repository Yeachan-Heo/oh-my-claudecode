/**
 * Codex MCP Server - In-process MCP server for OpenAI Codex CLI integration
 *
 * Exposes `ask_codex` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__x__ask_codex
 *
 * Note: The standalone version (codex-standalone-server.ts) is used for the
 * external-process .mcp.json registration with proper stdio transport.
 */
/**
 * In-process MCP server exposing Codex CLI integration
 *
 * Tools will be available as mcp__x__ask_codex
 */
export declare const codexMcpServer: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
/**
 * Tool names for allowedTools configuration
 */
export declare const codexToolNames: string[];
//# sourceMappingURL=codex-server.d.ts.map