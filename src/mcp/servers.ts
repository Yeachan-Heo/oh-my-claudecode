/**
 * MCP Server Configurations
 *
 * Predefined MCP server configurations for common integrations:
 * - Linkup: AI-powered web search
 * - Ref: Official documentation lookup
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
 * Linkup MCP Server - AI-powered web search
 * Requires: LINKUP_API_KEY (passed as arg)
 */
export function createLinkupServer(apiKey?: string): McpServerConfig {
  return {
    command: 'npx',
    args: apiKey
      ? ['-y', 'linkup-mcp-server', `apiKey=${apiKey}`]
      : ['-y', 'linkup-mcp-server']
  };
}

/**
 * Ref MCP Server - Official documentation lookup
 * Provides access to official docs for popular libraries
 */
export function createRefServer(apiKey?: string): McpServerConfig {
  return {
    command: 'npx',
    args: ['-y', 'ref-tools-mcp@latest'],
    env: apiKey ? { REF_API_KEY: apiKey } : undefined
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
  linkup?: McpServerConfig;
  ref?: McpServerConfig;
  playwright?: McpServerConfig;
  memory?: McpServerConfig;
}

export function getDefaultMcpServers(options?: {
  linkupApiKey?: string;
  refApiKey?: string;
  enableLinkup?: boolean;
  enableRef?: boolean;
  enablePlaywright?: boolean;
  enableMemory?: boolean;
}): McpServersConfig {
  const servers: McpServersConfig = {};

  if (options?.enableLinkup !== false) {
    servers.linkup = createLinkupServer(options?.linkupApiKey);
  }

  if (options?.enableRef !== false) {
    servers.ref = createRefServer(options?.refApiKey);
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
