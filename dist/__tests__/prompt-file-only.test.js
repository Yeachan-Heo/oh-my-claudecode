import { describe, it, expect, vi } from 'vitest';
import { handleAskCodex } from '../mcp/codex-core.js';
import { handleAskGemini } from '../mcp/gemini-core.js';
// Mock CLI detection to return available
vi.mock('../mcp/cli-detection.js', () => ({
    detectCodexCli: vi.fn(() => ({ available: true, path: '/usr/bin/codex', version: '1.0.0', installHint: '' })),
    detectGeminiCli: vi.fn(() => ({ available: true, path: '/usr/bin/gemini', version: '1.0.0', installHint: '' })),
    resetDetectionCache: vi.fn(),
}));
// Mock child_process to avoid actual CLI calls
vi.mock('child_process', () => ({
    execSync: vi.fn(),
    spawn: vi.fn(),
}));
describe('prompt_file-only enforcement', () => {
    describe('handleAskCodex', () => {
        it('should return error when deprecated prompt parameter is used', async () => {
            const result = await handleAskCodex({
                prompt_file: '',
                output_file: '/tmp/test-output.md',
                agent_role: 'architect',
                ...{ prompt: 'test prompt' },
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("'prompt' parameter has been removed");
        });
        it('should return error when prompt_file is empty', async () => {
            const result = await handleAskCodex({
                prompt_file: '',
                agent_role: 'architect',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('prompt_file is required');
        });
        it('should return error for invalid agent_role', async () => {
            const result = await handleAskCodex({
                prompt_file: 'some-file.md',
                agent_role: 'invalid_role', // underscore is not allowed (security check)
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid agent_role');
        });
        it('should return error for unknown but syntactically valid agent_role', async () => {
            const result = await handleAskCodex({
                prompt_file: 'some-file.md',
                agent_role: 'totally-fake-agent', // passes regex but not in allowlist
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Unknown agent_role');
        });
    });
    describe('handleAskGemini', () => {
        it('should return error when deprecated prompt parameter is used', async () => {
            const result = await handleAskGemini({
                prompt_file: '',
                output_file: '/tmp/test-output.md',
                agent_role: 'designer',
                ...{ prompt: 'test prompt' },
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("'prompt' parameter has been removed");
        });
        it('should return error when prompt_file is empty', async () => {
            const result = await handleAskGemini({
                prompt_file: '',
                agent_role: 'designer',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('prompt_file is required');
        });
        it('should return error for invalid agent_role', async () => {
            const result = await handleAskGemini({
                prompt_file: 'some-file.md',
                agent_role: 'invalid_role', // underscore is not allowed (security check)
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid agent_role');
        });
        it('should return error for unknown but syntactically valid agent_role', async () => {
            const result = await handleAskGemini({
                prompt_file: 'some-file.md',
                agent_role: 'totally-fake-agent', // passes regex but not in allowlist
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Unknown agent_role');
        });
    });
});
//# sourceMappingURL=prompt-file-only.test.js.map