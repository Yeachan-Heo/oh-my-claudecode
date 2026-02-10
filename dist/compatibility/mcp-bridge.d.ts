/**
 * MCP Server Bridge
 *
 * Connects to MCP servers and exposes their tools to OMC.
 * Handles:
 * - Server lifecycle (spawn, connect, disconnect)
 * - Tool discovery from MCP servers
 * - Tool invocation routing
 * - Resource access
 */
import { EventEmitter } from 'events';
import type { McpServerEntry, ExternalTool, McpToolResult } from './types.js';
/**
 * Security Error for MCP bridge operations
 */
export declare class McpSecurityError extends Error {
    constructor(message: string);
}
interface McpToolDefinition {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
interface McpResourceDefinition {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
/**
 * MCP Bridge - Manages connections to MCP servers
 */
export declare class McpBridge extends EventEmitter {
    private connections;
    private serverConfigs;
    /**
     * Register a server configuration
     */
    registerServer(name: string, config: McpServerEntry): void;
    /**
     * Connect to an MCP server
     */
    connect(serverName: string): Promise<ExternalTool[]>;
    /**
     * Disconnect from an MCP server
     */
    disconnect(serverName: string): void;
    /**
     * Disconnect from all servers
     */
    disconnectAll(): void;
    /**
     * Check if connected to a server
     */
    isConnected(serverName: string): boolean;
    /**
     * Invoke a tool on an MCP server
     */
    invokeTool(serverName: string, toolName: string, arguments_: Record<string, unknown>): Promise<McpToolResult>;
    /**
     * Read a resource from an MCP server
     */
    readResource(serverName: string, uri: string): Promise<McpToolResult>;
    /**
     * Get available tools from a connected server
     */
    getServerTools(serverName: string): McpToolDefinition[];
    /**
     * Get available resources from a connected server
     */
    getServerResources(serverName: string): McpResourceDefinition[];
    /**
     * Wait for server to be ready
     */
    private waitForReady;
    /**
     * Initialize the MCP connection
     */
    private initialize;
    /**
     * List available tools from server
     */
    private listTools;
    /**
     * List available resources from server
     */
    private listResources;
    /**
     * Send an MCP request and wait for response
     */
    private sendRequest;
    /**
     * Send an MCP notification (no response expected)
     */
    private sendNotification;
    /**
     * Handle incoming data from server
     */
    private handleData;
    /**
     * Handle a parsed MCP message
     */
    private handleMessage;
    /**
     * Convert MCP tools to ExternalTool format
     */
    private convertToExternalTools;
    /**
     * Infer capabilities from tool name and description
     */
    private inferCapabilities;
    /**
     * Auto-connect to enabled servers from registry
     */
    autoConnect(): Promise<Map<string, ExternalTool[]>>;
    /**
     * Get connection status for all servers
     */
    getConnectionStatus(): Map<string, boolean>;
}
/**
 * Get the MCP bridge singleton
 */
export declare function getMcpBridge(): McpBridge;
/**
 * Reset bridge instance (for testing)
 */
export declare function resetMcpBridge(): void;
/**
 * Quick access to invoke a tool
 */
export declare function invokeMcpTool(serverName: string, toolName: string, arguments_: Record<string, unknown>): Promise<McpToolResult>;
/**
 * Quick access to read a resource
 */
export declare function readMcpResource(serverName: string, uri: string): Promise<McpToolResult>;
export {};
//# sourceMappingURL=mcp-bridge.d.ts.map