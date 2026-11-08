/**
 * MCP Server Configurations
 *
 * Predefined MCP server configurations for common integrations:
 * - Exa: AI-powered web search
 * - Context7: Official documentation lookup
 * - Playwright: Browser automation
 * - Filesystem: Sandboxed file system access
 * - Memory: Persistent knowledge graph
 */
export interface McpServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
/**
 * Exa MCP Server - AI-powered web search
 * Requires: EXA_API_KEY environment variable
 */
export declare function createExaServer(apiKey?: string): McpServerConfig;
/**
 * Context7 MCP Server - Official documentation lookup
 * Provides access to official docs for popular libraries
 */
export declare function createContext7Server(): McpServerConfig;
/**
 * Playwright MCP Server - Browser automation
 * Enables agents to interact with web pages
 */
export declare function createPlaywrightServer(): McpServerConfig;
/**
 * Filesystem MCP Server - Extended file operations
 * Provides additional file system capabilities
 */
export declare function createFilesystemServer(allowedPaths: string[]): McpServerConfig;
/**
 * Memory MCP Server - Persistent memory
 * Allows agents to store and retrieve information across sessions
 */
export declare function createMemoryServer(): McpServerConfig;
/**
 * Get all default MCP servers for the OMC system
 */
export interface McpServersConfig {
    exa?: McpServerConfig;
    context7?: McpServerConfig;
    playwright?: McpServerConfig;
    memory?: McpServerConfig;
}
export declare function getDefaultMcpServers(options?: {
    exaApiKey?: string;
    enableExa?: boolean;
    enableContext7?: boolean;
    enablePlaywright?: boolean;
    enableMemory?: boolean;
}): McpServersConfig;
/**
 * Convert MCP servers config to SDK format
 */
export declare function toSdkMcpFormat(servers: McpServersConfig): Record<string, McpServerConfig>;
//# sourceMappingURL=servers.d.ts.map