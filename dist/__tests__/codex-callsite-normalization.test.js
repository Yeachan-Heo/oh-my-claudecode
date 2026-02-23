import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'fs';

const mockHandleAskCodex = vi.fn(async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }],
    isError: false,
}));

vi.mock('../mcp/codex-core.js', () => ({
    handleAskCodex: mockHandleAskCodex,
    CODEX_DEFAULT_MODEL: 'gpt-5.3-codex',
    CODEX_RECOMMENDED_ROLES: ['architect'],
}));

vi.mock('../mcp/job-management.js', () => ({
    handleWaitForJob: vi.fn(),
    handleCheckJobStatus: vi.fn(),
    handleKillJob: vi.fn(),
    handleListJobs: vi.fn(),
    getJobManagementToolSchemas: vi.fn(() => []),
}));

describe('Codex call-site normalization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('in-process codex-server normalizes background + inline into prompt_file mode', async () => {
        vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
            tool: vi.fn((name, _description, _schema, handler) => ({ name, handler })),
            createSdkMcpServer: vi.fn((config) => config),
        }));

        const mod = await import('../mcp/codex-server.js');
        const askTool = mod.codexMcpServer.tools.find((t) => t.name === 'ask_codex');
        expect(askTool).toBeDefined();

        await askTool.handler({
            agent_role: 'architect',
            prompt: 'ask codex to review this code',
            background: true,
            working_directory: '/tmp',
        });

        expect(mockHandleAskCodex).toHaveBeenCalledTimes(1);
        const normalized = mockHandleAskCodex.mock.calls[0][0];
        expect(normalized.prompt).toBeUndefined();
        expect(normalized.prompt_file).toContain('codex-inline-bg-');
        expect(normalized.output_file).toContain('codex-inline-bg-response-');
        expect(normalized.background).toBe(true);
        expect(existsSync(normalized.prompt_file)).toBe(true);
        expect(readFileSync(normalized.prompt_file, 'utf-8')).toBe('ask codex to review this code');
        unlinkSync(normalized.prompt_file);
    });

    it('standalone codex-server normalizes background + inline into prompt_file mode', async () => {
        let serverInstance;
        const callSchema = Symbol('call-tool');
        const listSchema = Symbol('list-tools');

        vi.doMock('@modelcontextprotocol/sdk/server/index.js', () => ({
            Server: class MockServer {
                constructor() {
                    this.handlers = new Map();
                    serverInstance = this;
                }
                setRequestHandler(schema, handler) {
                    this.handlers.set(schema, handler);
                }
                async connect() {
                    return;
                }
            },
        }));
        vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
            StdioServerTransport: class MockTransport {
            },
        }));
        vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
            CallToolRequestSchema: callSchema,
            ListToolsRequestSchema: listSchema,
        }));

        await import('../mcp/codex-standalone-server.js');
        const handler = serverInstance.handlers.get(callSchema);
        expect(handler).toBeDefined();

        await handler({
            params: {
                name: 'ask_codex',
                arguments: {
                    agent_role: 'architect',
                    prompt: 'delegate to codex in background',
                    background: true,
                    working_directory: '/tmp',
                },
            },
        });

        expect(mockHandleAskCodex).toHaveBeenCalledTimes(1);
        const normalized = mockHandleAskCodex.mock.calls[0][0];
        expect(normalized.prompt).toBeUndefined();
        expect(normalized.prompt_file).toContain('codex-inline-bg-');
        expect(normalized.output_file).toContain('codex-inline-bg-response-');
        expect(normalized.background).toBe(true);
        expect(existsSync(normalized.prompt_file)).toBe(true);
        expect(readFileSync(normalized.prompt_file, 'utf-8')).toBe('delegate to codex in background');
        unlinkSync(normalized.prompt_file);
    });
});

