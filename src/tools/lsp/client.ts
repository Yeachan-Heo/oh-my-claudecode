/**
 * LSP Client Implementation
 *
 * Manages connections to language servers using JSON-RPC 2.0 over stdio.
 * Handles server lifecycle, message buffering, and request/response matching.
 */

import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, parse, join } from 'path';
import { pathToFileURL } from 'url';
import {
  resolveDevContainerContext,
  hostUriToContainerUri,
  containerUriToHostUri
} from './devcontainer.js';
import type { DevContainerContext } from './devcontainer.js';
import type { LspServerConfig } from './servers.js';
import { getServerForFile, commandExists } from './servers.js';

/** Default timeout (ms) for LSP requests. Override with OMC_LSP_TIMEOUT_MS env var. */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS: number = (() => {
  return readPositiveIntEnv('OMC_LSP_TIMEOUT_MS', 15_000);
})();

export function getLspRequestTimeout(
  serverConfig: Pick<LspServerConfig, 'initializeTimeoutMs'>,
  method: string,
  baseTimeout = DEFAULT_LSP_REQUEST_TIMEOUT_MS
): number {
  if (method === 'initialize' && serverConfig.initializeTimeoutMs) {
    return Math.max(baseTimeout, serverConfig.initializeTimeoutMs);
  }

  return baseTimeout;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const env = process.env[name];
  if (!env) {
    return fallback;
  }

  const parsed = parseInt(env, 10);
  return !isNaN(parsed) && parsed > 0 ? parsed : fallback;
}

/** Convert a file path to a valid file:// URI (cross-platform) */
function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

// LSP Protocol Types
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export interface Hover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, Array<{ range: Range; newText: string }>>;
  documentChanges?: Array<{ textDocument: TextDocumentIdentifier; edits: Array<{ range: Range; newText: string }> }>;
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

/**
 * JSON-RPC Request/Response types
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * LSP Client class
 */
export class LspClient {
  private static readonly MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private buffer = Buffer.alloc(0);
  private openDocuments = new Set<string>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private workspaceRoot: string;
  private serverConfig: LspServerConfig;
  private devContainerContext: DevContainerContext | null;
  private initialized = false;

