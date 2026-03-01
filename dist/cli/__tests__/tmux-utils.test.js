/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - wrapWithLoginShell (issue #1153 — shell RC not loaded in tmux)
 * - quoteShellArg
 * - sanitizeTmuxToken
 * - createHudWatchPane login shell wrapping
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
import { wrapWithLoginShell, quoteShellArg, sanitizeTmuxToken, } from '../tmux-utils.js';
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
// ---------------------------------------------------------------------------
// wrapWithLoginShell
// ---------------------------------------------------------------------------
describe('wrapWithLoginShell', () => {
    it('wraps command with login shell using $SHELL', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell('claude --print');
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('claude --print');
        expect(result).toMatch(/^exec /);
    });
    it('defaults to /bin/bash when $SHELL is not set', () => {
        vi.stubEnv('SHELL', '');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/bin/bash');
        expect(result).toContain('-lc');
    });
    it('properly quotes the inner command containing single quotes', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell("perl -e 'print 1'");
        expect(result).toContain('-lc');
        expect(result).toContain('perl');
        expect(result).toContain('print 1');
    });
    it('uses exec to replace the outer shell process', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        const result = wrapWithLoginShell('my-command');
        expect(result).toMatch(/^exec /);
    });
    it('works with complex multi-statement commands', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const cmd = 'sleep 0.3; echo hello; claude --dangerously-skip-permissions';
        const result = wrapWithLoginShell(cmd);
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('sleep 0.3');
        expect(result).toContain('claude');
    });
    it('handles shells with unusual paths', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/usr/local/bin/fish');
        expect(result).toContain('-lc');
    });
    it('sources ~/.zshrc for zsh shells', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('.zshrc');
        expect(result).toContain('/home/testuser/.zshrc');
    });
    it('sources ~/.bashrc for bash shells', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('.bashrc');
        expect(result).toContain('/home/testuser/.bashrc');
    });
    it('sources ~/.fishrc for fish shells', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('.fishrc');
        expect(result).toContain('/home/testuser/.fishrc');
    });
    it('skips rc sourcing when HOME is not set', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '');
        const result = wrapWithLoginShell('claude');
        expect(result).not.toContain('.zshrc');
        expect(result).toContain('claude');
    });
    it('uses conditional test before sourcing rc file', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('[ -f');
        expect(result).toContain('] && .');
    });
});
// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------
describe('quoteShellArg', () => {
    it('wraps value in single quotes', () => {
        expect(quoteShellArg('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
        const result = quoteShellArg("it's");
        expect(result).toContain("'\"'\"'");
    });
});
// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
    it('lowercases and replaces non-alphanumeric with hyphens', () => {
        expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
        expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
        expect(sanitizeTmuxToken('my project!')).toBe('my-project');
    });
    it('strips leading and trailing hyphens', () => {
        expect(sanitizeTmuxToken('--hello--')).toBe('hello');
    });
    it('returns "unknown" for empty result', () => {
        expect(sanitizeTmuxToken('...')).toBe('unknown');
        expect(sanitizeTmuxToken('!!!')).toBe('unknown');
    });
});
// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
    it('wraps hudCmd with wrapWithLoginShell in source code', () => {
        // Verify the source uses wrapWithLoginShell for the HUD command
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'tmux-utils.ts'), 'utf-8');
        expect(source).toContain('wrapWithLoginShell(hudCmd)');
    });
});
//# sourceMappingURL=tmux-utils.test.js.map