/**
 * Plugin and MCP Server Discovery
 *
 * Discovers external plugins, MCP servers, and tools from:
 * - ~/.claude/plugins/ (Claude Code plugins)
 * - ~/.claude/settings.json (MCP servers config)
 * - ~/.claude/claude_desktop_config.json (Desktop app MCP config)
 * - Project-local .claude-plugin/ directories
 */
import type { DiscoveryOptions, DiscoveredPlugin, DiscoveredMcpServer, ExternalTool } from './types.js';
/**
 * Security Error for discovery operations
 */
export declare class DiscoverySecurityError extends Error {
    constructor(message: string);
}
/**
 * Discover all plugins from configured paths
 */
export declare function discoverPlugins(options?: DiscoveryOptions): DiscoveredPlugin[];
/**
 * Discover all MCP servers from configuration files
 */
export declare function discoverMcpServers(options?: DiscoveryOptions): DiscoveredMcpServer[];
/**
 * Discover MCP servers from plugin manifests
 */
export declare function discoverPluginMcpServers(plugins: DiscoveredPlugin[]): DiscoveredMcpServer[];
/**
 * Full discovery of all external resources
 */
export interface DiscoveryResult {
    plugins: DiscoveredPlugin[];
    mcpServers: DiscoveredMcpServer[];
    allTools: ExternalTool[];
    timestamp: number;
}
/**
 * Perform full discovery of plugins and MCP servers
 */
export declare function discoverAll(options?: DiscoveryOptions): DiscoveryResult;
/**
 * Get paths being scanned for plugins
 */
export declare function getPluginPaths(): string[];
/**
 * Get path to MCP config file if it exists
 */
export declare function getMcpConfigPath(): string | null;
/**
 * Check if a specific plugin is installed
 */
export declare function isPluginInstalled(pluginName: string): boolean;
/**
 * Get plugin info by name
 */
export declare function getPluginInfo(pluginName: string): DiscoveredPlugin | null;
//# sourceMappingURL=discovery.d.ts.map