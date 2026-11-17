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
/**
 * Exa MCP Server - AI-powered web search
 * Requires: EXA_API_KEY environment variable
 */
export function createExaServer(apiKey) {
    return {
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        env: apiKey ? { EXA_API_KEY: apiKey } : undefined
    };
}
/**
 * Context7 MCP Server - Official documentation lookup
 * Provides access to official docs for popular libraries
 */
export function createContext7Server() {
    return {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp']
    };
}
/**
 * Playwright MCP Server - Browser automation
 * Enables agents to interact with web pages
 */
export function createPlaywrightServer() {
    return {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest']
    };
}
/**
 * Filesystem MCP Server - Extended file operations
 * Provides additional file system capabilities
 */
export function createFilesystemServer(allowedPaths) {
    return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', ...allowedPaths]
    };
}
/**
 * Memory MCP Server - Persistent memory
 * Allows agents to store and retrieve information across sessions
 */
export function createMemoryServer() {
    return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory']
    };
}
export function getDefaultMcpServers(options) {
    const servers = {};
    if (options?.enableExa !== false) {
        servers.exa = createExaServer(options?.exaApiKey);
    }
    if (options?.enableContext7 !== false) {
        servers.context7 = createContext7Server();
    }
    if (options?.enablePlaywright) {
        servers.playwright = createPlaywrightServer();
    }
    if (options?.enableMemory) {
        servers.memory = createMemoryServer();
    }
    return servers;
}
/**
 * Convert MCP servers config to SDK format
 */
export function toSdkMcpFormat(servers) {
    const result = {};
    for (const [name, config] of Object.entries(servers)) {
        if (config) {
            result[name] = config;
        }
    }
    return result;
}
//# sourceMappingURL=servers.js.map