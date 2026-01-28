/**
 * LSP Client Implementation
 *
 * Manages connections to language servers using JSON-RPC 2.0 over stdio.
 * Handles server lifecycle, message buffering, and request/response matching.
 */

import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, parse, join } from 'path';
import type { LspServerConfig } from './servers.js';
import { getServerForFile, commandExists } from './servers.js';

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
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private buffer = '';
  private openDocuments = new Set<string>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private workspaceRoot: string;
  private serverConfig: LspServerConfig;
  private initialized = false;

  constructor(workspaceRoot: string, serverConfig: LspServerConfig) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.serverConfig = serverConfig;
  }

  /**
   * Start the LSP server and initialize the connection
   */
  async connect(): Promise<void> {
    if (this.process) {
      return; // Already connected
    }

    if (!commandExists(this.serverConfig.command)) {
      throw new Error(
        `Language server '${this.serverConfig.command}' not found.\n` +
        `Install with: ${this.serverConfig.installHint}`
      );
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(this.serverConfig.command, this.serverConfig.args, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
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
   * Disconnect from the LSP server
   */
  async disconnect(): Promise<void> {
    if (!this.process) return;

    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.pendingRequests.clear();
    this.openDocuments.clear();
    this.diagnostics.clear();
  }

  /**
   * Handle incoming data from the server
   */
  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        // Invalid header, try to recover
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        break; // Not enough data yet
      }

      const messageJson = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

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
      const params = notification.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics);
    }
    // Handle other notifications as needed
  }

  /**
   * Send a request to the server
   */
  private async request<T>(method: string, params: unknown, timeout = 15000): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error('LSP server not connected');
    }

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
        reject(new Error(`LSP request '${method}' timed out after ${timeout}ms`));
      }, timeout);

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
      rootUri: `file://${this.workspaceRoot}`,
      rootPath: this.workspaceRoot,
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
    });

    this.notify('initialized', {});
  }

  /**
   * Open a document for editing
   */
  async openDocument(filePath: string): Promise<void> {
    const uri = `file://${resolve(filePath)}`;

    if (this.openDocuments.has(uri)) return;

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

    this.openDocuments.add(uri);

    // Wait a bit for the server to process the document
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Close a document
   */
  closeDocument(filePath: string): void {
    const uri = `file://${resolve(filePath)}`;

    if (!this.openDocuments.has(uri)) return;

    this.notify('textDocument/didClose', {
      textDocument: { uri }
    });

    this.openDocuments.delete(uri);
  }

  /**
   * Get the language ID for a file
   */
  private getLanguageId(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
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
      'lua': 'lua',
      'kt': 'kotlin',
      'kts': 'kotlin',
      'ex': 'elixir',
      'exs': 'elixir',
      'cs': 'csharp'
    };
    return langMap[ext] || ext;
  }

  /**
   * Convert file path to URI and ensure document is open
   */
  private async prepareDocument(filePath: string): Promise<string> {
    await this.openDocument(filePath);
    return `file://${resolve(filePath)}`;
  }

  // LSP Request Methods

  /**
   * Get hover information at a position
   */
  async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
    const uri = await this.prepareDocument(filePath);
    return this.request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position: { line, character }
    });
  }

  /**
   * Go to definition
   */
  async definition(filePath: string, line: number, character: number): Promise<Location | Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    return this.request<Location | Location[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: { line, character }
    });
  }

  /**
   * Find all references
   */
  async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    return this.request<Location[] | null>('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration }
    });
  }

  /**
   * Get document symbols
   */
  async documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const uri = await this.prepareDocument(filePath);
    return this.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', {
      textDocument: { uri }
    });
  }

  /**
   * Search workspace symbols
   */
  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    return this.request<SymbolInformation[] | null>('workspace/symbol', { query });
  }

  /**
   * Get diagnostics for a file
   */
  getDiagnostics(filePath: string): Diagnostic[] {
    const uri = `file://${resolve(filePath)}`;
    return this.diagnostics.get(uri) || [];
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
    return this.request<WorkspaceEdit | null>('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName
    });
  }

  /**
   * Get code actions
   */
  async codeActions(filePath: string, range: Range, diagnostics: Diagnostic[] = []): Promise<CodeAction[] | null> {
    const uri = await this.prepareDocument(filePath);
    return this.request<CodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: { diagnostics }
    });
  }
}

/**
 * Client manager - maintains a pool of LSP clients per workspace/server
 */
class LspClientManager {
  private clients = new Map<string, LspClient>();

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
    const key = `${workspaceRoot}:${serverConfig.command}`;

    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(workspaceRoot, serverConfig);
      try {
        await client.connect();
        this.clients.set(key, client);
      } catch (error) {
        throw error;
      }
    }

    return client;
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
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}

// Export a singleton instance
export const lspClientManager = new LspClientManager();
