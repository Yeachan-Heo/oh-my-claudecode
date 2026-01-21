import * as net from 'net';
import { randomUUID } from 'crypto';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

/**
 * Custom error types for socket communication
 */
export class SocketConnectionError extends Error {
  constructor(message: string, public readonly socketPath: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'SocketConnectionError';
  }
}

export class SocketTimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'SocketTimeoutError';
  }
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown
  ) {
    super(message);
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
export async function sendSocketRequest<T>(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeout: number = 60000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const request: JsonRpcRequest = {
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
      reject(new SocketTimeoutError(
        `Request timeout after ${timeout}ms for method "${method}"`,
        timeout
      ));
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
    socket.on('data', (chunk: Buffer) => {
      responseBuffer += chunk.toString();

      // Prevent memory exhaustion from huge responses
      if (responseBuffer.length > MAX_RESPONSE_SIZE) {
        cleanup();
        reject(new Error(
          `Response exceeded maximum size of ${MAX_RESPONSE_SIZE} bytes`
        ));
        return;
      }

      // Check for complete newline-delimited response
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const jsonLine = responseBuffer.slice(0, newlineIndex);
        cleanup();

        try {
          const response = JSON.parse(jsonLine) as JsonRpcResponse;

          // Validate JSON-RPC 2.0 response format
          if (response.jsonrpc !== '2.0') {
            reject(new Error(
              `Invalid JSON-RPC version: expected "2.0", got "${response.jsonrpc}"`
            ));
            return;
          }

          // Validate response ID matches request
          if (response.id !== id) {
            reject(new Error(
              `Response ID mismatch: expected "${id}", got "${response.id}"`
            ));
            return;
          }

          // Handle error response
          if (response.error) {
            reject(new JsonRpcError(
              response.error.message,
              response.error.code,
              response.error.data
            ));
            return;
          }

          // Success - return result
          resolve(response.result as T);
        } catch (e) {
          reject(new Error(
            `Failed to parse JSON-RPC response: ${(e as Error).message}`
          ));
        }
      }
    });

    // Handle connection errors
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (timedOut) {
        return; // Timeout already handled
      }

      cleanup();

      // Provide specific error messages for common cases
      if (err.code === 'ENOENT') {
        reject(new SocketConnectionError(
          `Socket does not exist at path: ${socketPath}`,
          socketPath,
          err
        ));
      } else if (err.code === 'ECONNREFUSED') {
        reject(new SocketConnectionError(
          `Connection refused - server not listening at: ${socketPath}`,
          socketPath,
          err
        ));
      } else {
        reject(new SocketConnectionError(
          `Socket connection error: ${err.message}`,
          socketPath,
          err
        ));
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
        reject(new Error(
          `Socket closed without sending complete response (method: "${method}")`
        ));
      }
    });
  });
}