  constructor(workspaceRoot: string, serverConfig: LspServerConfig, devContainerContext: DevContainerContext | null = null) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.serverConfig = serverConfig;
    this.devContainerContext = devContainerContext;
  }

  /**
   * Start the LSP server and initialize the connection
   */
  async connect(): Promise<void> {
    if (this.process) {
      return; // Already connected
    }

    const spawnCommand = this.devContainerContext ? 'docker' : this.serverConfig.command;

    if (!commandExists(spawnCommand)) {
      throw new Error(
        this.devContainerContext
          ? `Docker CLI not found. Required to start '${this.serverConfig.command}' inside container ${this.devContainerContext.containerId}.`
          : `Language server '${this.serverConfig.command}' not found.\nInstall with: ${this.serverConfig.installHint}`
      );
    }

    return new Promise((resolve, reject) => {
      // On Windows, npm-installed binaries are .cmd scripts that require
      // shell execution. Without this, spawn() fails with ENOENT. (#569)
      // Safe: server commands come from a hardcoded registry (servers.ts),
      // not user input, so shell metacharacter injection is not a concern.
      const command = this.devContainerContext ? 'docker' : this.serverConfig.command;
      const args = this.devContainerContext
        ? ['exec', '-i', '-w', this.devContainerContext.containerWorkspaceRoot, this.devContainerContext.containerId, this.serverConfig.command, ...this.serverConfig.args]
        : this.serverConfig.args;

      this.process = spawn(command, args, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: !this.devContainerContext && process.platform === 'win32'
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // Log stderr for debugging but don't fail
        console.error(`LSP stderr: ${data.toString()}`);
      });

      this.process.on('error', (error) => {
        reject(new Error(`Failed to start LSP server: ${error.message}`));
      });

      this.process.on('exit', (code) => {
        this.process = null;
        this.initialized = false;
        if (code !== 0) {
          console.error(`LSP server exited with code ${code}`);
        }
        // Reject all pending requests to avoid unresolved promises
        this.rejectPendingRequests(new Error(`LSP server exited (code ${code})`));
      });

      // Send initialize request
      this.initialize()
        .then(() => {
          this.initialized = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Synchronously kill the LSP server process.
   * Used in process exit handlers where async operations are not possible.
   */
  forceKill(): void {
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Ignore errors during kill
      }
      this.process = null;
      this.initialized = false;
      // Wake diagnostic waiters to prevent resource leaks
      for (const waiters of this.diagnosticWaiters.values()) {
        for (const wake of waiters) wake();
      }
      this.diagnosticWaiters.clear();
    }
  }

  /**
   * Disconnect from the LSP server
   */
  async disconnect(): Promise<void> {
    if (!this.process) return;

    try {
      // Short timeout for graceful shutdown — don't block forever
      await this.request('shutdown', null, 3000);
      this.notify('exit', null);
    } catch {
      // Ignore errors during shutdown
    } finally {
      // Always kill the process regardless of shutdown success
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      this.initialized = false;
      this.rejectPendingRequests(new Error('Client disconnected'));
      this.openDocuments.clear();
      this.diagnostics.clear();
      // Wake all diagnostic waiters so their setTimeout closures can be GC'd
      for (const waiters of this.diagnosticWaiters.values()) {
        for (const wake of waiters) wake();
      }
      this.diagnosticWaiters.clear();
    }
  }

  /**
   * Reject all pending requests with the given error.
   * Called on process exit to avoid dangling unresolved promises.
   */
  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Handle incoming data from the server
   */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Prevent unbounded buffer growth from misbehaving LSP server
    if (this.buffer.length > LspClient.MAX_BUFFER_SIZE) {
      console.error('[LSP] Response buffer exceeded 50MB limit, resetting');
      this.buffer = Buffer.alloc(0);
      this.rejectPendingRequests(new Error('LSP response buffer overflow'));
      return;
    }

    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString();
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        // Invalid header, try to recover
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        break; // Not enough data yet
      }

      const messageJson = this.buffer.subarray(messageStart, messageEnd).toString();
      this.buffer = this.buffer.subarray(messageEnd);

      try {
        const message = JSON.parse(messageJson);
        this.handleMessage(message);
      } catch {
        // Invalid JSON, skip
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in message && message.id !== undefined) {
      // Response to a request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ('method' in message) {
      // Notification from server
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  /**
   * Handle server notifications
   */
  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'textDocument/publishDiagnostics') {
      const params = this.translateIncomingPayload(notification.params) as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics);
      // Wake any waiters registered via waitForDiagnostics()
      const waiters = this.diagnosticWaiters.get(params.uri);
      if (waiters && waiters.length > 0) {
        this.diagnosticWaiters.delete(params.uri);
        for (const wake of waiters) wake();
      }
    }
    // Handle other notifications as needed
  }

  /**
   * Send a request to the server
   */
  private async request<T>(method: string, params: unknown, timeout?: number): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error('LSP server not connected');
    }

    const effectiveTimeout = timeout ?? getLspRequestTimeout(this.serverConfig, method);

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    const content = JSON.stringify(request);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutHandle
      });

      this.process?.stdin?.write(message);
    });
  }

  /**
   * Send a notification to the server (no response expected)
   */
  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    };

    const content = JSON.stringify(notification);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    this.process.stdin.write(message);
  }

  /**
   * Initialize the LSP connection
   */
  private async initialize(): Promise<void> {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: this.getWorkspaceRootUri(),
      rootPath: this.getServerWorkspaceRoot(),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
          rename: { prepareSupport: true }
        },
        workspace: {
          symbol: {},
          workspaceFolders: true
        }
      },
      initializationOptions: this.serverConfig.initializationOptions || {}
    }, getLspRequestTimeout(this.serverConfig, 'initialize'));

    this.notify('initialized', {});
  }

  /**
   * Open a document for editing
   */
  async openDocument(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);
    const uri = this.toServerUri(hostUri);

    if (this.openDocuments.has(hostUri)) return;

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const languageId = this.getLanguageId(filePath);

    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });

    this.openDocuments.add(hostUri);

    // Wait a bit for the server to process the document
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Close a document
   */
  closeDocument(filePath: string): void {
    const hostUri = fileUri(filePath);
    const uri = this.toServerUri(hostUri);

    if (!this.openDocuments.has(hostUri)) return;

    this.notify('textDocument/didClose', {
      textDocument: { uri }
    });

    this.openDocuments.delete(hostUri);
  }

  /**
   * Get the language ID for a file
   */
  private getLanguageId(filePath: string): string {
    // parse().ext correctly handles dotfiles: parse('.eslintrc').ext === ''
    // whereas split('.').pop() returns 'eslintrc' for dotfiles (incorrect)
    const ext = parse(filePath).ext.slice(1).toLowerCase();
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescriptreact',
      'js': 'javascript',
      'jsx': 'javascriptreact',
      'mts': 'typescript',
      'cts': 'typescript',
      'mjs': 'javascript',
      'cjs': 'javascript',
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'c': 'c',
      'h': 'c',
      'cpp': 'cpp',
      'cc': 'cpp',
      'hpp': 'cpp',
      'java': 'java',
      'json': 'json',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'php': 'php',
      'phtml': 'php',
      'rb': 'ruby',
      'rake': 'ruby',
      'gemspec': 'ruby',
      'erb': 'ruby',
      'lua': 'lua',
      'kt': 'kotlin',
      'kts': 'kotlin',
      'ex': 'elixir',
      'exs': 'elixir',
      'heex': 'elixir',
      'eex': 'elixir',
      'cs': 'csharp'
    };
    return langMap[ext] || ext;
  }

  /**
   * Convert file path to URI and ensure document is open
   */
  private async prepareDocument(filePath: string): Promise<string> {
    await this.openDocument(filePath);
    return this.toServerUri(fileUri(filePath));
  }

  // LSP Request Methods

  /**
   * Get hover information at a position
   */
  async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position: { line, character }
    });
    return this.translateIncomingPayload(result) as Hover | null;
  }

  /**
   * Go to definition
   */
  async definition(filePath: string, line: number, character: number): Promise<Location | Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Location | Location[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: { line, character }
    });
    return this.translateIncomingPayload(result) as Location | Location[] | null;
  }

  /**
   * Find all references
   */
  async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Location[] | null>('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration }
    });
    return this.translateIncomingPayload(result) as Location[] | null;
  }

  /**
   * Get document symbols
   */
  async documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', {
      textDocument: { uri }
    });
    return this.translateIncomingPayload(result) as DocumentSymbol[] | SymbolInformation[] | null;
  }

  /**
   * Search workspace symbols
   */
  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    const result = await this.request<SymbolInformation[] | null>('workspace/symbol', { query });
    return this.translateIncomingPayload(result) as SymbolInformation[] | null;
  }

  /**
   * Get diagnostics for a file
   */
  getDiagnostics(filePath: string): Diagnostic[] {
    const uri = fileUri(filePath);
    return this.diagnostics.get(uri) || [];
  }

  /**
   * Wait for the server to publish diagnostics for a file.
   * Resolves as soon as textDocument/publishDiagnostics fires for the URI,
   * or after `timeoutMs` milliseconds (whichever comes first).
   * This replaces fixed-delay sleeps with a notification-driven approach.
   */
  waitForDiagnostics(filePath: string, timeoutMs = 2000): Promise<void> {
    const uri = fileUri(filePath);

    // If diagnostics are already present, resolve immediately.
    if (this.diagnostics.has(uri)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.diagnosticWaiters.delete(uri);
          resolve();
        }
      }, timeoutMs);

      // Store the resolver so handleNotification can wake it up.
      const existing = this.diagnosticWaiters.get(uri) || [];
      existing.push(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      });
      this.diagnosticWaiters.set(uri, existing);
    });
  }

  /**
   * Prepare rename (check if rename is valid)
   */
  async prepareRename(filePath: string, line: number, character: number): Promise<Range | null> {
    const uri = await this.prepareDocument(filePath);
    try {
      const result = await this.request<Range | { range: Range; placeholder: string } | null>('textDocument/prepareRename', {
        textDocument: { uri },
        position: { line, character }
      });
      if (!result) return null;
      return 'range' in result ? result.range : result;
    } catch {
      return null;
    }
  }

  /**
   * Rename a symbol
   */
  async rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<WorkspaceEdit | null>('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName
    });
    return this.translateIncomingPayload(result) as WorkspaceEdit | null;
  }

  /**
   * Get code actions
   */
  async codeActions(filePath: string, range: Range, diagnostics: Diagnostic[] = []): Promise<CodeAction[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<CodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: { diagnostics }
    });
    return this.translateIncomingPayload(result) as CodeAction[] | null;
  }

  private getServerWorkspaceRoot(): string {
    return this.devContainerContext?.containerWorkspaceRoot ?? this.workspaceRoot;
  }

  private getWorkspaceRootUri(): string {
    return this.toServerUri(pathToFileURL(this.workspaceRoot).href);
  }

  private toServerUri(uri: string): string {
    return hostUriToContainerUri(uri, this.devContainerContext);
  }

  private toHostUri(uri: string): string {
    return containerUriToHostUri(uri, this.devContainerContext);
  }

  private translateIncomingPayload<T>(value: T): T {
    if (!this.devContainerContext || value == null) {
      return value;
    }

    return this.translateIncomingValue(value) as T;
  }

  private translateIncomingValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.translateIncomingValue(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    const translatedEntries = Object.entries(record).map(([key, entryValue]) => {
      if ((key === 'uri' || key === 'targetUri' || key === 'newUri' || key === 'oldUri') && typeof entryValue === 'string') {
        return [key, this.toHostUri(entryValue)];
      }

      if (key === 'changes' && entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
        const translatedChanges = Object.fromEntries(
          Object.entries(entryValue as Record<string, unknown>).map(([uri, changeValue]) => [
            this.toHostUri(uri),
            this.translateIncomingValue(changeValue)
          ])
        );
        return [key, translatedChanges];
      }

      return [key, this.translateIncomingValue(entryValue)];
    });

    return Object.fromEntries(translatedEntries);
  }
}

