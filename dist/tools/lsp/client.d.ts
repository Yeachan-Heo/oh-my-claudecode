/**
 * LSP Client Implementation
 *
 * Manages connections to language servers using JSON-RPC 2.0 over stdio.
 * Handles server lifecycle, message buffering, and request/response matching.
 */
import type { LspServerConfig } from './servers.js';
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
    contents: string | {
        kind: string;
        value: string;
    } | Array<string | {
        kind: string;
        value: string;
    }>;
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
    changes?: Record<string, Array<{
        range: Range;
        newText: string;
    }>>;
    documentChanges?: Array<{
        textDocument: TextDocumentIdentifier;
        edits: Array<{
            range: Range;
            newText: string;
        }>;
    }>;
}
export interface CodeAction {
    title: string;
    kind?: string;
    diagnostics?: Diagnostic[];
    isPreferred?: boolean;
    edit?: WorkspaceEdit;
    command?: {
        title: string;
        command: string;
        arguments?: unknown[];
    };
}
/**
 * LSP Client class
 */
export declare class LspClient {
    private process;
    private requestId;
    private pendingRequests;
    private buffer;
    private openDocuments;
    private diagnostics;
    private workspaceRoot;
    private serverConfig;
    private initialized;
    constructor(workspaceRoot: string, serverConfig: LspServerConfig);
    /**
     * Start the LSP server and initialize the connection
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the LSP server
     */
    disconnect(): Promise<void>;
    /**
     * Handle incoming data from the server
     */
    private handleData;
    /**
     * Handle a parsed JSON-RPC message
     */
    private handleMessage;
    /**
     * Handle server notifications
     */
    private handleNotification;
    /**
     * Send a request to the server
     */
    private request;
    /**
     * Send a notification to the server (no response expected)
     */
    private notify;
    /**
     * Initialize the LSP connection
     */
    private initialize;
    /**
     * Open a document for editing
     */
    openDocument(filePath: string): Promise<void>;
    /**
     * Close a document
     */
    closeDocument(filePath: string): void;
    /**
     * Get the language ID for a file
     */
    private getLanguageId;
    /**
     * Convert file path to URI and ensure document is open
     */
    private prepareDocument;
    /**
     * Get hover information at a position
     */
    hover(filePath: string, line: number, character: number): Promise<Hover | null>;
    /**
     * Go to definition
     */
    definition(filePath: string, line: number, character: number): Promise<Location | Location[] | null>;
    /**
     * Find all references
     */
    references(filePath: string, line: number, character: number, includeDeclaration?: boolean): Promise<Location[] | null>;
    /**
     * Get document symbols
     */
    documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null>;
    /**
     * Search workspace symbols
     */
    workspaceSymbols(query: string): Promise<SymbolInformation[] | null>;
    /**
     * Get diagnostics for a file
     */
    getDiagnostics(filePath: string): Diagnostic[];
    /**
     * Prepare rename (check if rename is valid)
     */
    prepareRename(filePath: string, line: number, character: number): Promise<Range | null>;
    /**
     * Rename a symbol
     */
    rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null>;
    /**
     * Get code actions
     */
    codeActions(filePath: string, range: Range, diagnostics?: Diagnostic[]): Promise<CodeAction[] | null>;
}
/** Idle timeout: disconnect LSP clients unused for 5 minutes */
export declare const IDLE_TIMEOUT_MS: number;
/** Check for idle clients every 60 seconds */
export declare const IDLE_CHECK_INTERVAL_MS: number;
/**
 * Client manager - maintains a pool of LSP clients per workspace/server
 * with idle eviction to free resources and in-flight request protection.
 */
declare class LspClientManager {
    private clients;
    private lastUsed;
    private inFlightCount;
    private idleTimer;
    constructor();
    /**
     * Get or create a client for a file
     */
    getClientForFile(filePath: string): Promise<LspClient | null>;
    /**
     * Run a function with in-flight tracking for the client serving filePath.
     * While the function is running, the client is protected from idle eviction.
     * The lastUsed timestamp is refreshed on both entry and exit.
     */
    runWithClientLease<T>(filePath: string, fn: (client: LspClient) => Promise<T>): Promise<T>;
    /**
     * Find the workspace root for a file
     */
    private findWorkspaceRoot;
    /**
     * Start periodic idle check
     */
    private startIdleCheck;
    /**
     * Evict clients that haven't been used within IDLE_TIMEOUT_MS.
     * Clients with in-flight requests are never evicted.
     */
    private evictIdleClients;
    /**
     * Disconnect all clients and stop idle checking.
     * Uses Promise.allSettled so one failing disconnect doesn't block others.
     * Maps are always cleared regardless of individual disconnect failures.
     */
    disconnectAll(): Promise<void>;
    /** Expose in-flight count for testing */
    getInFlightCount(key: string): number;
    /** Expose client count for testing */
    get clientCount(): number;
    /** Trigger idle eviction manually (exposed for testing) */
    triggerEviction(): void;
}
export declare const lspClientManager: LspClientManager;
/**
 * Disconnect all LSP clients and free resources.
 * Exported for use in session-end hooks.
 */
export declare function disconnectAll(): Promise<void>;
export {};
//# sourceMappingURL=client.d.ts.map