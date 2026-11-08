/**
 * LSP Client Implementation
 *
 * Manages connections to language servers using JSON-RPC 2.0 over stdio.
 * Handles server lifecycle, message buffering, and request/response matching.
 */
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, parse, join } from 'path';
import { pathToFileURL } from 'url';
import { resolveDevContainerContext, hostUriToContainerUri, containerUriToHostUri } from './devcontainer.js';
import { getServerForFile, commandExists } from './servers.js';
/** Decimal magnitude whose integrality can be decided from the text. */
const DECIMAL_INTEGER_TEXT = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
/** Largest timeout delay Node.js timers preserve without overflowing to 1 ms. */
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Read one exact integer from an environment value.
 *
 * parseInt stops at the first character it cannot read, so "1e5" becomes 1,
 * "8.9" becomes 8, and "15_000" becomes 15. Number() consumes the whole
 * token, and the digit check rejects values that are not integers even when
 * the nearest double would round onto one.
 */
function parseExactInteger(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    const negative = trimmed.startsWith('-');
    const magnitude = negative || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
    const match = DECIMAL_INTEGER_TEXT.exec(magnitude);
    if (!match)
        return null;
    const integerDigits = match[1] ?? '';
    const fractionDigits = match[2] ?? match[3] ?? '';
    const exponent = match[4] === undefined ? 0 : Number(match[4]);
    const shift = fractionDigits.length - exponent;
    if (shift > 0) {
        const significand = integerDigits + fractionDigits;
        if (/[1-9]/.test(significand)) {
            const trailingZeros = significand.length - significand.replace(/0+$/, '').length;
            if (trailingZeros < shift)
                return null;
        }
    }
    const parsed = (negative ? -1 : 1) * Number(magnitude);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
function readPositiveIntEnv(name, fallback) {
    const env = process.env[name];
    if (!env || !env.trim()) {
        return fallback;
    }
    const parsed = parseExactInteger(env);
    return parsed !== null && parsed > 0 && parsed <= MAX_NODE_TIMER_DELAY_MS ? parsed : fallback;
}
/** Default timeout (ms) for LSP requests. Override with OMC_LSP_TIMEOUT_MS env var. */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = (() => {
    return readPositiveIntEnv('OMC_LSP_TIMEOUT_MS', 15_000);
})();
export function getLspRequestTimeout(serverConfig, method, baseTimeout = DEFAULT_LSP_REQUEST_TIMEOUT_MS) {
    if (method === 'initialize' && serverConfig.initializeTimeoutMs) {
        return Math.max(baseTimeout, serverConfig.initializeTimeoutMs);
    }
    return baseTimeout;
}
/** Convert a file path to a valid file:// URI (cross-platform) */
function fileUri(filePath) {
    return pathToFileURL(resolve(filePath)).href;
}
/**
 * Normalize a URI for use as a diagnostics key.
 * Handles Windows drive letter encoding (%3A/%3a colon) and case normalization.
 * Platform-independent: works correctly whether the input comes from Windows or POSIX systems.
 * Non-file URIs pass through unchanged.
 */
function uriKey(uri) {
    if (!uri.startsWith('file://')) {
        return uri;
    }
    // Decode percent-encoded characters to handle %3A/%3a (colon). A malformed
    // escape must not throw out of the notification handler: keep it verbatim.
    let decoded;
    try {
        decoded = decodeURIComponent(uri);
    }
    catch {
        decoded = uri;
    }
    // For Windows paths like file:///c:/Users/... normalize drive letter to uppercase
    // Match: file:///<single_char>:/ and uppercase the drive letter
    const match = decoded.match(/^(file:\/\/)(\/[a-zA-Z])(:.*)$/);
    if (match) {
        const driveLetter = match[2].charAt(1).toUpperCase();
        decoded = `${match[1]}/${driveLetter}${match[3]}`;
    }
    return decoded;
}
function createCancellationSignal() {
    let cancel;
    const promise = new Promise((resolveCancellation) => {
        cancel = resolveCancellation;
    });
    return { promise, cancel };
}
/**
 * LSP Client class
 */
export class LspClient {
    static MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB
    process = null;
    requestId = 0;
    pendingRequests = new Map();
    buffer = Buffer.alloc(0);
    notificationTail = Promise.resolve();
    notificationGeneration = 0;
    notificationWaiterRejectors = new Set();
    openDocuments = new Set();
    persistentDocuments = new Set();
    documentOpenPromises = new Map();
    documentOperationTails = new Map();
    documentQueueCancellation = createCancellationSignal();
    diagnostics = new Map();
    diagnosticWaiters = new Map();
    workspaceRoot;
    serverConfig;
    devContainerContext;
    initialized = false;
    disconnected = false;
    connectionGeneration = 0;
    terminalError = null;
    _serverCapabilities = null;
    _supportsPullDiagnostics = false;
    constructor(workspaceRoot, serverConfig, devContainerContext = null) {
        this.workspaceRoot = resolve(workspaceRoot);
        this.serverConfig = serverConfig;
        this.devContainerContext = devContainerContext;
    }
    /**
     * Start the LSP server and initialize the connection
     */
    async connect() {
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
            throw new Error(this.devContainerContext
                ? `Docker CLI not found. Required to start '${this.serverConfig.command}' inside container ${this.devContainerContext.containerId}.`
                : `Language server '${this.serverConfig.command}' not found.\nInstall with: ${this.serverConfig.installHint}`);
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
            child.stdout?.on('data', (data) => {
                if (this.process !== child || this.connectionGeneration !== connectionGeneration)
                    return;
                this.handleData(data);
            });
            child.stderr?.on('data', (data) => {
                if (this.process !== child || this.connectionGeneration !== connectionGeneration)
                    return;
                // Log stderr for debugging but don't fail
                console.error(`LSP stderr: ${data.toString()}`);
            });
            const stdin = child.stdin;
            if (stdin && typeof stdin.on === 'function') {
                stdin.on('error', (error) => {
                    if (this.process !== child || this.connectionGeneration !== connectionGeneration)
                        return;
                    this.handleTransportFailure(error);
                });
                stdin.on('close', () => {
                    if (this.process === child && this.connectionGeneration === connectionGeneration && !this.disconnected) {
                        this.handleTransportFailure(new Error('LSP stdin closed'));
                    }
                });
            }
            child.on('error', (error) => {
                if (this.process !== child || this.connectionGeneration !== connectionGeneration)
                    return;
                this.handleTransportFailure(error);
                reject(new Error(`Failed to start LSP server: ${error.message}`));
            });
            child.on('exit', (code) => {
                if (this.process !== child || this.connectionGeneration !== connectionGeneration)
                    return;
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
                }
                else {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
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
    forceKill() {
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
            }
            catch {
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
    async disconnect() {
        const child = this.process;
        const connectionGeneration = this.connectionGeneration;
        try {
            if (child && this.process === child && this.connectionGeneration === connectionGeneration) {
                // Short timeout for graceful shutdown — don't block forever
                await this.request('shutdown', null, 3000);
                if (this.process === child && this.connectionGeneration === connectionGeneration) {
                    await Promise.race([
                        this.notifyWithBackpressure('exit', null),
                        new Promise(resolveTimeout => setTimeout(resolveTimeout, 250))
                    ]);
                }
            }
        }
        catch {
            // Ignore errors during shutdown
        }
        finally {
            if (this.process !== child || this.connectionGeneration !== connectionGeneration) {
                if (child) {
                    try {
                        child.kill();
                    }
                    catch {
                        // Ignore cleanup failures for a retired child.
                    }
                }
            }
            else {
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
    rejectPendingRequests(error) {
        for (const [id, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
            this.pendingRequests.delete(id);
        }
    }
    handleTransportFailure(error) {
        if (this.disconnected)
            return;
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
            }
            catch {
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
    cancelDiagnosticWaiters(error) {
        for (const waiters of this.diagnosticWaiters.values()) {
            for (const wake of waiters)
                wake(error);
        }
        this.diagnosticWaiters.clear();
    }
    throwIfTerminal() {
        if (this.terminalError) {
            throw this.terminalError;
        }
        if (this.disconnected) {
            throw new Error('LSP client is disconnected');
        }
    }
    isCurrentConnection(child, connectionGeneration) {
        return child !== null
            && this.process === child
            && this.connectionGeneration === connectionGeneration
            && !this.disconnected;
    }
    assertCurrentConnection(child, connectionGeneration) {
        if (!this.isCurrentConnection(child, connectionGeneration)) {
            throw this.terminalError ?? new Error('LSP connection was replaced');
        }
    }
    /**
     * Handle incoming data from the server
     */
    handleData(data) {
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
            if (headerEnd === -1)
                break;
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
            }
            catch {
                // Invalid JSON, skip
            }
        }
    }
    /**
     * Handle a parsed JSON-RPC message
     */
    handleMessage(message) {
        const record = message;
        const hasOwnMethod = Object.prototype.hasOwnProperty.call(message, 'method');
        const hasOwnId = Object.prototype.hasOwnProperty.call(message, 'id');
        if (hasOwnMethod && typeof record.method === 'string') {
            const id = record.id;
            if (hasOwnId) {
                if (typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id))) {
                    this.handleServerRequest(message);
                }
                return;
            }
            this.handleNotification(message);
            return;
        }
        if (!hasOwnMethod && hasOwnId && typeof record.id === 'number') {
            // Response to a request
            const response = message;
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(response.id);
                if (response.error) {
                    pending.reject(new Error(response.error.message));
                }
                else {
                    pending.resolve(response.result);
                }
            }
        }
    }
    /** Reply to unsupported server requests without claiming they succeeded. */
    handleServerRequest(request) {
        const error = request.method === 'client/registerCapability'
            ? { code: -32803, message: 'Dynamic capability registration is not supported' }
            : { code: -32601, message: 'Method not found' };
        const response = { jsonrpc: '2.0', id: request.id, error };
        const content = JSON.stringify(response);
        const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
        void this.enqueueOutboundWrite(() => this.writeMessage(message)).catch(() => {
            // The client teardown path already rejects pending work and closes stdin.
        });
    }
    /**
     * Handle server notifications
     */
    handleNotification(notification) {
        if (notification.method === 'textDocument/publishDiagnostics') {
            const params = this.translateIncomingPayload(notification.params);
            const key = uriKey(params.uri);
            this.diagnostics.set(key, params.diagnostics);
            // Wake any waiters registered via waitForDiagnostics()
            const waiters = this.diagnosticWaiters.get(key);
            if (waiters && waiters.length > 0) {
                this.diagnosticWaiters.delete(key);
                for (const wake of waiters)
                    wake();
            }
        }
        // Handle other notifications as needed
    }
    /**
     * Send a request to the server
     */
    async request(method, params, timeout) {
        if (!this.process?.stdin) {
            throw new Error('LSP server not connected');
        }
        const effectiveTimeout = timeout ?? getLspRequestTimeout(this.serverConfig, method);
        const id = ++this.requestId;
        const request = {
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
                resolve: resolve,
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
                if (!pending)
                    return;
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(id);
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    /**
     * Send a notification to the server (no response expected)
     */
    notify(method, params) {
        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };
        const content = JSON.stringify(notification);
        const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
        return this.writeMessage(message);
    }
    async notifyWithBackpressure(method, params) {
        return this.enqueueOutboundWrite(() => this.notify(method, params));
    }
    async enqueueOutboundWrite(write) {
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
    writeMessage(message) {
        if (!this.process?.stdin) {
            throw new Error('LSP client is not connected');
        }
        try {
            return this.process.stdin.write(message);
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.handleTransportFailure(failure);
            throw failure;
        }
    }
    async writeWithBackpressure(write) {
        const stdin = this.process?.stdin;
        if (write() || !stdin) {
            return;
        }
        if (typeof stdin.once !== 'function' || typeof stdin.off !== 'function') {
            return;
        }
        await new Promise((resolveDrain, rejectDrain) => {
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
            const handleError = (error) => {
                cleanup();
                rejectDrain(error);
            };
            const handleClose = () => {
                handleError(new Error('LSP stdin closed before drain'));
            };
            const handleCancel = (error) => {
                handleError(error);
            };
            this.notificationWaiterRejectors.add(handleCancel);
            stdin.once('drain', handleDrain);
            stdin.once('error', handleError);
            stdin.once('close', handleClose);
        });
    }
    cancelPendingNotificationWrites(error) {
        this.notificationGeneration++;
        for (const reject of Array.from(this.notificationWaiterRejectors)) {
            reject(error);
        }
    }
    /**
     * Initialize the LSP connection
     */
    async initialize() {
        const child = this.process;
        const connectionGeneration = this.connectionGeneration;
        const initResult = await this.request('initialize', {
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
    async openDocument(filePath) {
        const hostUri = fileUri(filePath);
        await this.queueDocumentOperation(hostUri, async () => {
            await this.ensureDocumentOpen(filePath);
            this.persistentDocuments.add(hostUri);
        });
    }
    async ensureDocumentOpen(filePath) {
        const hostUri = fileUri(filePath);
        if (this.openDocuments.has(hostUri))
            return;
        const pending = this.documentOpenPromises.get(hostUri);
        if (pending)
            return pending;
        const opening = this.performDocumentOpen(filePath, hostUri).finally(() => {
            if (this.documentOpenPromises.get(hostUri) === opening) {
                this.documentOpenPromises.delete(hostUri);
            }
        });
        this.documentOpenPromises.set(hostUri, opening);
        return opening;
    }
    async performDocumentOpen(filePath, hostUri) {
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
        this.diagnostics.delete(uriKey(hostUri));
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
    async closeDocument(filePath) {
        const hostUri = fileUri(filePath);
        await this.queueDocumentOperation(hostUri, async () => {
            this.persistentDocuments.delete(hostUri);
            await this.closeTransientDocument(filePath);
        });
    }
    async closeTransientDocument(filePath) {
        const hostUri = fileUri(filePath);
        const uri = this.toServerUri(hostUri);
        const child = this.process;
        const connectionGeneration = this.connectionGeneration;
        if (!this.openDocuments.has(hostUri))
            return;
        try {
            await this.notifyWithBackpressure('textDocument/didClose', {
                textDocument: { uri }
            });
        }
        finally {
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
    async withOpenDocument(filePath, operation) {
        const hostUri = fileUri(filePath);
        const connectionGeneration = this.connectionGeneration;
        return this.queueDocumentOperation(hostUri, async () => {
            try {
                await this.ensureDocumentOpen(filePath);
                return await operation();
            }
            finally {
                if (this.connectionGeneration === connectionGeneration && !this.persistentDocuments.has(hostUri)) {
                    await this.closeTransientDocument(filePath);
                }
            }
        });
    }
    async queueDocumentOperation(hostUri, operation) {
        const connectionGeneration = this.connectionGeneration;
        const cancellation = this.documentQueueCancellation.promise;
        const previous = this.documentOperationTails.get(hostUri) ?? Promise.resolve();
        let release;
        const current = new Promise((resolveCurrent) => {
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
        }
        finally {
            release();
            if (this.documentOperationTails.get(hostUri) === tail) {
                this.documentOperationTails.delete(hostUri);
            }
        }
    }
    /**
     * Get the language ID for a file
     */
    getLanguageId(filePath) {
        // parse().ext correctly handles dotfiles: parse('.eslintrc').ext === ''
        // whereas split('.').pop() returns 'eslintrc' for dotfiles (incorrect)
        const ext = parse(filePath).ext.slice(1).toLowerCase();
        const langMap = {
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
    async prepareDocument(filePath) {
        await this.openDocument(filePath);
        return this.toServerUri(fileUri(filePath));
    }
    // LSP Request Methods
    /**
     * Get hover information at a position
     */
    async hover(filePath, line, character) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/hover', {
            textDocument: { uri },
            position: { line, character }
        });
        return this.translateIncomingPayload(result);
    }
    /**
     * Go to definition
     */
    async definition(filePath, line, character) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/definition', {
            textDocument: { uri },
            position: { line, character }
        });
        return this.translateIncomingPayload(result);
    }
    /**
     * Find all references
     */
    async references(filePath, line, character, includeDeclaration = true) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/references', {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration }
        });
        return this.translateIncomingPayload(result);
    }
    /**
     * Get document symbols
     */
    async documentSymbols(filePath) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/documentSymbol', {
            textDocument: { uri }
        });
        return this.translateIncomingPayload(result);
    }
    /**
     * Search workspace symbols
     */
    async workspaceSymbols(query) {
        const result = await this.request('workspace/symbol', { query });
        return this.translateIncomingPayload(result);
    }
    /**
     * Get diagnostics for a file
     */
    getDiagnostics(filePath) {
        const uri = fileUri(filePath);
        return this.diagnostics.get(uriKey(uri)) || [];
    }
    /**
     * Whether the server supports LSP 3.17 pull diagnostics (textDocument/diagnostic).
     */
    get supportsPullDiagnostics() {
        return this._supportsPullDiagnostics;
    }
    get isUsable() {
        return !this.disconnected;
    }
    /**
     * Request diagnostics via the LSP 3.17 pull model (textDocument/diagnostic).
     * Only call when supportsPullDiagnostics is true.
     */
    async pullDiagnostics(filePath) {
        const uri = this.toServerUri(fileUri(filePath));
        const result = await this.request('textDocument/diagnostic', { textDocument: { uri } });
        return ((result?.items) || []).map((d) => ({
            range: d.range,
            message: d.message,
            severity: d.severity,
            source: d.source,
            code: d.code,
        }));
    }
    /**
     * Wait for the server to publish diagnostics for a file.
     * Resolves as soon as textDocument/publishDiagnostics fires for the URI,
     * or after `timeoutMs` milliseconds (whichever comes first).
     * This replaces fixed-delay sleeps with a notification-driven approach.
     */
    waitForDiagnostics(filePath, timeoutMs = 2000) {
        const uri = fileUri(filePath);
        const key = uriKey(uri);
        try {
            this.throwIfTerminal();
        }
        catch (error) {
            return Promise.reject(error);
        }
        // If diagnostics are already present, resolve immediately.
        if (this.diagnostics.has(key)) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let resolved = false;
            const removeWaiter = (waiter) => {
                const waiters = this.diagnosticWaiters.get(key);
                if (!waiters)
                    return;
                const remaining = waiters.filter(candidate => candidate !== waiter);
                if (remaining.length === 0) {
                    this.diagnosticWaiters.delete(key);
                }
                else {
                    this.diagnosticWaiters.set(key, remaining);
                }
            };
            const waiter = (error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    if (error) {
                        reject(error);
                    }
                    else {
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
            const existing = this.diagnosticWaiters.get(key) || [];
            existing.push(waiter);
            this.diagnosticWaiters.set(key, existing);
        });
    }
    /**
     * Prepare rename (check if rename is valid)
     */
    async prepareRename(filePath, line, character) {
        const uri = await this.prepareDocument(filePath);
        try {
            const result = await this.request('textDocument/prepareRename', {
                textDocument: { uri },
                position: { line, character }
            });
            if (!result)
                return null;
            return 'range' in result ? result.range : result;
        }
        catch {
            return null;
        }
    }
    /**
     * Rename a symbol
     */
    async rename(filePath, line, character, newName) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/rename', {
            textDocument: { uri },
            position: { line, character },
            newName
        });
        return this.translateIncomingPayload(result);
    }
    /**
     * Get code actions
     */
    async codeActions(filePath, range, diagnostics = []) {
        const uri = await this.prepareDocument(filePath);
        const result = await this.request('textDocument/codeAction', {
            textDocument: { uri },
            range,
            context: { diagnostics }
        });
        return this.translateIncomingPayload(result);
    }
    getServerWorkspaceRoot() {
        return this.devContainerContext?.containerWorkspaceRoot ?? this.workspaceRoot;
    }
    getWorkspaceRootUri() {
        return this.toServerUri(pathToFileURL(this.workspaceRoot).href);
    }
    toServerUri(uri) {
        return hostUriToContainerUri(uri, this.devContainerContext);
    }
    toHostUri(uri) {
        return containerUriToHostUri(uri, this.devContainerContext);
    }
    translateIncomingPayload(value) {
        if (!this.devContainerContext || value == null) {
            return value;
        }
        return this.translateIncomingValue(value);
    }
    translateIncomingValue(value) {
        if (Array.isArray(value)) {
            return value.map(item => this.translateIncomingValue(item));
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        const record = value;
        const translatedEntries = Object.entries(record).map(([key, entryValue]) => {
            if ((key === 'uri' || key === 'targetUri' || key === 'newUri' || key === 'oldUri') && typeof entryValue === 'string') {
                return [key, this.toHostUri(entryValue)];
            }
            if (key === 'changes' && entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
                const translatedChanges = Object.fromEntries(Object.entries(entryValue).map(([uri, changeValue]) => [
                    this.toHostUri(uri),
                    this.translateIncomingValue(changeValue)
                ]));
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
    clients = new Map();
    pendingClients = new Map();
    clientGeneration = 0;
    disconnecting = null;
    lastUsed = new Map();
    inFlightCount = new Map();
    idleDeadlines = new Map();
    idleTimer = null;
    constructor() {
        this.startIdleCheck();
        this.registerCleanupHandlers();
    }
    /**
     * Register process exit/signal handlers to kill all spawned LSP server processes.
     * Prevents orphaned language server processes (e.g. kotlin-language-server)
     * when the MCP bridge process exits or a claude session ends.
     */
    registerCleanupHandlers() {
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
                }
                catch {
                    // Ignore errors during cleanup
                }
            }
            for (const { client } of this.pendingClients.values()) {
                try {
                    client.forceKill();
                }
                catch {
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
        for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
            process.on(sig, forceKillAll);
        }
    }
    /**
     * Get or create a client for a file
     */
    async getClientForFile(filePath) {
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
    async runWithClientLease(filePath, fn) {
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
        }
        finally {
            // A replaced or detached client must not mutate the replacement's lease count.
            if (this.clients.get(key) === client) {
                const count = (this.inFlightCount.get(key) || 1) - 1;
                if (count <= 0) {
                    this.inFlightCount.delete(key);
                }
                else {
                    this.inFlightCount.set(key, count);
                }
                this.touchClient(key);
            }
        }
    }
    async getOrCreateClient(key, workspaceRoot, serverConfig, devContainerContext) {
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
    async acquireClient(key, workspaceRoot, serverConfig, devContainerContext) {
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
    async acquireClientLease(key, workspaceRoot, serverConfig, devContainerContext) {
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
    touchClient(key) {
        this.lastUsed.set(key, Date.now());
        this.scheduleIdleDeadline(key);
    }
    scheduleIdleDeadline(key) {
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
    clearIdleDeadline(key) {
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
    findWorkspaceRoot(filePath) {
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
    startIdleCheck() {
        if (this.idleTimer)
            return;
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
    evictIdleClients() {
        for (const key of this.lastUsed.keys()) {
            this.evictClientIfIdle(key);
        }
    }
    evictClientIfIdle(key) {
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
    async disconnectAll() {
        if (this.disconnecting) {
            return this.disconnecting;
        }
        const teardown = Promise.resolve().then(() => this.performDisconnectAll());
        this.disconnecting = teardown;
        try {
            await teardown;
        }
        finally {
            if (this.disconnecting === teardown) {
                this.disconnecting = null;
            }
        }
    }
    async performDisconnectAll() {
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
            }
            catch {
                // Ignore errors while stopping clients that are still connecting
            }
        }
        this.pendingClients.clear();
        const entries = Array.from(this.clients.entries());
        this.clients.clear();
        this.lastUsed.clear();
        this.inFlightCount.clear();
        const results = await Promise.allSettled(entries.map(([, client]) => client.disconnect()));
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
    getInFlightCount(key) {
        return this.inFlightCount.get(key) || 0;
    }
    /** Expose client count for testing */
    get clientCount() {
        return this.clients.size;
    }
    /** Trigger idle eviction manually (exposed for testing) */
    triggerEviction() {
        this.evictIdleClients();
    }
}
const LSP_CLIENT_MANAGER_KEY = '__omcLspClientManager';
// Export a process-global singleton instance. This protects against duplicate
// manager instances if the module is loaded more than once in the same process
// (for example after module resets in tests or bundle indirection).
const globalWithLspClientManager = globalThis;
export const lspClientManager = globalWithLspClientManager[LSP_CLIENT_MANAGER_KEY]
    ?? (globalWithLspClientManager[LSP_CLIENT_MANAGER_KEY] = new LspClientManager());
/**
 * Disconnect all LSP clients and free resources.
 * Exported for use in session-end hooks.
 */
export async function disconnectAll() {
    return lspClientManager.disconnectAll();
}
//# sourceMappingURL=client.js.map