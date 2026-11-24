import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
vi.mock('../servers.js', () => ({
    getServerForFile: vi.fn(),
    commandExists: vi.fn(() => true)
}));
vi.mock('child_process', () => ({
    spawn: vi.fn()
}));
const mockSpawn = vi.mocked(spawn);
function buildLspMessage(body) {
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
describe('LspClient devcontainer support', () => {
    let workspaceRoot;
    let filePath;
    let stdoutHandler;
    let lastDidOpenUri;
    let nextRenameResult;
    beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), 'omc-lsp-client-'));
        mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
        filePath = join(workspaceRoot, 'src', 'index.ts');
        writeFileSync(filePath, 'export const value = 1;\n');
        stdoutHandler = undefined;
        lastDidOpenUri = undefined;
        nextRenameResult = undefined;
        mockSpawn.mockImplementation(() => {
            const proc = {
                stdin: {
                    write: vi.fn((message) => {
                        const body = message.split('\r\n\r\n')[1];
                        const parsed = JSON.parse(body);
                        if (parsed.method === 'initialize') {
                            setTimeout(() => {
                                stdoutHandler?.(Buffer.from(buildLspMessage(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: parsed.id,
                                    result: { capabilities: {} }
                                }))));
                            }, 0);
                        }
                        if (parsed.method === 'textDocument/didOpen') {
                            lastDidOpenUri = parsed.params.textDocument.uri;
                        }
                        if (parsed.method === 'textDocument/definition') {
                            setTimeout(() => {
                                stdoutHandler?.(Buffer.from(buildLspMessage(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: parsed.id,
                                    result: {
                                        uri: 'file:///workspaces/app/src/index.ts',
                                        range: {
                                            start: { line: 0, character: 0 },
                                            end: { line: 0, character: 5 }
                                        }
                                    }
                                }))));
                            }, 0);
                        }
                        if (parsed.method === 'textDocument/rename') {
                            setTimeout(() => {
                                stdoutHandler?.(Buffer.from(buildLspMessage(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: parsed.id,
                                    result: nextRenameResult ?? null
                                }))));
                            }, 0);
                        }
                    })
                },
                stdout: {
                    on: vi.fn((event, cb) => {
                        if (event === 'data') {
                            stdoutHandler = cb;
                        }
                    })
                },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                pid: 12345
            };
            return proc;
        });
    });
    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
    it('spawns the language server with docker exec and uses container URIs for didOpen', async () => {
        const { LspClient } = await import('../client.js');
        const context = {
            containerId: 'container-123',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: '/workspaces/app'
        };
        const client = new LspClient(workspaceRoot, {
            name: 'test-server',
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensions: ['.ts'],
            installHint: 'npm i -g typescript-language-server'
        }, context);
        await client.connect();
        await client.openDocument(filePath);
        expect(mockSpawn).toHaveBeenCalledWith('docker', ['exec', '-i', '-w', '/workspaces/app', 'container-123', 'typescript-language-server', '--stdio'], expect.objectContaining({
            cwd: workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false
        }));
        expect(lastDidOpenUri).toBe('file:///workspaces/app/src/index.ts');
    });
    it('translates incoming diagnostics and locations from container URIs back to host URIs', async () => {
        const { LspClient } = await import('../client.js');
        const context = {
            containerId: 'container-123',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: '/workspaces/app'
        };
        const client = new LspClient(workspaceRoot, {
            name: 'test-server',
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensions: ['.ts'],
            installHint: 'npm i -g typescript-language-server'
        }, context);
        await client.connect();
        client.handleNotification({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
                uri: 'file:///workspaces/app/src/index.ts',
                diagnostics: [{ message: 'boom', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
            }
        });
        const diagnostics = client.getDiagnostics(filePath);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe('boom');
        const definition = await client.definition(filePath, 0, 0);
        expect(definition).toEqual({
            uri: pathToFileURL(filePath).href,
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            }
        });
    });
    it('translates resource operation URIs in workspace edits back to host URIs', async () => {
        const { LspClient } = await import('../client.js');
        const context = {
            containerId: 'container-123',
            hostWorkspaceRoot: workspaceRoot,
            containerWorkspaceRoot: '/workspaces/app'
        };
        const client = new LspClient(workspaceRoot, {
            name: 'test-server',
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensions: ['.ts'],
            installHint: 'npm i -g typescript-language-server'
        }, context);
        await client.connect();
        nextRenameResult = {
            documentChanges: [{
                    kind: 'rename',
                    oldUri: 'file:///workspaces/app/src/index.ts',
                    newUri: 'file:///workspaces/app/src/index-renamed.ts'
                }]
        };
        const edit = await client.rename(filePath, 0, 0, 'renamedValue');
        expect(edit).toEqual({
            documentChanges: [{
                    kind: 'rename',
                    oldUri: pathToFileURL(filePath).href,
                    newUri: pathToFileURL(join(workspaceRoot, 'src', 'index-renamed.ts')).href
                }]
        });
    });
});
//# sourceMappingURL=client-devcontainer.test.js.map