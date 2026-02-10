/**
 * Tool Registry and Router
 *
 * Central registry for all external tools, plugins, and MCP servers.
 * Handles tool registration, conflict resolution, and command routing.
 */
import type { ExternalTool, DiscoveredPlugin, DiscoveredMcpServer, ToolRoute, ToolConflict, RegistryState, RegistryEventListener, DiscoveryOptions } from './types.js';
import { type DiscoveryResult } from './discovery.js';
/**
 * Tool Registry - Central hub for all external tools
 */
export declare class ToolRegistry {
    private plugins;
    private mcpServers;
    private tools;
    private conflicts;
    private listeners;
    private lastDiscovery;
    private discoveryCache;
    /**
     * Get the singleton registry instance
     */
    static getInstance(): ToolRegistry;
    /**
     * Reset the registry (for testing)
     */
    static resetInstance(): void;
    /**
     * Initialize the registry by discovering all external resources
     */
    initialize(options?: DiscoveryOptions): Promise<void>;
    /**
     * Register a discovered plugin
     */
    registerPlugin(plugin: DiscoveredPlugin): void;
    /**
     * Register a discovered MCP server
     */
    registerMcpServer(server: DiscoveredMcpServer): void;
    /**
     * Register a single tool
     */
    registerTool(tool: ExternalTool): void;
    /**
     * Handle tool name conflict
     */
    private handleConflict;
    /**
     * Get a tool by name (supports both namespaced and short names)
     */
    getTool(name: string): ExternalTool | undefined;
    /**
     * Get all tools from a specific source
     */
    getToolsBySource(source: string): ExternalTool[];
    /**
     * Get all tools of a specific type
     */
    getToolsByType(type: ExternalTool['type']): ExternalTool[];
    /**
     * Get all registered tools
     */
    getAllTools(): ExternalTool[];
    /**
     * Get all registered plugins
     */
    getAllPlugins(): DiscoveredPlugin[];
    /**
     * Get all registered MCP servers
     */
    getAllMcpServers(): DiscoveredMcpServer[];
    /**
     * Get all conflicts
     */
    getConflicts(): ToolConflict[];
    /**
     * Route a command to the appropriate tool handler
     */
    route(command: string): ToolRoute | null;
    /**
     * Enable or disable a tool
     */
    setToolEnabled(name: string, enabled: boolean): boolean;
    /**
     * Check if a tool is enabled
     */
    isToolEnabled(name: string): boolean;
    /**
     * Get plugin by name
     */
    getPlugin(name: string): DiscoveredPlugin | undefined;
    /**
     * Get MCP server by name
     */
    getMcpServer(name: string): DiscoveredMcpServer | undefined;
    /**
     * Update MCP server connection status and tools
     */
    updateMcpServer(name: string, updates: Partial<Pick<DiscoveredMcpServer, 'connected' | 'tools' | 'error'>>): void;
    /**
     * Get current registry state snapshot
     */
    getState(): RegistryState;
    /**
     * Search tools by keyword
     */
    searchTools(query: string): ExternalTool[];
    /**
     * Add event listener
     */
    addEventListener(listener: RegistryEventListener): void;
    /**
     * Remove event listener
     */
    removeEventListener(listener: RegistryEventListener): void;
    /**
     * Emit event to all listeners
     */
    private emit;
    /**
     * Clear all registered resources
     */
    clear(): void;
    /**
     * Re-run discovery and update registry
     */
    refresh(options?: DiscoveryOptions): Promise<void>;
    /**
     * Get discovery cache if available
     */
    getDiscoveryCache(): DiscoveryResult | null;
}
/**
 * Get the global registry instance
 */
export declare function getRegistry(): ToolRegistry;
/**
 * Initialize the global registry
 */
export declare function initializeRegistry(options?: DiscoveryOptions): Promise<ToolRegistry>;
/**
 * Quick access to route a command
 */
export declare function routeCommand(command: string): ToolRoute | null;
/**
 * Quick access to get a tool
 */
export declare function getExternalTool(name: string): ExternalTool | undefined;
/**
 * List all available external tools
 */
export declare function listExternalTools(): ExternalTool[];
/**
 * Check if any external plugins are installed
 */
export declare function hasExternalPlugins(): boolean;
/**
 * Check if any MCP servers are configured
 */
export declare function hasMcpServers(): boolean;
//# sourceMappingURL=registry.d.ts.map