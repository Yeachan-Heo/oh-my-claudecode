/**
 * Tool Registry and Router
 *
 * Central registry for all external tools, plugins, and MCP servers.
 * Handles tool registration, conflict resolution, and command routing.
 */

import type {
  ExternalTool,
  DiscoveredPlugin,
  DiscoveredMcpServer,
  ToolRoute,
  ToolConflict,
  RegistryState,
  RegistryEvent,
  RegistryEventListener,
  DiscoveryOptions,
} from './types.js';
import { discoverAll, type DiscoveryResult } from './discovery.js';

/**
 * Singleton registry instance
 */
let registryInstance: ToolRegistry | null = null;

/**
 * Tool Registry - Central hub for all external tools
 */
export class ToolRegistry {
  private plugins: Map<string, DiscoveredPlugin> = new Map();
  private mcpServers: Map<string, DiscoveredMcpServer> = new Map();
  private tools: Map<string, ExternalTool> = new Map();
  private conflicts: Map<string, ToolConflict> = new Map();
  private listeners: Set<RegistryEventListener> = new Set();
  private lastDiscovery: number = 0;
  private discoveryCache: DiscoveryResult | null = null;

  /**
   * Get the singleton registry instance
   */
  static getInstance(): ToolRegistry {
    if (!registryInstance) {
      registryInstance = new ToolRegistry();
    }
    return registryInstance;
  }

  /**
   * Reset the registry (for testing)
   */
  static resetInstance(): void {
    registryInstance = null;
  }

  /**
   * Initialize the registry by discovering all external resources
   */
  async initialize(options?: DiscoveryOptions): Promise<void> {
    const result = discoverAll(options);
    this.discoveryCache = result;
    this.lastDiscovery = result.timestamp;

    // Register discovered plugins
    for (const plugin of result.plugins) {
      this.registerPlugin(plugin);
    }

    // Register discovered MCP servers
    for (const server of result.mcpServers) {
      this.registerMcpServer(server);
    }

    this.emit({
      type: 'plugin-discovered',
      timestamp: Date.now(),
      data: { pluginCount: result.plugins.length, mcpServerCount: result.mcpServers.length },
    });
  }

  /**
   * Register a discovered plugin
   */
  registerPlugin(plugin: DiscoveredPlugin): void {
    this.plugins.set(plugin.name, plugin);

    // Register all tools from this plugin
    for (const tool of plugin.tools) {
      this.registerTool(tool);
    }

    this.emit({
      type: 'plugin-loaded',
      timestamp: Date.now(),
      data: { plugin: plugin.name, toolCount: plugin.tools.length },
    });
  }