/** Idle timeout: disconnect LSP clients unused for 5 minutes */
export const IDLE_TIMEOUT_MS = readPositiveIntEnv('OMC_LSP_IDLE_TIMEOUT_MS', 5 * 60 * 1000);
/** Check for idle clients every 60 seconds */
export const IDLE_CHECK_INTERVAL_MS = readPositiveIntEnv('OMC_LSP_IDLE_CHECK_INTERVAL_MS', 60 * 1000);

/**
 * Client manager - maintains a pool of LSP clients per workspace/server
 * with idle eviction to free resources and in-flight request protection.
 */
export class LspClientManager {
  private clients = new Map<string, LspClient>();
  private lastUsed = new Map<string, number>();
  private inFlightCount = new Map<string, number>();
  private idleDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startIdleCheck();
    this.registerCleanupHandlers();
  }

  /**
   * Register process exit/signal handlers to kill all spawned LSP server processes.
   * Prevents orphaned language server processes (e.g. kotlin-language-server)
   * when the MCP bridge process exits or a claude session ends.
   */
  private registerCleanupHandlers(): void {
    const forceKillAll = () => {
      if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
      for (const timer of this.idleDeadlines.values()) {
        clearTimeout(timer);
      }
      this.idleDeadlines.clear();
      for (const client of this.clients.values()) {
        try {
          client.forceKill();
        } catch {
          // Ignore errors during cleanup
        }
      }
      this.clients.clear();
      this.lastUsed.clear();
      this.inFlightCount.clear();
    };

    // 'exit' handler must be synchronous — forceKill() is sync
    process.on('exit', forceKillAll);

    // For signals, force-kill LSP servers but do NOT call process.exit()
    // to allow other signal handlers (e.g., Python bridge cleanup) to run
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(sig, forceKillAll);
    }
  }

  /**
   * Get or create a client for a file
   */
  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const serverConfig = getServerForFile(filePath);
    if (!serverConfig) {
      return null;
    }

    // Find workspace root
    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const devContainerContext = resolveDevContainerContext(workspaceRoot);
    const key = `${workspaceRoot}:${serverConfig.command}:${devContainerContext?.containerId ?? 'host'}`;

    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(workspaceRoot, serverConfig, devContainerContext);
      try {
        await client.connect();
        this.clients.set(key, client);
      } catch (error) {
        throw error;
      }
    }

    this.touchClient(key);

    return client;
  }

  /**
   * Run a function with in-flight tracking for the client serving filePath.
   * While the function is running, the client is protected from idle eviction.
   * The lastUsed timestamp is refreshed on both entry and exit.
   */
  async runWithClientLease<T>(filePath: string, fn: (client: LspClient) => Promise<T>): Promise<T> {
    const serverConfig = getServerForFile(filePath);
    if (!serverConfig) {
      throw new Error(`No language server available for: ${filePath}`);
    }

    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const devContainerContext = resolveDevContainerContext(workspaceRoot);
    const key = `${workspaceRoot}:${serverConfig.command}:${devContainerContext?.containerId ?? 'host'}`;

    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(workspaceRoot, serverConfig, devContainerContext);
      try {
        await client.connect();
        this.clients.set(key, client);
      } catch (error) {
        throw error;
      }
    }

    // Touch timestamp and increment in-flight counter
    this.touchClient(key);
    this.inFlightCount.set(key, (this.inFlightCount.get(key) || 0) + 1);

    try {
      return await fn(client);
    } finally {
      // Decrement in-flight counter and refresh timestamp
      const count = (this.inFlightCount.get(key) || 1) - 1;
      if (count <= 0) {
        this.inFlightCount.delete(key);
      } else {
        this.inFlightCount.set(key, count);
      }
      this.touchClient(key);
    }
  }

  private touchClient(key: string): void {
    this.lastUsed.set(key, Date.now());
    this.scheduleIdleDeadline(key);
  }

  private scheduleIdleDeadline(key: string): void {
    this.clearIdleDeadline(key);

    const timer = setTimeout(() => {
      this.idleDeadlines.delete(key);
      this.evictClientIfIdle(key);
    }, IDLE_TIMEOUT_MS);

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }

    this.idleDeadlines.set(key, timer);
  }

  private clearIdleDeadline(key: string): void {
    const timer = this.idleDeadlines.get(key);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.idleDeadlines.delete(key);
  }

  /**
   * Find the workspace root for a file
   */
  private findWorkspaceRoot(filePath: string): string {
    let dir = dirname(resolve(filePath));
    const markers = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.git'];

    // Cross-platform root detection
    while (true) {
      const parsed = parse(dir);
      // On Windows: C:\ has root === dir, On Unix: / has root === dir
      if (parsed.root === dir) {
        break;
      }

      for (const marker of markers) {
        const markerPath = join(dir, marker);
        if (existsSync(markerPath)) {
          return dir;
        }
      }
      dir = dirname(dir);
    }

    return dirname(resolve(filePath));
  }

  /**
   * Start periodic idle check
   */
  private startIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      this.evictIdleClients();
    }, IDLE_CHECK_INTERVAL_MS);
    // Allow the process to exit even if the timer is running
    if (this.idleTimer && typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  /**
   * Evict clients that haven't been used within IDLE_TIMEOUT_MS.
   * Clients with in-flight requests are never evicted.
   */
  private evictIdleClients(): void {
    for (const key of this.lastUsed.keys()) {
      this.evictClientIfIdle(key);
    }
  }

  private evictClientIfIdle(key: string): void {
    const lastUsedTime = this.lastUsed.get(key);
    if (lastUsedTime === undefined) {
      this.clearIdleDeadline(key);
      return;
    }

    const idleFor = Date.now() - lastUsedTime;
    if (idleFor <= IDLE_TIMEOUT_MS) {
      const hasDeadline = this.idleDeadlines.has(key);
      if (!hasDeadline) {
        this.scheduleIdleDeadline(key);
      }
      return;
    }

    // Skip eviction if there are in-flight requests
    if ((this.inFlightCount.get(key) || 0) > 0) {
      this.scheduleIdleDeadline(key);
      return;
    }

    const client = this.clients.get(key);
    this.clearIdleDeadline(key);
    this.clients.delete(key);
    this.lastUsed.delete(key);
    this.inFlightCount.delete(key);

    if (client) {
      client.disconnect().catch(() => {
        // Ignore disconnect errors during eviction
      });
    }
  }

  /**
   * Disconnect all clients and stop idle checking.
   * Uses Promise.allSettled so one failing disconnect doesn't block others.
   * Maps are always cleared regardless of individual disconnect failures.
   */
  async disconnectAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    for (const timer of this.idleDeadlines.values()) {
      clearTimeout(timer);
    }
    this.idleDeadlines.clear();

    const entries = Array.from(this.clients.entries());
    const results = await Promise.allSettled(
      entries.map(([, client]) => client.disconnect())
    );

    // Log any per-client failures at warn level
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const key = entries[i][0];
        console.warn(`LSP disconnectAll: failed to disconnect client "${key}": ${result.reason}`);
      }
    }

    // Always clear maps regardless of individual failures
    this.clients.clear();
    this.lastUsed.clear();
    this.inFlightCount.clear();
  }

  /** Expose in-flight count for testing */
  getInFlightCount(key: string): number {
    return this.inFlightCount.get(key) || 0;
  }

  /** Expose client count for testing */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Trigger idle eviction manually (exposed for testing) */
  triggerEviction(): void {
    this.evictIdleClients();
  }
}

const LSP_CLIENT_MANAGER_KEY = '__omcLspClientManager';
type GlobalWithLspClientManager = typeof globalThis & {
  [LSP_CLIENT_MANAGER_KEY]?: LspClientManager;
};

// Export a process-global singleton instance. This protects against duplicate
// manager instances if the module is loaded more than once in the same process
// (for example after module resets in tests or bundle indirection).
const globalWithLspClientManager = globalThis as GlobalWithLspClientManager;
export const lspClientManager = globalWithLspClientManager[LSP_CLIENT_MANAGER_KEY]
  ?? (globalWithLspClientManager[LSP_CLIENT_MANAGER_KEY] = new LspClientManager());

/**
 * Disconnect all LSP clients and free resources.
 * Exported for use in session-end hooks.
 */
export async function disconnectAll(): Promise<void> {
  return lspClientManager.disconnectAll();
}
