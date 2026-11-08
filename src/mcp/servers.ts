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
export function createExaServer(apiKey?: string): McpServerConfig {
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
export function createContext7Server(): McpServerConfig {
  return {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp']
  };
}

/**
 * Playwright MCP Server - Browser automation
 * Enables agents to interact with web pages
 */
export function createPlaywrightServer(): McpServerConfig {
  return {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest']
  };
}

/**
 * Filesystem MCP Server - Extended file operations
 * Provides additional file system capabilities
 */
export function createFilesystemServer(allowedPaths: string[]): McpServerConfig {
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', ...allowedPaths]
  };
}

/**
 * Memory MCP Server - Persistent memory
 * Allows agents to store and retrieve information across sessions
 */
export function createMemoryServer(): McpServerConfig {
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory']
  };
}

/**
 * Get all default MCP servers for the OMC system
 */
export interface McpServersConfig {
  exa?: McpServerConfig;
  context7?: McpServerConfig;
  playwright?: McpServerConfig;
  memory?: McpServerConfig;
}

export function getDefaultMcpServers(options?: {
  exaApiKey?: string;
  enableExa?: boolean;
  enableContext7?: boolean;
  enablePlaywright?: boolean;
  enableMemory?: boolean;
}): McpServersConfig {
  const servers: McpServersConfig = {};

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
export function toSdkMcpFormat(servers: McpServersConfig): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};

  for (const [name, config] of Object.entries(servers)) {
    if (config) {
      result[name] = config;
    }
  }

  return result;
}
