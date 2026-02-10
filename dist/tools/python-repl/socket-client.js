import * as net from 'net';
import { randomUUID } from 'crypto';
/**
 * Custom error types for socket communication
 */
export class SocketConnectionError extends Error {
    socketPath;
    originalError;
    constructor(message, socketPath, originalError) {
        super(message);
        this.socketPath = socketPath;
        this.originalError = originalError;
        this.name = 'SocketConnectionError';
    }
}
export class SocketTimeoutError extends Error {
    timeoutMs;
    constructor(message, timeoutMs) {
        super(message);
        this.timeoutMs = timeoutMs;
        this.name = 'SocketTimeoutError';
    }
}
export class JsonRpcError extends Error {
    code;
    data;
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'JsonRpcError';
    }
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
export async function sendSocketRequest(socketPath, method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const id = randomUUID();
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params: params ?? {},
        };
        const requestLine = JSON.stringify(request) + '\n';
        let responseBuffer = '';
        let timedOut = false;
        const MAX_RESPONSE_SIZE = 2 * 1024 * 1024; // 2MB
        // Timeout handler
        const timer = setTimeout(() => {
            timedOut = true;
            socket.destroy();
            reject(new SocketTimeoutError(`Request timeout after ${timeout}ms for method "${method}"`, timeout));
        }, timeout);
        // Cleanup helper
        const cleanup = () => {
            clearTimeout(timer);
            socket.removeAllListeners();
            socket.destroy();
        };
        // Create socket connection
        const socket = net.createConnection({ path: socketPath });
        // Connection established - send request
        socket.on('connect', () => {
            socket.write(requestLine);
        });
        // Receive data
        socket.on('data', (chunk) => {
            responseBuffer += chunk.toString();
            // Prevent memory exhaustion from huge responses
            if (responseBuffer.length > MAX_RESPONSE_SIZE) {
                cleanup();
                reject(new Error(`Response exceeded maximum size of ${MAX_RESPONSE_SIZE} bytes`));
                return;
            }
            // Check for complete newline-delimited response
            const newlineIndex = responseBuffer.indexOf('\n');
            if (newlineIndex !== -1) {
                const jsonLine = responseBuffer.slice(0, newlineIndex);
                cleanup();
                try {
                    const response = JSON.parse(jsonLine);
                    // Validate JSON-RPC 2.0 response format
                    if (response.jsonrpc !== '2.0') {
                        reject(new Error(`Invalid JSON-RPC version: expected "2.0", got "${response.jsonrpc}"`));
                        return;
                    }
                    // Validate response ID matches request
                    if (response.id !== id) {
                        reject(new Error(`Response ID mismatch: expected "${id}", got "${response.id}"`));
                        return;
                    }
                    // Handle error response
                    if (response.error) {
                        reject(new JsonRpcError(response.error.message, response.error.code, response.error.data));
                        return;
                    }
                    // Success - return result
                    resolve(response.result);
                }
                catch (e) {
                    reject(new Error(`Failed to parse JSON-RPC response: ${e.message}`));
                }
            }
        });
        // Handle connection errors
        socket.on('error', (err) => {
            if (timedOut) {
                return; // Timeout already handled
            }
            cleanup();
            // Provide specific error messages for common cases
            if (err.code === 'ENOENT') {
                reject(new SocketConnectionError(`Socket does not exist at path: ${socketPath}`, socketPath, err));
            }
            else if (err.code === 'ECONNREFUSED') {
                reject(new SocketConnectionError(`Connection refused - server not listening at: ${socketPath}`, socketPath, err));
            }
            else {
                reject(new SocketConnectionError(`Socket connection error: ${err.message}`, socketPath, err));
            }
        });
        // Handle connection close
        socket.on('close', () => {
            if (timedOut) {
                return; // Timeout already handled
            }
            // If we haven't received a complete response, this is an error
            if (responseBuffer.indexOf('\n') === -1) {
                cleanup();
                reject(new Error(`Socket closed without sending complete response (method: "${method}")`));
            }
        });
    });
}
//# sourceMappingURL=socket-client.js.map