/**
 * Gemini MCP Server - In-process MCP server for Google Gemini CLI integration
 *
 * Exposes `ask_gemini` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__g__ask_gemini
 *
 * Note: The standalone version (gemini-standalone-server.ts) is used for the
 * external-process .mcp.json registration with proper stdio transport.
 */
/**
 * In-process MCP server exposing Gemini CLI integration
 *
 * Tools will be available as mcp__g__ask_gemini
 */
export declare const geminiMcpServer: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
/**
 * Tool names for allowedTools configuration
 */
export declare const geminiToolNames: string[];
//# sourceMappingURL=gemini-server.d.ts.map