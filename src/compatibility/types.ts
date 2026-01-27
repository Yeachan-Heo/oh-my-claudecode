/**
 * Compatibility Layer Types
 *
 * Type definitions for MCP/Plugin compatibility layer.
 * Enables OMC to discover, register, and use external plugins, tools, and MCP servers.
 */

/**
 * Type of external tool source
 */
export type ExternalToolType = 'plugin' | 'mcp' | 'skill' | 'agent';

/**
 * Tool capability categories
 */
export type ToolCapability =
  | 'read'       // Can read files/resources
  | 'write'      // Can write/modify files
  | 'execute'    // Can execute commands
  | 'network'    // Can make network requests
  | 'search'     // Can search/query
  | 'analyze'    // Can analyze data
  | 'generate'   // Can generate content
  | 'unknown';   // Capability not determined

/**
 * External tool definition
 */
export interface ExternalTool {
  /** Unique tool name (with namespace prefix) */
  name: string;
  /** Tool type (plugin, mcp, skill, agent) */
  type: ExternalToolType;
  /** Source plugin/server name */
  source: string;
  /** Human-readable description */
  description?: string;
  /** Available commands/methods */
  commands?: string[];
  /** Tool capabilities */
  capabilities?: ToolCapability[];
  /** Whether this tool is enabled */
  enabled: boolean;
  /** Original tool schema (for MCP tools) */
  schema?: Record<string, unknown>;
  /** Priority for conflict resolution (higher wins) */
  priority?: number;
}

/**
 * Plugin manifest format (compatible with .claude-plugin/plugin.json)
 */
export interface PluginManifest {
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** Plugin description */
  description?: string;
  /** Skills directory or array of skill paths */
  skills?: string | string[];
  /** Agents directory or array of agent paths */
  agents?: string | string[];
  /** Commands directory or array of command paths */
  commands?: string | string[];
  /** Hook configurations */
  hooks?: Record<string, string[]>;
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerEntry>;
  /** Required permissions */
  permissions?: PluginPermission[];
  /** Tool definitions */
  tools?: PluginToolDefinition[];
  /** Namespace prefix for this plugin */
  namespace?: string;
}

/**
 * MCP server entry in manifest
 */
export interface McpServerEntry {
  /** Command to run the server */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether this server is enabled by default */
  enabled?: boolean;
  /** Description of the server */
  description?: string;
}

/**
 * Permission required by a plugin
 */
export interface PluginPermission {
  /** Tool name that requires permission */
  tool: string;
  /** Permission scope */
  scope: 'read' | 'write' | 'execute' | 'all';
  /** Patterns for allowed paths/commands */
  patterns?: string[];
  /** Reason for requiring this permission */
  reason?: string;
}

/**
 * Tool definition within a plugin
 */
export interface PluginToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
  /** Handler function name or command */
  handler: string;
}

/**
 * Discovered plugin information
 */
export interface DiscoveredPlugin {
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** Path to plugin directory */
  path: string;
  /** Parsed manifest */
  manifest: PluginManifest;
  /** Whether the plugin is loaded */
  loaded: boolean;
  /** Error message if loading failed */
  error?: string;
  /** Discovered tools from this plugin */
  tools: ExternalTool[];
}

/**
 * Discovered MCP server
 */
export interface DiscoveredMcpServer {
  /** Server name */
  name: string;
  /** Server configuration */
  config: McpServerEntry;
  /** Source (e.g., "claude_desktop_config" or plugin name) */
  source: string;
  /** Whether the server is currently connected */
  connected: boolean;
  /** Available tools from this server */
  tools: ExternalTool[];
  /** Connection error if any */
  error?: string;
}

/**
 * Tool routing decision
 */
export interface ToolRoute {
  /** The tool to invoke */
  tool: ExternalTool;
  /** Handler to execute (for plugins) */
  handler?: string;
  /** MCP server name (for MCP tools) */
  mcpServer?: string;
  /** Whether permission is required */
  requiresPermission: boolean;
  /** Cached permission decision */
  permissionGranted?: boolean;
}

/**
 * Conflict between tools with same name
 */
export interface ToolConflict {
  /** Tool name that has conflict */
  name: string;
  /** All tools with this name */
  tools: ExternalTool[];
  /** Resolution method used */
  resolution: 'priority' | 'namespace' | 'manual';
  /** The winning tool */
  winner: ExternalTool;
}

/**
 * Registry state snapshot
 */
export interface RegistryState {
  /** All discovered plugins */
  plugins: DiscoveredPlugin[];
  /** All discovered MCP servers */
  mcpServers: DiscoveredMcpServer[];
  /** All registered tools (by namespaced name) */
  tools: Map<string, ExternalTool>;
  /** Detected conflicts */
  conflicts: ToolConflict[];
  /** Last discovery timestamp */
  lastDiscovery: number;
}

/**
 * Discovery options
 */
export interface DiscoveryOptions {
  /** Paths to scan for plugins */
  pluginPaths?: string[];
  /** Path to claude_desktop_config.json */
  mcpConfigPath?: string;
  /** Path to settings.json with mcpServers */
  settingsPath?: string;
  /** Whether to auto-connect MCP servers */
  autoConnectMcp?: boolean;
  /** Whether to force re-discovery */
  force?: boolean;
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Reason for the decision */
  reason: string;
  /** Whether to ask user (if behavior is 'ask') */
  askUser?: boolean;
}

/**
 * MCP tool invocation result
 */
export interface McpToolResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Result data */
  data?: unknown;
  /** Error message if failed */
  error?: string;
  /** Execution time in ms */
  executionTime?: number;
}

/**
 * Event emitted by the registry
 */
export interface RegistryEvent {
  type: 'plugin-discovered' | 'plugin-loaded' | 'plugin-error' |
        'mcp-connected' | 'mcp-disconnected' | 'mcp-error' |
        'tool-registered' | 'tool-conflict' | 'tool-invoked';
  timestamp: number;
  data: unknown;
}

/**
 * Registry event listener
 */
export type RegistryEventListener = (event: RegistryEvent) => void;

/**
 * Safe command patterns for permission auto-approval
 */
export interface SafeCommandPattern {
  /** Tool name */
  tool: string;
  /** Regex pattern for safe commands/paths */
  pattern: RegExp;
  /** Description of what this pattern allows */
  description: string;
  /** Source of this pattern (builtin, plugin name) */
  source: string;
}
