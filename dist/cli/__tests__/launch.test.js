/**
 * Tests for src/cli/launch.ts
 *
 * Covers:
 * - Exit code propagation (runClaude direct / inside-tmux)
 * - No OMC HUD pane spawning in tmux launch paths
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
vi.mock('../tmux-utils.js', () => ({
    resolveLaunchPolicy: vi.fn(),
    buildTmuxSessionName: vi.fn(() => 'test-session'),
    buildTmuxShellCommand: vi.fn((cmd, args) => `${cmd} ${args.join(' ')}`),
    quoteShellArg: vi.fn((s) => s),
    isClaudeAvailable: vi.fn(() => true),
}));
import { runClaude, extractNotifyFlag, normalizeClaudeLaunchArgs } from '../launch.js';
import { resolveLaunchPolicy, buildTmuxShellCommand, } from '../tmux-utils.js';
// ---------------------------------------------------------------------------
// extractNotifyFlag
// ---------------------------------------------------------------------------
describe('extractNotifyFlag', () => {
    it('returns notifyEnabled=true with no --notify flag', () => {
        const result = extractNotifyFlag(['--madmax']);
        expect(result.notifyEnabled).toBe(true);
        expect(result.remainingArgs).toEqual(['--madmax']);
    });
    it('disables notifications with --notify false', () => {
        const result = extractNotifyFlag(['--notify', 'false']);
        expect(result.notifyEnabled).toBe(false);
        expect(result.remainingArgs).toEqual([]);
    });
    it('disables notifications with --notify=false', () => {
        const result = extractNotifyFlag(['--notify=false']);
        expect(result.notifyEnabled).toBe(false);
    });
    it('disables notifications with --notify 0', () => {
        const result = extractNotifyFlag(['--notify', '0']);
        expect(result.notifyEnabled).toBe(false);
    });
    it('keeps notifications enabled with --notify true', () => {
        const result = extractNotifyFlag(['--notify', 'true']);
        expect(result.notifyEnabled).toBe(true);
    });
    it('strips --notify from remainingArgs', () => {
        const result = extractNotifyFlag(['--madmax', '--notify', 'false', '--print']);
        expect(result.remainingArgs).toEqual(['--madmax', '--print']);
    });
});
// ---------------------------------------------------------------------------
// normalizeClaudeLaunchArgs
// ---------------------------------------------------------------------------
describe('normalizeClaudeLaunchArgs', () => {
    it('maps --madmax to --dangerously-skip-permissions', () => {
        expect(normalizeClaudeLaunchArgs(['--madmax'])).toEqual([
            '--dangerously-skip-permissions',
        ]);
    });
    it('maps --yolo to --dangerously-skip-permissions', () => {
        expect(normalizeClaudeLaunchArgs(['--yolo'])).toEqual([
            '--dangerously-skip-permissions',
        ]);
    });
    it('deduplicates --dangerously-skip-permissions', () => {
        const result = normalizeClaudeLaunchArgs([
            '--madmax',
            '--dangerously-skip-permissions',
        ]);
        expect(result.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
    });
    it('passes unknown flags through unchanged', () => {
        expect(normalizeClaudeLaunchArgs(['--print', '--verbose'])).toEqual([
            '--print',
            '--verbose',
        ]);
    });
});
// ---------------------------------------------------------------------------
// runClaude — exit code propagation
// ---------------------------------------------------------------------------
describe('runClaude — exit code propagation', () => {
    let processExitSpy;
    beforeEach(() => {
        vi.resetAllMocks();
        processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    });
    afterEach(() => {
        processExitSpy.mockRestore();
    });
    describe('direct policy', () => {
        beforeEach(() => {
            resolveLaunchPolicy.mockReturnValue('direct');
        });
        it('propagates Claude non-zero exit code', () => {
            const err = Object.assign(new Error('Command failed'), { status: 2 });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(2);
        });
        it('exits with code 1 when status is null', () => {
            const err = Object.assign(new Error('Command failed'), { status: null });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });
        it('exits with code 1 on ENOENT', () => {
            const err = Object.assign(new Error('Not found'), { code: 'ENOENT' });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });
        it('does not call process.exit on success', () => {
            execFileSync.mockReturnValue(Buffer.from(''));
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).not.toHaveBeenCalled();
        });
    });
    describe('inside-tmux policy', () => {
        beforeEach(() => {
            resolveLaunchPolicy.mockReturnValue('inside-tmux');
            process.env.TMUX_PANE = '%0';
        });
        afterEach(() => {
            delete process.env.TMUX_PANE;
        });
        it('propagates Claude non-zero exit code', () => {
            const err = Object.assign(new Error('Command failed'), { status: 3 });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(3);
        });
        it('exits with code 1 when status is null', () => {
            const err = Object.assign(new Error('Command failed'), { status: null });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });
        it('exits with code 1 on ENOENT', () => {
            const err = Object.assign(new Error('Not found'), { code: 'ENOENT' });
            execFileSync.mockImplementation(() => { throw err; });
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });
        it('does not call process.exit on success', () => {
            execFileSync.mockReturnValue(Buffer.from(''));
            runClaude('/tmp', [], 'sid');
            expect(processExitSpy).not.toHaveBeenCalled();
        });
    });
});
// ---------------------------------------------------------------------------
// runClaude — OMC HUD pane spawning disabled
// ---------------------------------------------------------------------------
describe('runClaude OMC HUD behavior', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        execFileSync.mockReturnValue(Buffer.from(''));
    });
    it('does not build an omc hud --watch command inside tmux', () => {
        resolveLaunchPolicy.mockReturnValue('inside-tmux');
        runClaude('/tmp/cwd', [], 'test-session');
        const calls = vi.mocked(buildTmuxShellCommand).mock.calls;
        const omcHudCall = calls.find(([cmd, args]) => cmd === 'node' && Array.isArray(args) && args.includes('hud'));
        expect(omcHudCall).toBeUndefined();
    });
    it('does not add split-window HUD pane args when launching outside tmux', () => {
        resolveLaunchPolicy.mockReturnValue('outside-tmux');
        runClaude('/tmp/cwd', [], 'test-session');
        const calls = vi.mocked(execFileSync).mock.calls;
        const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
        expect(tmuxCall).toBeDefined();
        const tmuxArgs = tmuxCall[1];
        expect(tmuxArgs).not.toContain('split-window');
    });
});
// ---------------------------------------------------------------------------
// runClaude — outside-tmux mouse scrolling (issue #890 regression guard)
// ---------------------------------------------------------------------------
describe('runClaude outside-tmux — mouse scrolling (issue #890)', () => {
    let processExitSpy;
    beforeEach(() => {
        vi.resetAllMocks();
        processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        resolveLaunchPolicy.mockReturnValue('outside-tmux');
        execFileSync.mockReturnValue(Buffer.from(''));
    });
    afterEach(() => {
        processExitSpy.mockRestore();
    });
    it('uses session-targeted mouse option instead of global (-t sessionName, not -g)', () => {
        runClaude('/tmp', [], 'sid');
        const calls = vi.mocked(execFileSync).mock.calls;
        const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
        expect(tmuxCall).toBeDefined();
        const tmuxArgs = tmuxCall[1];
        // Must use -t <sessionName> targeting, not -g (global)
        const setOptionIdx = tmuxArgs.indexOf('set-option');
        expect(setOptionIdx).toBeGreaterThanOrEqual(0);
        expect(tmuxArgs[setOptionIdx + 1]).toBe('-t');
        expect(tmuxArgs[setOptionIdx + 2]).toBe('test-session');
        expect(tmuxArgs[setOptionIdx + 3]).toBe('mouse');
        expect(tmuxArgs[setOptionIdx + 4]).toBe('on');
        // Must NOT use -g (global)
        expect(tmuxArgs).not.toContain('-g');
    });
    it('sets terminal-overrides to disable alternate screen so scroll works in TUI', () => {
        runClaude('/tmp', [], 'sid');
        const calls = vi.mocked(execFileSync).mock.calls;
        const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
        const tmuxArgs = tmuxCall[1];
        expect(tmuxArgs).toContain('terminal-overrides');
        expect(tmuxArgs).toContain('*:smcup@:rmcup@');
    });
    it('places mouse mode setup before attach-session', () => {
        runClaude('/tmp', [], 'sid');
        const calls = vi.mocked(execFileSync).mock.calls;
        const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
        const tmuxArgs = tmuxCall[1];
        const mouseIdx = tmuxArgs.indexOf('mouse');
        const attachIdx = tmuxArgs.indexOf('attach-session');
        expect(mouseIdx).toBeGreaterThanOrEqual(0);
        expect(attachIdx).toBeGreaterThanOrEqual(0);
        expect(mouseIdx).toBeLessThan(attachIdx);
    });
});
// ---------------------------------------------------------------------------
// runClaude — inside-tmux mouse configuration (issue #890)
// ---------------------------------------------------------------------------
describe('runClaude inside-tmux — mouse configuration (issue #890)', () => {
    let processExitSpy;
    beforeEach(() => {
        vi.resetAllMocks();
        processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        resolveLaunchPolicy.mockReturnValue('inside-tmux');
        execFileSync.mockReturnValue(Buffer.from(''));
    });
    afterEach(() => {
        processExitSpy.mockRestore();
    });
    it('enables mouse mode and terminal-overrides before launching claude', () => {
        runClaude('/tmp', [], 'sid');
        const calls = vi.mocked(execFileSync).mock.calls;
        // First two calls should be tmux set-option for mouse config
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(calls[0][0]).toBe('tmux');
        expect(calls[0][1]).toEqual(['set-option', 'mouse', 'on']);
        expect(calls[1][0]).toBe('tmux');
        expect(calls[1][1]).toEqual(['set-option', 'terminal-overrides', '*:smcup@:rmcup@']);
        // Third call should be claude
        expect(calls[2][0]).toBe('claude');
    });
    it('still launches claude even if tmux mouse config fails', () => {
        let callCount = 0;
        execFileSync.mockImplementation((cmd) => {
            callCount++;
            if (cmd === 'tmux')
                throw new Error('tmux set-option failed');
            return Buffer.from('');
        });
        runClaude('/tmp', [], 'sid');
        // tmux calls fail but claude should still be called
        const calls = vi.mocked(execFileSync).mock.calls;
        const claudeCall = calls.find(([cmd]) => cmd === 'claude');
        expect(claudeCall).toBeDefined();
    });
});
//# sourceMappingURL=launch.test.js.map