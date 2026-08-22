import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
// Mock servers module
vi.mock('../servers.js', () => ({
    commandExists: vi.fn(() => true),
}));
vi.mock('child_process', () => ({
    spawn: vi.fn(() => ({
        stdin: { write: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
    })),
}));
import { LspClient } from '../client.js';
const SERVER_CONFIG = {
    name: 'test-server',
    command: 'test-ls',
    args: ['--stdio'],
    extensions: ['.ts'],
    installHint: 'npm i test-ls',
};
/** Build a well-formed LSP message with correct byte-length header. */
function buildLspMessage(body) {
    const bodyBuf = Buffer.from(body, 'utf-8');
    const header = `Content-Length: ${bodyBuf.length}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header, 'ascii'), bodyBuf]);
}
function jsonRpcResponse(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function decodeLspMessage(message) {
    const bodyStart = message.indexOf('\r\n\r\n') + 4;
    return JSON.parse(message.slice(bodyStart));
}
function setupWritableClient(client) {
    const writes = [];
    client.process = {
        stdin: {
            write: vi.fn((message) => writes.push(message)),
        },
    };
    return writes;
}
function setupPendingRequest(client, id) {
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeout = setTimeout(() => { }, 30000);
    client.pendingRequests.set(id, { resolve, reject, timeout });
    return { resolve, reject };
}
describe('LspClient handleData byte-length fix (#1026)', () => {
    afterEach(() => {
        vi.clearAllTimers();
    });
    it('should parse an ASCII-only JSON-RPC response', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        const body = jsonRpcResponse(1, { hover: 'hello' });
        client.handleData(buildLspMessage(body));
        expect(resolve).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledWith({ hover: 'hello' });
    });
    it('should parse multi-byte UTF-8 content correctly (the #1026 bug)', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        // "🚀" is 4 bytes in UTF-8 but 2 JS chars (surrogate pair).
        // With the old string-length check, the parser would wait for more data
        // because string.length < byte Content-Length.
        const result = { info: '🚀 rocket launch' };
        const body = jsonRpcResponse(1, result);
        // Verify the byte vs char discrepancy that causes the bug
        expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
        client.handleData(buildLspMessage(body));
        expect(resolve).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledWith(result);
    });
    it('should handle CJK characters where byte length differs from char length', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        // Each CJK char is 3 bytes in UTF-8
        const result = { doc: '変数の型情報' };
        const body = jsonRpcResponse(1, result);
        expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
        client.handleData(buildLspMessage(body));
        expect(resolve).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledWith(result);
    });
    it('should handle chunked delivery across multiple data events', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        const body = jsonRpcResponse(1, { value: 'chunked' });
        const full = buildLspMessage(body);
        // Split the message at an arbitrary midpoint
        const mid = Math.floor(full.length / 2);
        client.handleData(full.subarray(0, mid));
        expect(resolve).not.toHaveBeenCalled();
        client.handleData(full.subarray(mid));
        expect(resolve).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledWith({ value: 'chunked' });
    });
    it('should handle chunked delivery splitting a multi-byte char', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        const result = { text: '日本語テスト' };
        const body = jsonRpcResponse(1, result);
        const full = buildLspMessage(body);
        // Split inside the JSON body (likely mid-multibyte sequence)
        const splitAt = full.indexOf(Buffer.from('日')) + 1; // mid-character
        client.handleData(full.subarray(0, splitAt));
        expect(resolve).not.toHaveBeenCalled();
        client.handleData(full.subarray(splitAt));
        expect(resolve).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledWith(result);
    });
    it('should parse multiple messages delivered in a single chunk', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve: resolve1 } = setupPendingRequest(client, 1);
        const { resolve: resolve2 } = setupPendingRequest(client, 2);
        const msg1 = buildLspMessage(jsonRpcResponse(1, 'first'));
        const msg2 = buildLspMessage(jsonRpcResponse(2, 'second'));
        client.handleData(Buffer.concat([msg1, msg2]));
        expect(resolve1).toHaveBeenCalledWith('first');
        expect(resolve2).toHaveBeenCalledWith('second');
    });
    it('should wait when not enough bytes have arrived yet', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        const body = jsonRpcResponse(1, { partial: true });
        const full = buildLspMessage(body);
        // Send only the header plus partial body
        const headerEnd = full.indexOf(Buffer.from('\r\n\r\n')) + 4;
        client.handleData(full.subarray(0, headerEnd + 3));
        expect(resolve).not.toHaveBeenCalled();
        // Send the rest
        client.handleData(full.subarray(headerEnd + 3));
        expect(resolve).toHaveBeenCalledOnce();
    });
    it('should recover from an invalid header (no Content-Length)', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const { resolve } = setupPendingRequest(client, 1);
        // First: a malformed message without Content-Length
        const bad = Buffer.from('X-Bad-Header: oops\r\n\r\n{}');
        // Then: a valid message
        const good = buildLspMessage(jsonRpcResponse(1, 'recovered'));
        client.handleData(Buffer.concat([bad, good]));
        expect(resolve).toHaveBeenCalledWith('recovered');
    });
    it('replies to registration requests with the exact error and preserves string, zero, and empty IDs', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const writes = setupWritableClient(client);
        for (const id of ['ts1', 0, '']) {
            client.handleData(buildLspMessage(JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'client/registerCapability',
            })));
        }
        expect(writes.map(decodeLspMessage)).toEqual([
            {
                jsonrpc: '2.0',
                id: 'ts1',
                error: { code: -32803, message: 'Dynamic capability registration is not supported' },
            },
            {
                jsonrpc: '2.0',
                id: 0,
                error: { code: -32803, message: 'Dynamic capability registration is not supported' },
            },
            {
                jsonrpc: '2.0',
                id: '',
                error: { code: -32803, message: 'Dynamic capability registration is not supported' },
            },
        ]);
    });
    it('replies to unknown server requests with Method not found', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const writes = setupWritableClient(client);
        client.handleData(buildLspMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'window/showMessageRequest',
        })));
        expect(writes).toHaveLength(1);
        expect(decodeLspMessage(writes[0])).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32601, message: 'Method not found' },
        });
    });
    it('does not reply to fractional-ID requests or route them to pending responses', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const writes = setupWritableClient(client);
        const { resolve } = setupPendingRequest(client, 1.5);
        client.handleData(buildLspMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 1.5,
            method: 'client/registerCapability',
        })));
        expect(writes).toHaveLength(0);
        expect(resolve).not.toHaveBeenCalled();
        expect(client.pendingRequests.has(1.5)).toBe(true);
        clearTimeout(client.pendingRequests.get(1.5).timeout);
        client.pendingRequests.delete(1.5);
    });
    it('preserves numeric response resolution and rejection without string-ID coercion', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const resolved = setupPendingRequest(client, 1);
        const rejected = setupPendingRequest(client, 2);
        client.handleData(buildLspMessage(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 'wrong' })));
        client.handleData(buildLspMessage(jsonRpcResponse(1, 'right')));
        client.handleData(buildLspMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32000, message: 'rejected' },
        })));
        expect(resolved.resolve).toHaveBeenCalledWith('right');
        expect(rejected.reject).toHaveBeenCalledWith(new Error('rejected'));
        expect(client.pendingRequests.has(1)).toBe(false);
        expect(client.pendingRequests.has(2)).toBe(false);
    });
    it('does not correlate method-bearing frames as responses', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const pending = setupPendingRequest(client, 3);
        client.handleData(buildLspMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: null,
            result: 'spoofed',
        })));
        expect(pending.resolve).not.toHaveBeenCalled();
        expect(client.pendingRequests.has(3)).toBe(true);
        clearTimeout(client.pendingRequests.get(3).timeout);
        client.pendingRequests.delete(3);
    });
    it('keeps method-only messages as notifications without writing a response', () => {
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        const writes = setupWritableClient(client);
        const uri = 'file:///tmp/ws/test.ts';
        const diagnostics = [{ message: 'problem', severity: 1 }];
        client.handleData(buildLspMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics },
        })));
        expect(writes).toHaveLength(0);
        expect(client.diagnostics.get(uri)).toEqual(diagnostics);
    });
    it('releases a queued public request only after its registration error reply is pumped', async () => {
        const writes = [];
        let stdoutData;
        let pumpRegistrationReply;
        let pumpQueuedWorkspaceResult;
        let registrationReplyObserved = false;
        const stdin = {
            write: vi.fn((message) => {
                writes.push(message);
                const outgoing = decodeLspMessage(message);
                if (outgoing.method === 'initialize') {
                    stdoutData(buildLspMessage(jsonRpcResponse(outgoing.id, { capabilities: {} })));
                }
                else if (outgoing.method === 'initialized') {
                    stdoutData(buildLspMessage(JSON.stringify({
                        jsonrpc: '2.0',
                        id: 'ts1',
                        method: 'client/registerCapability',
                    })));
                }
                else if (outgoing.id === 'ts1' && outgoing.error?.code === -32803) {
                    pumpRegistrationReply = () => {
                        expect(outgoing).toEqual({
                            jsonrpc: '2.0',
                            id: 'ts1',
                            error: { code: -32803, message: 'Dynamic capability registration is not supported' },
                        });
                        registrationReplyObserved = true;
                    };
                }
                else if (outgoing.method === 'workspace/symbol') {
                    pumpQueuedWorkspaceResult = () => {
                        expect(registrationReplyObserved).toBe(true);
                        stdoutData(buildLspMessage(jsonRpcResponse(outgoing.id, [])));
                    };
                }
            }),
        };
        vi.mocked(spawn).mockReturnValueOnce({
            stdin,
            stdout: { on: vi.fn((event, listener) => {
                    if (event === 'data')
                        stdoutData = listener;
                }) },
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
            pid: 12345,
        });
        const client = new LspClient('/tmp/ws', SERVER_CONFIG);
        await client.connect();
        const request = client.workspaceSymbols('queued');
        let resolved = false;
        request.then(() => { resolved = true; });
        expect(writes).toHaveLength(4);
        expect(decodeLspMessage(writes[2])).toEqual({
            jsonrpc: '2.0',
            id: 'ts1',
            error: { code: -32803, message: 'Dynamic capability registration is not supported' },
        });
        expect(decodeLspMessage(writes[3])).toMatchObject({ id: 2, method: 'workspace/symbol' });
        expect(pumpRegistrationReply).toBeDefined();
        expect(pumpQueuedWorkspaceResult).toBeDefined();
        expect(registrationReplyObserved).toBe(false);
        expect(resolved).toBe(false);
        pumpRegistrationReply();
        expect(registrationReplyObserved).toBe(true);
        pumpQueuedWorkspaceResult();
        await expect(request).resolves.toEqual([]);
        expect(resolved).toBe(true);
    });
});
//# sourceMappingURL=client-handle-data.test.js.map