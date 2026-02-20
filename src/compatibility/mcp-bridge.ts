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

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { basename } from 'path';
import type {
  DiscoveredMcpServer,
  McpServerEntry,
  ExternalTool,
  McpToolResult,
  ToolCapability,
} from './types.js';
import { getRegistry } from './registry.js';

/**
 * Security Error for MCP bridge operations
 */
export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSecurityError';
  }
}

/**
 * Allowed commands whitelist for MCP server spawning
 * Only these executables can be spawned as MCP servers
 */
const ALLOWED_COMMANDS = new Set([
  'node',
  'npx',
  'python',
  'python3',
  'ruby',
  'go',
  'deno',
  'bun',
  'uvx',
  'uv',
  'cargo',
  'java',
  'dotnet',
]);

/**
 * Dangerous environment variables that could be used for code injection
 */
const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'ELECTRON_RUN_AS_NODE',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
]);

/**
 * MCP message types
 */
interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
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
 * Active MCP connection state
 */
interface McpConnection {
  process: ChildProcess;
  serverName: string;
  requestId: number;
  pendingRequests: Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  buffer: string;
}

/**
 * MCP Bridge - Manages connections to MCP servers
 */
export class McpBridge extends EventEmitter {
  private connections: Map<string, McpConnection> = new Map();
  private serverConfigs: Map<string, McpServerEntry> = new Map();

  /**
   * Register a server configuration
   */
  registerServer(name: string, config: McpServerEntry): void {
    this.serverConfigs.set(name, config);
  }

