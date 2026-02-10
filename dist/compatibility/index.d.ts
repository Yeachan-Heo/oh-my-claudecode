/**
 * Compatibility Layer Module
 *
 * MCP/Plugin compatibility layer for oh-my-claudecode.
 * Enables OMC to discover, register, and use external plugins, tools, and MCP servers.
 *
 * Usage:
 *   import { initializeCompatibility, getRegistry, getMcpBridge } from './compatibility';
 *
 *   // Initialize everything
 *   await initializeCompatibility();
 *
 *   // Access tools
 *   const tools = getRegistry().getAllTools();
 *   const tool = getRegistry().getTool('context7:query-docs');
 *
 *   // Route commands
 *   const route = getRegistry().route('search');
 *
 *   // Use MCP bridge
 *   const bridge = getMcpBridge();
 *   const result = await bridge.invokeTool('filesystem', 'read_file', { path: '/etc/hosts' });
 */
export type { ExternalTool, ExternalToolType, ToolCapability, PluginManifest, McpServerEntry, PluginPermission, PluginToolDefinition, DiscoveredPlugin, DiscoveredMcpServer, ToolRoute, ToolConflict, RegistryState, DiscoveryOptions, PermissionCheckResult, McpToolResult, RegistryEvent, RegistryEventListener, SafeCommandPattern, } from './types.js';
export { discoverAll, discoverPlugins, discoverMcpServers, discoverPluginMcpServers, getPluginPaths, getMcpConfigPath, isPluginInstalled, getPluginInfo, type DiscoveryResult, } from './discovery.js';
export { ToolRegistry, getRegistry, initializeRegistry, routeCommand, getExternalTool, listExternalTools, hasExternalPlugins, hasMcpServers, } from './registry.js';
export { checkPermission, grantPermission, denyPermission, clearPermissionCache, registerPluginSafePatterns, getSafePatterns, addSafePattern, removeSafePatternsFromSource, shouldDelegate, getDelegationTarget, integrateWithPermissionSystem, processExternalToolPermission, } from './permission-adapter.js';
export { McpBridge, getMcpBridge, resetMcpBridge, invokeMcpTool, readMcpResource, } from './mcp-bridge.js';
import type { DiscoveryOptions } from './types.js';
/**
 * Initialize the complete compatibility layer
 *
 * Performs in order:
 * 1. Plugin and MCP server discovery
 * 2. Tool registration in central registry
 * 3. Permission system integration
 * 4. MCP server auto-connection (if enabled)
 *
 * @param options Discovery options
 * @returns Summary of discovered resources
 */
export declare function initializeCompatibility(options?: DiscoveryOptions & {
    /** Whether to auto-connect to discovered MCP servers */
    autoConnect?: boolean;
}): Promise<{
    pluginCount: number;
    mcpServerCount: number;
    toolCount: number;
    connectedServers: string[];
}>;
//# sourceMappingURL=index.d.ts.map