  /**
   * Register a discovered MCP server
   */
  registerMcpServer(server: DiscoveredMcpServer): void {
    this.mcpServers.set(server.name, server);

    // Register any pre-discovered tools
    for (const tool of server.tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Register a single tool
   */
  registerTool(tool: ExternalTool): void {
    const existingTool = this.tools.get(tool.name);

    if (existingTool) {
      // Conflict detected - resolve by priority
      this.handleConflict(existingTool, tool);
    } else {
      this.tools.set(tool.name, tool);
      this.emit({
        type: 'tool-registered',
        timestamp: Date.now(),
        data: { tool: tool.name, source: tool.source },
      });
    }
  }

  /**
   * Handle tool name conflict
   */
  private handleConflict(existing: ExternalTool, incoming: ExternalTool): void {
    const conflictKey = existing.name;

    // Get or create conflict record
    let conflict = this.conflicts.get(conflictKey);
    if (!conflict) {
      conflict = {
        name: conflictKey,
        tools: [existing],
        resolution: 'priority',
        winner: existing,
      };
      this.conflicts.set(conflictKey, conflict);
    }

    // Add incoming tool to conflict list
    conflict.tools.push(incoming);

    // Resolve by priority (higher wins)
    const existingPriority = existing.priority || 50;
    const incomingPriority = incoming.priority || 50;

    if (incomingPriority > existingPriority) {
      conflict.winner = incoming;
      this.tools.set(incoming.name, incoming);
    }

    this.emit({
      type: 'tool-conflict',
      timestamp: Date.now(),
      data: { name: conflictKey, winner: conflict.winner.source },
    });
  }

  /**
   * Get a tool by name (supports both namespaced and short names)
   */
  getTool(name: string): ExternalTool | undefined {
    // Try exact match first
    if (this.tools.has(name)) {
      return this.tools.get(name);
    }

    // Try to find by short name (without namespace)
    for (const [fullName, tool] of this.tools) {
      const shortName = fullName.split(':').pop();
      if (shortName === name) {
        return tool;
      }
    }

    return undefined;
  }

  /**
   * Get all tools from a specific source
   */
  getToolsBySource(source: string): ExternalTool[] {
    return Array.from(this.tools.values()).filter(t => t.source === source);
  }

  /**
   * Get all tools of a specific type
   */
  getToolsByType(type: ExternalTool['type']): ExternalTool[] {
    return Array.from(this.tools.values()).filter(t => t.type === type);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): ExternalTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all registered plugins
   */
  getAllPlugins(): DiscoveredPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all registered MCP servers
   */
  getAllMcpServers(): DiscoveredMcpServer[] {
    return Array.from(this.mcpServers.values());
  }

  /**
   * Get all conflicts
   */
  getConflicts(): ToolConflict[] {
    return Array.from(this.conflicts.values());
  }

  /**
   * Route a command to the appropriate tool handler
   */
  route(command: string): ToolRoute | null {
    const tool = this.getTool(command);
    if (!tool) {
      return null;
    }

    // Determine if permission is required based on capabilities
    const requiresPermission = tool.capabilities?.some(c =>
      c === 'write' || c === 'execute'
    ) ?? false;

    const route: ToolRoute = {
      tool,
      requiresPermission,
    };

    // Add handler info for plugin tools
    if (tool.type === 'plugin') {
      const plugin = this.plugins.get(tool.source);
      if (plugin?.manifest.tools) {
        const toolDef = plugin.manifest.tools.find(
          t => `${plugin.name}:${t.name}` === tool.name
        );
        if (toolDef) {
          route.handler = toolDef.handler;
        }
      }
    }

    // Add MCP server info for MCP tools
    if (tool.type === 'mcp') {
      // Extract server name from tool source
      route.mcpServer = tool.source;
    }

    return route;
  }

  /**
   * Enable or disable a tool
   */
  setToolEnabled(name: string, enabled: boolean): boolean {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Check if a tool is enabled
   */
  isToolEnabled(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.enabled ?? false;
  }

  /**
   * Get plugin by name
   */
  getPlugin(name: string): DiscoveredPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get MCP server by name
   */
  getMcpServer(name: string): DiscoveredMcpServer | undefined {
    return this.mcpServers.get(name);
  }

  /**
   * Update MCP server connection status and tools
   */
  updateMcpServer(
    name: string,
    updates: Partial<Pick<DiscoveredMcpServer, 'connected' | 'tools' | 'error'>>
  ): void {
    const server = this.mcpServers.get(name);
    if (!server) return;

    if (updates.connected !== undefined) {
      server.connected = updates.connected;
    }
    if (updates.error !== undefined) {
      server.error = updates.error;
    }
    if (updates.tools) {
      // Register new tools from MCP server
      for (const tool of updates.tools) {
        this.registerTool(tool);
      }
      server.tools = updates.tools;
    }

    this.emit({
      type: updates.connected ? 'mcp-connected' : 'mcp-disconnected',
      timestamp: Date.now(),
      data: { server: name, toolCount: server.tools.length },
    });
  }

  /**
   * Get current registry state snapshot
   */
  getState(): RegistryState {
    return {
      plugins: Array.from(this.plugins.values()),
      mcpServers: Array.from(this.mcpServers.values()),
      tools: new Map(this.tools),
      conflicts: Array.from(this.conflicts.values()),
      lastDiscovery: this.lastDiscovery,
    };
  }

  /**
   * Search tools by keyword
   */
  searchTools(query: string): ExternalTool[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.tools.values()).filter(tool => {
      const searchText = `${tool.name} ${tool.description || ''} ${tool.source}`.toLowerCase();
      return searchText.includes(lowerQuery);
    });
  }

  /**
   * Add event listener
   */
  addEventListener(listener: RegistryEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: RegistryEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Clear all registered resources
   */
  clear(): void {
    this.plugins.clear();
    this.mcpServers.clear();
    this.tools.clear();
    this.conflicts.clear();
    this.discoveryCache = null;
    this.lastDiscovery = 0;
  }

  /**
   * Re-run discovery and update registry
   */
  async refresh(options?: DiscoveryOptions): Promise<void> {
    this.clear();
    await this.initialize({ ...options, force: true });
  }

  /**
   * Get discovery cache if available
   */
  getDiscoveryCache(): DiscoveryResult | null {
    return this.discoveryCache;
  }
}

/**
 * Get the global registry instance
 */
export function getRegistry(): ToolRegistry {
  return ToolRegistry.getInstance();
}

/**
 * Initialize the global registry
 */
export async function initializeRegistry(options?: DiscoveryOptions): Promise<ToolRegistry> {
  const registry = ToolRegistry.getInstance();
  await registry.initialize(options);
  return registry;
}

/**
 * Quick access to route a command
 */
export function routeCommand(command: string): ToolRoute | null {
  return ToolRegistry.getInstance().route(command);
}

/**
 * Quick access to get a tool
 */
export function getExternalTool(name: string): ExternalTool | undefined {
  return ToolRegistry.getInstance().getTool(name);
}

/**
 * List all available external tools
 */
export function listExternalTools(): ExternalTool[] {
  return ToolRegistry.getInstance().getAllTools();
}

/**
 * Check if any external plugins are installed
 */
export function hasExternalPlugins(): boolean {
  return ToolRegistry.getInstance().getAllPlugins().length > 0;
}

/**
 * Check if any MCP servers are configured
 */
export function hasMcpServers(): boolean {
  return ToolRegistry.getInstance().getAllMcpServers().length > 0;
}