  /**
   * Connect to an MCP server
   */
  async connect(serverName: string): Promise<ExternalTool[]> {
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    // Check if already connected
    if (this.connections.has(serverName)) {
      const conn = this.connections.get(serverName)!;
      return this.convertToExternalTools(serverName, conn.tools);
    }

    // SECURITY: Validate command is in whitelist
    const commandBasename = basename(config.command);
    if (!ALLOWED_COMMANDS.has(commandBasename)) {
      throw new McpSecurityError(
        `Command not in whitelist: ${config.command}. ` +
        `Allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}`
      );
    }

    // SECURITY: Filter out dangerous environment variables
    const safeEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (BLOCKED_ENV_VARS.has(key.toUpperCase())) {
          this.emit('security-warning', {
            server: serverName,
            message: `Blocked dangerous environment variable: ${key}`,
          });
          continue;
        }
        safeEnv[key] = value;
      }
    }

    // Spawn the server process
    const child = spawn(config.command, config.args || [], {
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const connection: McpConnection = {
      process: child,
      serverName,
      requestId: 0,
      pendingRequests: new Map(),
      tools: [],
      resources: [],
      buffer: '',
    };

    this.connections.set(serverName, connection);

    // SECURITY: Set up error handler for spawn failures
    child.on('error', (error: Error) => {
      this.connections.delete(serverName);
      this.emit('spawn-error', { server: serverName, error: error.message });
      // Update registry with error state
      const registry = getRegistry();
      registry.updateMcpServer(serverName, {
        connected: false,
        error: `Spawn failed: ${error.message}`,
      });
    });

    // Set up message handling
    child.stdout?.on('data', (data: Buffer) => {
      this.handleData(serverName, data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.emit('server-error', { server: serverName, error: data.toString() });
    });

    child.on('exit', (code) => {
      this.connections.delete(serverName);
      this.emit('server-disconnected', { server: serverName, code });

      // Update registry
      const registry = getRegistry();
      registry.updateMcpServer(serverName, { connected: false });
    });

    // Wait for server to be ready
    await this.waitForReady(serverName);

    // Initialize the connection
    await this.initialize(serverName);

    // Discover tools
    const tools = await this.listTools(serverName);
    connection.tools = tools;

    // Discover resources
    try {
      const resources = await this.listResources(serverName);
      connection.resources = resources;
    } catch {
      // Resources are optional
    }

    // Convert to external tools and update registry
    const externalTools = this.convertToExternalTools(serverName, tools);
    const registry = getRegistry();
    registry.updateMcpServer(serverName, {
      connected: true,
      tools: externalTools,
    });

    this.emit('server-connected', { server: serverName, toolCount: tools.length });

    return externalTools;
  }

  /**
   * Disconnect from an MCP server
   */
  disconnect(serverName: string): void {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    try {
      connection.process.kill();
    } catch {
      // Ignore kill errors
    }

    this.connections.delete(serverName);

    // Update registry
    const registry = getRegistry();
    registry.updateMcpServer(serverName, { connected: false, tools: [] });
  }

  /**
   * Disconnect from all servers
   */
  disconnectAll(): void {
    for (const serverName of this.connections.keys()) {
      this.disconnect(serverName);
    }
  }

  /**
   * Check if connected to a server
   */
  isConnected(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  /**
   * Invoke a tool on an MCP server
   */
  async invokeTool(
    serverName: string,
    toolName: string,
    arguments_: Record<string, unknown>
  ): Promise<McpToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return {
        success: false,
        error: `Not connected to MCP server: ${serverName}`,
      };
    }

    const startTime = Date.now();

    try {
      const result = await this.sendRequest(serverName, 'tools/call', {
        name: toolName,
        arguments: arguments_,
      });

      return {
        success: true,
        data: result,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(
    serverName: string,
    uri: string
  ): Promise<McpToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return {
        success: false,
        error: `Not connected to MCP server: ${serverName}`,
      };
    }

    try {
      const result = await this.sendRequest(serverName, 'resources/read', { uri });
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get available tools from a connected server
   */
  getServerTools(serverName: string): McpToolDefinition[] {
    return this.connections.get(serverName)?.tools || [];
  }

  /**
   * Get available resources from a connected server
   */
  getServerResources(serverName: string): McpResourceDefinition[] {
    return this.connections.get(serverName)?.resources || [];
  }

  /**
   * Wait for server to be ready
   */
  private async waitForReady(serverName: string, timeout = 10000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const connection = this.connections.get(serverName);
      if (!connection) {
        throw new Error('Server connection lost');
      }

      // Try to ping the server
      try {
        await this.sendRequest(serverName, 'ping', undefined, 1000);
        return;
      } catch {
        // Server not ready yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error(`Timeout waiting for MCP server ${serverName} to be ready`);
  }

  /**
   * Initialize the MCP connection
   */
  private async initialize(serverName: string): Promise<void> {
    await this.sendRequest(serverName, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
      },
      clientInfo: {
        name: 'oh-my-claudecode',
        version: '3.7.2',
      },
    });

    // Send initialized notification
    this.sendNotification(serverName, 'initialized', {});
  }

  /**
   * List available tools from server
   */
  private async listTools(serverName: string): Promise<McpToolDefinition[]> {
    const result = await this.sendRequest(serverName, 'tools/list', {}) as {
      tools: McpToolDefinition[];
    };
    return result.tools || [];
  }

  /**
   * List available resources from server
   */
  private async listResources(serverName: string): Promise<McpResourceDefinition[]> {
    const result = await this.sendRequest(serverName, 'resources/list', {}) as {
      resources: McpResourceDefinition[];
    };
    return result.resources || [];
  }

  /**
   * Send an MCP request and wait for response
   */
  private sendRequest(
    serverName: string,
    method: string,
    params?: unknown,
    timeout = 30000
  ): Promise<unknown> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return Promise.reject(new Error(`Not connected to server: ${serverName}`));
    }

    const id = ++connection.requestId;
    const request: McpRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      connection.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      // Send the request
      const message = JSON.stringify(request) + '\n';
      this.safeStdinWrite(connection.process.stdin, message);
    });
  }

  /**
   * Write a message to a child process stdin, swallowing EPIPE errors.
   * EPIPE occurs when the process exits before the write completes (e.g., during test teardown).
   */
  private safeStdinWrite(stdin: NodeJS.WritableStream | null | undefined, message: string): void {
    if (!stdin) return;
    try {
      stdin.write(message);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        throw err;
      }
    }
  }

  /**
   * Send an MCP notification (no response expected)
   */
  private sendNotification(serverName: string, method: string, params?: unknown): void {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification) + '\n';
    this.safeStdinWrite(connection.process.stdin, message);
  }

  /**
   * Handle incoming data from server
   */
  private handleData(serverName: string, data: Buffer): void {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    connection.buffer += data.toString();

    // Process complete messages (newline-delimited JSON)
    const lines = connection.buffer.split('\n');
    connection.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as McpResponse;
        this.handleMessage(serverName, message);
      } catch {
        this.emit('parse-error', { server: serverName, data: line });
      }
    }
  }

  /**
   * Handle a parsed MCP message
   */
  private handleMessage(serverName: string, message: McpResponse): void {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    // Check if this is a response to a pending request
    if (message.id !== undefined) {
      const pending = connection.pendingRequests.get(message.id);
      if (pending) {
        connection.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  /**
   * Convert MCP tools to ExternalTool format
   */
  private convertToExternalTools(
    serverName: string,
    tools: McpToolDefinition[]
  ): ExternalTool[] {
    return tools.map(tool => ({
      name: `mcp__${serverName}__${tool.name}`,
      type: 'mcp' as const,
      source: serverName,
      description: tool.description,
      capabilities: this.inferCapabilities(tool.name, tool.description),
      enabled: true,
      schema: tool.inputSchema,
      priority: 40, // MCP tools have lower priority than built-in
    }));
  }

  /**
   * Infer capabilities from tool name and description
   */
  private inferCapabilities(name: string, description?: string): ToolCapability[] {
    const capabilities: ToolCapability[] = [];
    const text = `${name} ${description || ''}`.toLowerCase();

    if (text.includes('read') || text.includes('get') || text.includes('list') || text.includes('fetch')) {
      capabilities.push('read');
    }
    if (text.includes('write') || text.includes('create') || text.includes('edit') || text.includes('update')) {
      capabilities.push('write');
    }
    if (text.includes('exec') || text.includes('run') || text.includes('execute')) {
      capabilities.push('execute');
    }
    if (text.includes('search') || text.includes('find') || text.includes('query')) {
      capabilities.push('search');
    }

    return capabilities.length > 0 ? capabilities : ['unknown'];
  }

  /**
   * Auto-connect to enabled servers from registry
   */
  async autoConnect(): Promise<Map<string, ExternalTool[]>> {
    const registry = getRegistry();
    const results = new Map<string, ExternalTool[]>();

    for (const server of registry.getAllMcpServers()) {
      if (server.config.enabled === false) continue;

      this.registerServer(server.name, server.config);

      try {
        const tools = await this.connect(server.name);
        results.set(server.name, tools);
      } catch (error) {
        registry.updateMcpServer(server.name, {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        });
        this.emit('connect-error', { server: server.name, error });
      }
    }

    return results;
  }

  /**
   * Get connection status for all servers
   */
  getConnectionStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const [name, config] of this.serverConfigs) {
      status.set(name, this.connections.has(name));
    }
    return status;
  }
}

/**
 * Singleton bridge instance
 */
let bridgeInstance: McpBridge | null = null;

/**
 * Get the MCP bridge singleton
 */
export function getMcpBridge(): McpBridge {
  if (!bridgeInstance) {
    bridgeInstance = new McpBridge();
  }
  return bridgeInstance;
}

/**
 * Reset bridge instance (for testing)
 */
export function resetMcpBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.disconnectAll();
    bridgeInstance = null;
  }
}

/**
 * Quick access to invoke a tool
 */
export async function invokeMcpTool(
  serverName: string,
  toolName: string,
  arguments_: Record<string, unknown>
): Promise<McpToolResult> {
  return getMcpBridge().invokeTool(serverName, toolName, arguments_);
}

/**
 * Quick access to read a resource
 */
export async function readMcpResource(
  serverName: string,
  uri: string
): Promise<McpToolResult> {
  return getMcpBridge().readResource(serverName, uri);
}
