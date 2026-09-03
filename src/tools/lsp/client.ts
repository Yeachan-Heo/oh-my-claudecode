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

function createCancellationSignal(): { promise: Promise<void>; cancel: () => void } {
  let cancel!: () => void;
  const promise = new Promise<void>((resolveCancellation) => {
    cancel = resolveCancellation;
  });
  return { promise, cancel };
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
/** Inbound server request IDs may be strings or integer numbers. */
type JsonRpcServerRequestId = number | string;

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

interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: JsonRpcServerRequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcServerRequestId;
  error: { code: number; message: string };
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
  private notificationTail: Promise<void> = Promise.resolve();
  private notificationGeneration = 0;
  private notificationWaiterRejectors = new Set<(error: Error) => void>();
  private openDocuments = new Set<string>();
  private persistentDocuments = new Set<string>();
  private documentOpenPromises = new Map<string, Promise<void>>();
  private documentOperationTails = new Map<string, Promise<void>>();
  private documentQueueCancellation = createCancellationSignal();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<(error?: Error) => void>>();
  private workspaceRoot: string;
  private serverConfig: LspServerConfig;
  private devContainerContext: DevContainerContext | null;
  private initialized = false;
  private disconnected = false;
  private connectionGeneration = 0;
  private terminalError: Error | null = null;
  private _serverCapabilities: Record<string, unknown> | null = null;
  private _supportsPullDiagnostics = false;

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
    this.disconnected = false;
    this.terminalError = null;
    const connectionGeneration = ++this.connectionGeneration;
    this.documentQueueCancellation.cancel();
    this.documentQueueCancellation = createCancellationSignal();
    this.buffer = Buffer.alloc(0);
    this.openDocuments.clear();
    this.persistentDocuments.clear();
    this.documentOpenPromises.clear();
    this.documentOperationTails.clear();
    this.diagnostics.clear();
    this.buffer = Buffer.alloc(0);
    this.documentOperationTails.clear();
    this.diagnostics.clear();

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
      const child = this.process;

      child.stdout?.on('data', (data: Buffer) => {
        if (this.process !== child || this.connectionGeneration !== connectionGeneration) return;
        this.handleData(data);
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (this.process !== child || this.connectionGeneration !== connectionGeneration) return;
        // Log stderr for debugging but don't fail
        console.error(`LSP stderr: ${data.toString()}`);
      });

      const stdin = child.stdin;
      if (stdin && typeof stdin.on === 'function') {
        stdin.on('error', (error: Error) => {
          if (this.process !== child || this.connectionGeneration !== connectionGeneration) return;
          this.handleTransportFailure(error);
        });
        stdin.on('close', () => {
          if (this.process === child && this.connectionGeneration === connectionGeneration && !this.disconnected) {
            this.handleTransportFailure(new Error('LSP stdin closed'));
          }
        });
      }

      child.on('error', (error) => {
        if (this.process !== child || this.connectionGeneration !== connectionGeneration) return;
        this.handleTransportFailure(error);
        reject(new Error(`Failed to start LSP server: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (this.process !== child || this.connectionGeneration !== connectionGeneration) return;
        this.process = null;
        this.handleTransportFailure(new Error(`LSP server exited (code ${code})`));
        if (code !== 0) {
          console.error(`LSP server exited with code ${code}`);
        }
      });

      // Send initialize request
      this.initialize()
        .then(() => {
          if (this.process !== child || this.connectionGeneration !== connectionGeneration) {
            reject(new Error('LSP server was replaced during initialization'));
            return;
          }
          this.initialized = true;
          resolve();
        })
        .catch(error => {
          if (this.process === child && this.connectionGeneration === connectionGeneration) {
            this.forceKill();
          } else {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore cleanup failures for a retired child.
            }
          }
          reject(error);
        });
    });
  }

  /**
   * Synchronously kill the LSP server process.
   * Used in process exit handlers where async operations are not possible.
   */
  forceKill(): void {
    const error = new Error('LSP client force-killed');
    this.connectionGeneration++;
    this.documentQueueCancellation.cancel();
    this.terminalError = error;
    this.cancelPendingNotificationWrites(error);
    this.rejectPendingRequests(error);
    this.disconnected = true;
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Ignore errors during kill
      }
      this.process = null;
      this.initialized = false;
    }
    this.cancelDiagnosticWaiters(error);
    this.openDocuments.clear();
    this.persistentDocuments.clear();
    this.documentOpenPromises.clear();
    this.documentOperationTails.clear();
    this.diagnostics.clear();
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Disconnect from the LSP server
   */
  async disconnect(): Promise<void> {
    const child = this.process;
    const connectionGeneration = this.connectionGeneration;
    try {
      if (child && this.process === child && this.connectionGeneration === connectionGeneration) {
        // Short timeout for graceful shutdown — don't block forever
        await this.request('shutdown', null, 3000);
        if (this.process === child && this.connectionGeneration === connectionGeneration) {
          await Promise.race([
            this.notifyWithBackpressure('exit', null),
            new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 250))
          ]);
        }
      }
    } catch {
      // Ignore errors during shutdown
    } finally {
      if (this.process !== child || this.connectionGeneration !== connectionGeneration) {
        if (child) {
          try {
            child.kill();
          } catch {
            // Ignore cleanup failures for a retired child.
          }
        }
      } else {
        const error = new Error('LSP client disconnected');
        this.connectionGeneration++;
        this.documentQueueCancellation.cancel();
        this.terminalError = error;
        this.cancelPendingNotificationWrites(error);
        this.disconnected = true;
        // Always kill the process regardless of shutdown success
        if (child) {
          child.kill();
          this.process = null;
        }
        this.initialized = false;
        this.rejectPendingRequests(new Error('Client disconnected'));
        this.openDocuments.clear();
        this.persistentDocuments.clear();
        this.documentOpenPromises.clear();
        this.documentOperationTails.clear();
        this.diagnostics.clear();
        this.buffer = Buffer.alloc(0);
        this.cancelDiagnosticWaiters(new Error('LSP client disconnected'));
      }
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

  private handleTransportFailure(error: Error): void {
    if (this.disconnected) return;
    this.connectionGeneration++;
    this.documentQueueCancellation.cancel();
    this.disconnected = true;
    this.terminalError = error;
    this.cancelPendingNotificationWrites(error);
    this.rejectPendingRequests(error);
    this.cancelDiagnosticWaiters(error);
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Ignore failures while retiring a broken transport.
      }
      this.process = null;
    }
    this.initialized = false;
    this.openDocuments.clear();
    this.persistentDocuments.clear();
    this.documentOpenPromises.clear();
    this.documentOperationTails.clear();
    this.diagnostics.clear();
    this.buffer = Buffer.alloc(0);
  }

  private cancelDiagnosticWaiters(error: Error): void {
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const wake of waiters) wake(error);
    }
    this.diagnosticWaiters.clear();
  }

  private throwIfTerminal(): void {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.disconnected) {
      throw new Error('LSP client is disconnected');
    }
  }

  private isCurrentConnection(child: ChildProcess | null, connectionGeneration: number): boolean {
    return child !== null
      && this.process === child
      && this.connectionGeneration === connectionGeneration
      && !this.disconnected;
  }

  private assertCurrentConnection(child: ChildProcess | null, connectionGeneration: number): void {
    if (!this.isCurrentConnection(child, connectionGeneration)) {
      throw this.terminalError ?? new Error('LSP connection was replaced');
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
  private handleMessage(message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest): void {
    const record = message as unknown as Record<string, unknown>;
    const hasOwnMethod = Object.prototype.hasOwnProperty.call(message, 'method');
    const hasOwnId = Object.prototype.hasOwnProperty.call(message, 'id');

    if (hasOwnMethod && typeof record.method === 'string') {
      const id = record.id;
      if (hasOwnId) {
        if (typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id))) {
          this.handleServerRequest(message as JsonRpcServerRequest);
        }
        return;
      }

      this.handleNotification(message as JsonRpcNotification);
      return;
    }

    if (!hasOwnMethod && hasOwnId && typeof record.id === 'number') {
      // Response to a request
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);

        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }

  /** Reply to unsupported server requests without claiming they succeeded. */
  private handleServerRequest(request: JsonRpcServerRequest): void {
    const error = request.method === 'client/registerCapability'
      ? { code: -32803, message: 'Dynamic capability registration is not supported' }
      : { code: -32601, message: 'Method not found' };
    const response: JsonRpcErrorResponse = { jsonrpc: '2.0', id: request.id, error };
    const content = JSON.stringify(response);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    void this.enqueueOutboundWrite(() => this.writeMessage(message)).catch(() => {
      // The client teardown path already rejects pending work and closes stdin.
    });
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

      void this.enqueueOutboundWrite(() => {
        if (!this.pendingRequests.has(id)) {
          throw new Error(`LSP request '${method}' is no longer pending`);
        }
        return this.writeMessage(message);
      }).catch(error => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * Send a notification to the server (no response expected)
   */
  private notify(method: string, params: unknown): boolean {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    };

    const content = JSON.stringify(notification);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    return this.writeMessage(message);
  }

  private async notifyWithBackpressure(method: string, params: unknown): Promise<void> {
    return this.enqueueOutboundWrite(() => this.notify(method, params));
  }

  private async enqueueOutboundWrite(write: () => boolean): Promise<void> {
    const generation = this.notificationGeneration;
    const notification = this.notificationTail.then(() => {
      if (generation !== this.notificationGeneration) {
        throw new Error('LSP notification cancelled before write');
      }
      return this.writeWithBackpressure(write);
    });
    this.notificationTail = notification.catch(() => undefined);
    return notification;
  }

  private writeMessage(message: string): boolean {
    if (!this.process?.stdin) {
      throw new Error('LSP client is not connected');
    }
    try {
      return this.process.stdin.write(message);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleTransportFailure(failure);
      throw failure;
    }
  }

  private async writeWithBackpressure(write: () => boolean): Promise<void> {
    const stdin = this.process?.stdin;
    if (write() || !stdin) {
      return;
    }
    if (typeof stdin.once !== 'function' || typeof stdin.off !== 'function') {
      return;
    }

    await new Promise<void>((resolveDrain, rejectDrain) => {
      const cleanup = () => {
        stdin.off('drain', handleDrain);
        stdin.off('error', handleError);
        stdin.off('close', handleClose);
        this.notificationWaiterRejectors.delete(handleCancel);
      };
      const handleDrain = () => {
        cleanup();
        resolveDrain();
      };
      const handleError = (error: Error) => {
        cleanup();
        rejectDrain(error);
      };
      const handleClose = () => {
        handleError(new Error('LSP stdin closed before drain'));
      };
      const handleCancel = (error: Error) => {
        handleError(error);
      };
      this.notificationWaiterRejectors.add(handleCancel);
      stdin.once('drain', handleDrain);
      stdin.once('error', handleError);
      stdin.once('close', handleClose);
    });
  }

  private cancelPendingNotificationWrites(error: Error): void {
    this.notificationGeneration++;
    for (const reject of Array.from(this.notificationWaiterRejectors)) {
      reject(error);
    }
  }

  /**
   * Initialize the LSP connection
   */
  private async initialize(): Promise<void> {
    const child = this.process;
    const connectionGeneration = this.connectionGeneration;
    const initResult = await this.request<{ capabilities?: Record<string, unknown> }>('initialize', {
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
          rename: { prepareSupport: true },
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] }
          }
        },
        workspace: {
          symbol: {},
          workspaceFolders: true
        }
      },
      initializationOptions: this.serverConfig.initializationOptions || {}
    }, getLspRequestTimeout(this.serverConfig, 'initialize'));

    this.assertCurrentConnection(child, connectionGeneration);
    this._serverCapabilities = initResult?.capabilities ?? null;
    this._supportsPullDiagnostics = !!this._serverCapabilities?.diagnosticProvider;

    await this.notifyWithBackpressure('initialized', {});
    this.assertCurrentConnection(child, connectionGeneration);
  }

  /**
   * Open a document for editing
   */
  async openDocument(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);
    await this.queueDocumentOperation(hostUri, async () => {
      await this.ensureDocumentOpen(filePath);
      this.persistentDocuments.add(hostUri);
    });
  }

  private async ensureDocumentOpen(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);

    if (this.openDocuments.has(hostUri)) return;

    const pending = this.documentOpenPromises.get(hostUri);
    if (pending) return pending;

    const opening = this.performDocumentOpen(filePath, hostUri).finally(() => {
      if (this.documentOpenPromises.get(hostUri) === opening) {
        this.documentOpenPromises.delete(hostUri);
      }
    });
    this.documentOpenPromises.set(hostUri, opening);
    return opening;
  }

  private async performDocumentOpen(filePath: string, hostUri: string): Promise<void> {
    this.throwIfTerminal();
    const child = this.process;
    const connectionGeneration = this.connectionGeneration;
    const uri = this.toServerUri(hostUri);

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const languageId = this.getLanguageId(filePath);

    // A reopened document needs fresh diagnostics rather than a cached result
    // from its previous didOpen/didClose lifecycle.
    this.diagnostics.delete(hostUri);

    await this.notifyWithBackpressure('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });

    this.assertCurrentConnection(child, connectionGeneration);
    this.openDocuments.add(hostUri);

    // Wait a bit for the server to process the document
    await new Promise(resolve => setTimeout(resolve, 100));
    this.assertCurrentConnection(child, connectionGeneration);
    this.throwIfTerminal();
  }

  /**
   * Close a document
   */
  async closeDocument(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);
    await this.queueDocumentOperation(hostUri, async () => {
      this.persistentDocuments.delete(hostUri);
      await this.closeTransientDocument(filePath);
    });
  }

  private async closeTransientDocument(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);
    const uri = this.toServerUri(hostUri);
    const child = this.process;
    const connectionGeneration = this.connectionGeneration;

    if (!this.openDocuments.has(hostUri)) return;

    try {
      await this.notifyWithBackpressure('textDocument/didClose', {
        textDocument: { uri }
      });
    } finally {
      if (this.isCurrentConnection(child, connectionGeneration)) {
        this.openDocuments.delete(hostUri);
      }
    }
  }

  /**
   * Run an operation while a document is open, closing only documents opened
   * by this operation. Calls for the same document are serialized so one
   * operation cannot close the document while another is still using it.
   */
  async withOpenDocument<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const hostUri = fileUri(filePath);
    const connectionGeneration = this.connectionGeneration;
    return this.queueDocumentOperation(hostUri, async () => {
      try {
        await this.ensureDocumentOpen(filePath);
        return await operation();
      } finally {
        if (this.connectionGeneration === connectionGeneration && !this.persistentDocuments.has(hostUri)) {
          await this.closeTransientDocument(filePath);
        }
      }
    });
  }

  private async queueDocumentOperation<T>(hostUri: string, operation: () => Promise<T>): Promise<T> {
    const connectionGeneration = this.connectionGeneration;
    const cancellation = this.documentQueueCancellation.promise;
    const previous = this.documentOperationTails.get(hostUri) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.documentOperationTails.set(hostUri, tail);

    const predecessorCompleted = await Promise.race([
      previous.then(() => true, () => true),
      cancellation.then(() => false)
    ]);

    try {
      if (!predecessorCompleted || this.connectionGeneration !== connectionGeneration) {
        throw this.terminalError ?? new Error('LSP connection was replaced');
      }
      this.throwIfTerminal();
      return await operation();
    } finally {
      release();
      if (this.documentOperationTails.get(hostUri) === tail) {
        this.documentOperationTails.delete(hostUri);
      }
    }
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
   * Whether the server supports LSP 3.17 pull diagnostics (textDocument/diagnostic).
   */
  get supportsPullDiagnostics(): boolean {
    return this._supportsPullDiagnostics;
  }

  get isUsable(): boolean {
    return !this.disconnected;
  }

  /**
   * Request diagnostics via the LSP 3.17 pull model (textDocument/diagnostic).
   * Only call when supportsPullDiagnostics is true.
   */
  async pullDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const uri = this.toServerUri(fileUri(filePath));
    const result = await this.request<{ kind?: string; items?: Array<Record<string, unknown>> }>(
      'textDocument/diagnostic',
      { textDocument: { uri } }
    );
    return ((result?.items) || []).map((d: Record<string, unknown>) => ({
      range: d.range as Range,
      message: d.message as string,
      severity: d.severity as number | undefined,
      source: d.source as string | undefined,
      code: d.code as string | number | undefined,
    }));
  }

  /**
   * Wait for the server to publish diagnostics for a file.
   * Resolves as soon as textDocument/publishDiagnostics fires for the URI,
   * or after `timeoutMs` milliseconds (whichever comes first).
   * This replaces fixed-delay sleeps with a notification-driven approach.
   */
  waitForDiagnostics(filePath: string, timeoutMs = 2000): Promise<void> {
    const uri = fileUri(filePath);
    try {
      this.throwIfTerminal();
    } catch (error) {
      return Promise.reject(error);
    }

    // If diagnostics are already present, resolve immediately.
    if (this.diagnostics.has(uri)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const removeWaiter = (waiter: (error?: Error) => void) => {
        const waiters = this.diagnosticWaiters.get(uri);
        if (!waiters) return;

        const remaining = waiters.filter(candidate => candidate !== waiter);
        if (remaining.length === 0) {
          this.diagnosticWaiters.delete(uri);
        } else {
          this.diagnosticWaiters.set(uri, remaining);
        }
      };
      const waiter = (error?: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      };
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          removeWaiter(waiter);
          resolve();
        }
      }, timeoutMs);

      // Store the resolver so handleNotification can wake it up.
      const existing = this.diagnosticWaiters.get(uri) || [];
      existing.push(waiter);
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
  private pendingClients = new Map<string, { client: LspClient; promise: Promise<LspClient> }>();
  private clientGeneration = 0;
  private disconnecting: Promise<void> | null = null;
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
      for (const { client } of this.pendingClients.values()) {
        try {
          client.forceKill();
        } catch {
          // Ignore errors during cleanup
        }
      }
      this.clientGeneration++;
      this.clients.clear();
      this.pendingClients.clear();
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
    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const serverConfig = getServerForFile(filePath, workspaceRoot);
    if (!serverConfig) {
      return null;
    }

    const devContainerContext = resolveDevContainerContext(workspaceRoot);
    const key = `${workspaceRoot}:${serverConfig.command}:${devContainerContext?.containerId ?? 'host'}`;

    while (true) {
      const client = await this.acquireClient(key, workspaceRoot, serverConfig, devContainerContext);
      if (this.clients.get(key) === client && client.isUsable && !this.disconnecting) {
        return client;
      }
    }
  }

  /**
   * Run a function with in-flight tracking for the client serving filePath.
   * While the function is running, the client is protected from idle eviction.
   * The lastUsed timestamp is refreshed on both entry and exit.
   */
  async runWithClientLease<T>(filePath: string, fn: (client: LspClient) => Promise<T>): Promise<T> {
    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const serverConfig = getServerForFile(filePath, workspaceRoot);
    if (!serverConfig) {
      throw new Error(`No language server available for: ${filePath}`);
    }

    const devContainerContext = resolveDevContainerContext(workspaceRoot);
    const key = `${workspaceRoot}:${serverConfig.command}:${devContainerContext?.containerId ?? 'host'}`;

    const client = await this.acquireClientLease(key, workspaceRoot, serverConfig, devContainerContext);

    try {
      return await fn(client);
    } finally {
      // A replaced or detached client must not mutate the replacement's lease count.
      if (this.clients.get(key) === client) {
        const count = (this.inFlightCount.get(key) || 1) - 1;
        if (count <= 0) {
          this.inFlightCount.delete(key);
        } else {
          this.inFlightCount.set(key, count);
        }
        this.touchClient(key);
      }
    }
  }

  private async getOrCreateClient(
    key: string,
    workspaceRoot: string,
    serverConfig: LspServerConfig,
    devContainerContext: DevContainerContext | null
  ): Promise<LspClient> {
    const existing = this.clients.get(key);
    if (existing?.isUsable) {
      return existing;
    }
    if (existing) {
      existing.forceKill();
      this.clients.delete(key);
      this.clearIdleDeadline(key);
      this.lastUsed.delete(key);
      this.inFlightCount.delete(key);
    }

    let pending = this.pendingClients.get(key);
    if (!pending) {
      const client = new LspClient(workspaceRoot, serverConfig, devContainerContext);
      const generation = this.clientGeneration;
      const promise = client.connect().then(() => {
        if (generation !== this.clientGeneration) {
          client.forceKill();
          throw new Error('LSP client manager shut down during connection');
        }
        this.clients.set(key, client);
        return client;
      }).finally(() => {
        if (this.pendingClients.get(key)?.client === client) {
          this.pendingClients.delete(key);
        }
      });
      pending = { client, promise };
      this.pendingClients.set(key, pending);
    }

    return pending.promise;
  }

  private async acquireClient(
    key: string,
    workspaceRoot: string,
    serverConfig: LspServerConfig,
    devContainerContext: DevContainerContext | null
  ): Promise<LspClient> {
    while (true) {
      const teardown = this.disconnecting;
      if (teardown) {
        await teardown;
      }

      const generation = this.clientGeneration;
      this.startIdleCheck();
      const existing = this.clients.get(key);
      if (existing?.isUsable) {
        this.touchClient(key);
        return existing;
      }
      const client = await this.getOrCreateClient(key, workspaceRoot, serverConfig, devContainerContext);
      if (generation === this.clientGeneration && !this.disconnecting && client.isUsable) {
        this.touchClient(key);
        return client;
      }
    }
  }

  private async acquireClientLease(
    key: string,
    workspaceRoot: string,
    serverConfig: LspServerConfig,
    devContainerContext: DevContainerContext | null
  ): Promise<LspClient> {
    while (true) {
      const teardown = this.disconnecting;
      if (teardown) {
        await teardown;
      }

      const generation = this.clientGeneration;
      this.startIdleCheck();
      const existing = this.clients.get(key);
      if (existing?.isUsable) {
        this.touchClient(key);
        this.inFlightCount.set(key, (this.inFlightCount.get(key) || 0) + 1);
        return existing;
      }
      const client = await this.getOrCreateClient(key, workspaceRoot, serverConfig, devContainerContext);
      if (generation === this.clientGeneration && !this.disconnecting && client.isUsable) {
        this.touchClient(key);
        this.inFlightCount.set(key, (this.inFlightCount.get(key) || 0) + 1);
        return client;
      }
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
    const markers = [
      'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
      'pom.xml', 'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
      'go.mod', '.git'
    ];

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
    if (this.disconnecting) {
      return this.disconnecting;
    }

    const teardown = Promise.resolve().then(() => this.performDisconnectAll());
    this.disconnecting = teardown;
    try {
      await teardown;
    } finally {
      if (this.disconnecting === teardown) {
        this.disconnecting = null;
      }
    }
  }

  private async performDisconnectAll(): Promise<void> {
    this.clientGeneration++;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    for (const timer of this.idleDeadlines.values()) {
      clearTimeout(timer);
    }
    this.idleDeadlines.clear();

    for (const { client } of this.pendingClients.values()) {
      try {
        client.forceKill();
      } catch {
        // Ignore errors while stopping clients that are still connecting
      }
    }
    this.pendingClients.clear();

    const entries = Array.from(this.clients.entries());
    this.clients.clear();
    this.lastUsed.clear();
    this.inFlightCount.clear();
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

    // Pending clients from the prior generation cannot publish.
    this.pendingClients.clear();
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
