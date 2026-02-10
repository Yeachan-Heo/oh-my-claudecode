/**
 * Custom error types for socket communication
 */
export declare class SocketConnectionError extends Error {
    readonly socketPath: string;
    readonly originalError?: Error | undefined;
    constructor(message: string, socketPath: string, originalError?: Error | undefined);
}
export declare class SocketTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(message: string, timeoutMs: number);
}
export declare class JsonRpcError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(message: string, code: number, data?: unknown | undefined);
}
/**
 * Send a JSON-RPC 2.0 request over Unix socket
 *
 * @param socketPath - Path to the Unix socket
 * @param method - JSON-RPC method name
 * @param params - Optional parameters object
 * @param timeout - Request timeout in milliseconds (default: 60000ms / 1 min)
 * @returns Promise resolving to the result typed as T
 *
 * @throws {SocketConnectionError} If socket connection fails
 * @throws {SocketTimeoutError} If request times out
 * @throws {JsonRpcError} If server returns an error response
 *
 * @example
 * ```typescript
 * const result = await sendSocketRequest<ExecuteResult>(
 *   '/tmp/omc/abc123/bridge.sock',
 *   'execute',
 *   { code: 'print("hello")' },
 *   60000
 * );
 * ```
 */
export declare function sendSocketRequest<T>(socketPath: string, method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>;
//# sourceMappingURL=socket-client.d.ts.map