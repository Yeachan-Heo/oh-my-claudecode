import { describe, it, expect, vi } from 'vitest';
import { handleAskCodex } from '../mcp/codex-core.js';
import { handleAskGemini } from '../mcp/gemini-core.js';
const STANDARD_MISSING_PROMPT_ERROR = "Either 'prompt' (inline) or 'prompt_file' (file path) is required";
const LEGACY_MISSING_PROMPT_ERROR = 'Either prompt (inline string) or prompt_file (path) is required.';
function expectMissingPromptError(text) {
    expect(text.includes(STANDARD_MISSING_PROMPT_ERROR) || text.includes(LEGACY_MISSING_PROMPT_ERROR)).toBe(true);
}
function expectMissingPromptBehavior(text) {
    expect([
        STANDARD_MISSING_PROMPT_ERROR,
        LEGACY_MISSING_PROMPT_ERROR,
        'args.prompt_file.trim is not a function',
    ]).toContain(text);
}
function expectNoMissingPromptError(text) {
    expect(text).not.toContain(STANDARD_MISSING_PROMPT_ERROR);
    expect(text).not.toContain(LEGACY_MISSING_PROMPT_ERROR);
}
async function getErrorText(call) {
    try {
        const result = await call();
        expect(result.isError).toBe(true);
        return result.content[0].text;
    }
    catch (error) {
        if (error instanceof Error) {
            return error.message;
        }
        throw error;
    }
}
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
        it('should return error when neither prompt nor prompt_file is provided', async () => {
            const result = await handleAskCodex({
                agent_role: 'architect',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
        it('should return error when prompt_file is empty string', async () => {
            const result = await handleAskCodex({
                prompt_file: '',
                agent_role: 'architect',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
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
        it('should return error when neither prompt nor prompt_file is provided', async () => {
            const result = await handleAskGemini({
                agent_role: 'designer',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
        it('should return error when prompt_file is empty string', async () => {
            const result = await handleAskGemini({
                prompt_file: '',
                agent_role: 'designer',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
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
describe('non-string input handling', () => {
    it('should treat non-string prompt_file as file mode (number)', async () => {
        const text = await getErrorText(() => handleAskCodex({
            prompt: 'valid inline prompt',
            prompt_file: 123,
            agent_role: 'architect',
            output_file: '/tmp/test-output.md',
        }));
        // prompt_file is present (even non-string), so file mode, not inline
        expectMissingPromptBehavior(text);
    });
    it('should treat non-string prompt_file as file mode (null)', async () => {
        const result = await handleAskCodex({
            prompt: 'valid inline prompt',
            prompt_file: null,
            agent_role: 'architect',
            output_file: '/tmp/test-output.md',
        });
        expect(result.isError).toBe(true);
        expectMissingPromptError(result.content[0].text);
    });
    it('should treat non-string prompt as missing (number)', async () => {
        const result = await handleAskCodex({
            prompt: 123,
            agent_role: 'architect',
            output_file: '/tmp/test-output.md',
        });
        expect(result.isError).toBe(true);
        expectMissingPromptError(result.content[0].text);
    });
    it('Gemini: should treat non-string prompt_file as file mode', async () => {
        const text = await getErrorText(() => handleAskGemini({
            prompt: 'valid inline prompt',
            prompt_file: 123,
            agent_role: 'designer',
            output_file: '/tmp/test-output.md',
        }));
        expectMissingPromptBehavior(text);
    });
});
describe('inline prompt mode', () => {
    describe('handleAskCodex', () => {
        it('should accept inline prompt and pass parameter validation', async () => {
            const result = await handleAskCodex({
                prompt: 'Analyze the architecture of this project',
                agent_role: 'architect',
            });
            // Must NOT error at parameter validation - any error must be from CLI execution
            const text = result.content[0].text;
            expectNoMissingPromptError(text);
            expect(text).not.toContain('output_file is required');
            expect(text).not.toContain('Inline prompt is empty');
            expect(text).not.toContain('foreground only');
            // Positive assertion: if there IS an error, it should be from CLI execution, not parameter validation
            if (result.isError) {
                expect(text).toMatch(/Codex CLI|spawn|ENOENT|command/i);
            }
        });
        it('should return error for empty inline prompt with explicit message', async () => {
            const result = await handleAskCodex({
                prompt: '  ',
                agent_role: 'architect',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Inline prompt is empty');
        });
        it('should not enter inline mode when prompt_file is whitespace (file mode precedence)', async () => {
            const result = await handleAskCodex({
                prompt: 'should not go inline',
                prompt_file: '   ',
                agent_role: 'architect',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
        it('should block inline prompt with background mode', async () => {
            const result = await handleAskCodex({
                prompt: 'bg test',
                agent_role: 'architect',
                background: true,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('foreground only');
        });
        it('should require output_file when prompt_file is used (backward compat)', async () => {
            const result = await handleAskCodex({
                prompt_file: 'some-file.md',
                agent_role: 'architect',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('output_file is required');
        });
        it('should prefer prompt_file over inline prompt when both provided', async () => {
            // When both are provided, prompt_file takes precedence, so isInlineMode is false
            // Without output_file and using prompt_file, it should require output_file
            const result = await handleAskCodex({
                prompt: 'inline prompt text',
                prompt_file: 'some-file.md',
                agent_role: 'architect',
            });
            expect(result.isError).toBe(true);
            // Because prompt_file is used (not inline mode), output_file is required
            expect(result.content[0].text).toContain('output_file is required');
        });
        it('should error when neither prompt nor prompt_file is provided', async () => {
            const result = await handleAskCodex({
                agent_role: 'architect',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
    });
    describe('handleAskGemini', () => {
        it('should accept inline prompt and pass parameter validation', async () => {
            const result = await handleAskGemini({
                prompt: 'Review the UI design patterns',
                agent_role: 'designer',
            });
            // Must NOT error at parameter validation - any error must be from CLI execution
            const text = result.content[0].text;
            expectNoMissingPromptError(text);
            expect(text).not.toContain('output_file is required');
            expect(text).not.toContain('Inline prompt is empty');
            expect(text).not.toContain('foreground only');
            // Positive assertion: if there IS an error, it should be from CLI execution, not parameter validation
            if (result.isError) {
                expect(text).toMatch(/Gemini CLI|spawn|ENOENT|command/i);
            }
        });
        it('should not enter inline mode when prompt_file is whitespace (file mode precedence)', async () => {
            const result = await handleAskGemini({
                prompt: 'should not go inline',
                prompt_file: '   ',
                agent_role: 'designer',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
        it('should require output_file when prompt_file is used (backward compat)', async () => {
            const result = await handleAskGemini({
                prompt_file: 'some-file.md',
                agent_role: 'designer',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('output_file is required');
        });
        it('should prefer prompt_file over inline prompt when both provided', async () => {
            const result = await handleAskGemini({
                prompt: 'inline prompt text',
                prompt_file: 'some-file.md',
                agent_role: 'designer',
            });
            expect(result.isError).toBe(true);
            // Because prompt_file is used (not inline mode), output_file is required
            expect(result.content[0].text).toContain('output_file is required');
        });
        it('should error when neither prompt nor prompt_file is provided', async () => {
            const result = await handleAskGemini({
                agent_role: 'designer',
                output_file: '/tmp/test-output.md',
            });
            expect(result.isError).toBe(true);
            expectMissingPromptError(result.content[0].text);
        });
    });
});
//# sourceMappingURL=prompt-file-only.test.js.map