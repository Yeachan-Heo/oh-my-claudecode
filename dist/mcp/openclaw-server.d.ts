/**
 * OpenClaw MCP Server - In-process MCP server for OpenClaw integration
 *
 * Exposes `spawn_agent` and `send_to_session` tools via the SDK.
 * Tools will be available as mcp__oc__spawn_agent, etc.
 */
/**
 * In-process MCP server exposing OpenClaw CLI integration
 */
export declare const openclawMcpServer: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
/**
 * Tool names for allowedTools configuration
 */
export declare const openclawToolNames: string[];
//# sourceMappingURL=openclaw-server.d.ts.map