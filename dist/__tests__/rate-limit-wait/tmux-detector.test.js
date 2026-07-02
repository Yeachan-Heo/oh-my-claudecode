/**
 * Tests for tmux-detector.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzePaneContent, isTmuxAvailable, listTmuxPanes, capturePaneContent, formatBlockedPanesSummary, scanForBlockedPanes, } from '../../features/rate-limit-wait/tmux-detector.js';
// Mock tmux-utils wrappers
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxExec: vi.fn(), tmuxSpawn: vi.fn() };
});
// Mock pane-fresh-capture for scanForBlockedPanes cursor-tracking tests
vi.mock('../../features/rate-limit-wait/pane-fresh-capture.js', () => ({
    getNewPaneTail: vi.fn(),
    getPaneHistorySize: vi.fn(),
}));
import { tmuxExec, tmuxSpawn } from '../../cli/tmux-utils.js';
import { getNewPaneTail } from '../../features/rate-limit-wait/pane-fresh-capture.js';
describe('tmux-detector', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    describe('analyzePaneContent', () => {
        it('should detect rate limit messages with Claude Code context', () => {
            const content = `
        Claude Code v1.2.3
        You've reached your rate limit. Please wait for the limit to reset.
        [1] Continue when ready
        [2] Exit
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(true);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(true);
            expect(result.confidence).toBeGreaterThan(0.5);
        });
        it('should detect 5-hour rate limit', () => {
            const content = `
        Claude Code assistant
        5-hour usage limit reached
        [1] Wait for reset
      `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.rateLimitType).toBe('five_hour');
        });
        it('should detect weekly rate limit', () => {
            const content = `
        Claude Code
        Weekly usage quota exceeded
        Please try again later
      `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.rateLimitType).toBe('weekly');
        });
        it('should not flag content without Claude Code indicators', () => {
            const content = `
        vim test.js
        Hello World
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.isBlocked).toBe(false);
        });
        it('should not flag rate limit messages in non-Claude contexts', () => {
            const content = `
        curl api.example.com
        Error: rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false); // No Claude context
        });
        it('should handle empty content', () => {
            const result = analyzePaneContent('');
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(false);
            expect(result.isBlocked).toBe(false);
            expect(result.confidence).toBe(0);
        });
        it('should detect waiting patterns', () => {
            const content = `
        Claude assistant
        Rate limit reached
        [1] Continue
        [2] Cancel
      `;
            const result = analyzePaneContent(content);
            expect(result.confidence).toBeGreaterThan(0.6);
        });
        it('should detect Claude limit screen phrasing: hit your limit + numeric menu', () => {
            const content = `
        Claude Code
        You've hit your limit · resets Feb 17 at 2pm (Asia/Seoul)
        What do you want to do?

        ❯ 1. Stop and wait for limit to reset
          2. Request more

        Enter to confirm · Esc to cancel
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(true);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(true);
            expect(result.confidence).toBeGreaterThanOrEqual(0.6);
        });
    });
    describe('isTmuxAvailable', () => {
        it('should return true when tmux is installed', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux\n',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            expect(isTmuxAvailable()).toBe(true);
        });
        it('should return false when tmux is not installed', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 1,
                stdout: '',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            expect(isTmuxAvailable()).toBe(false);
        });
        it('should return false when spawnSync throws', () => {
            vi.mocked(tmuxSpawn).mockImplementation(() => {
                throw new Error('Command not found');
            });
            expect(isTmuxAvailable()).toBe(false);
        });
    });
    describe('listTmuxPanes', () => {
        it('should parse tmux pane list correctly', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            vi.mocked(tmuxExec).mockReturnValue('main:0.0 %0 1 dev Claude\nmain:0.1 %1 0 dev Other\n');
            const panes = listTmuxPanes();
            expect(panes).toHaveLength(2);
            expect(panes[0]).toEqual({
                id: '%0',
                session: 'main',
                windowIndex: 0,
                windowName: 'dev',
                paneIndex: 0,
                title: 'Claude',
                isActive: true,
            });
            expect(panes[1]).toEqual({
                id: '%1',
                session: 'main',
                windowIndex: 0,
                windowName: 'dev',
                paneIndex: 1,
                title: 'Other',
                isActive: false,
            });
        });
        it('should return empty array when tmux not available', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 1,
                stdout: '',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            const panes = listTmuxPanes();
            expect(panes).toEqual([]);
        });
    });
    describe('capturePaneContent', () => {
        it('should capture pane content', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            vi.mocked(tmuxExec).mockReturnValue('Line 1\nLine 2\nLine 3\n');
            const content = capturePaneContent('%0', 3);
            expect(content).toBe('Line 1\nLine 2\nLine 3\n');
            expect(tmuxExec).toHaveBeenCalledWith(['capture-pane', '-t', '%0', '-p', '-S', '-3'], expect.any(Object));
        });
        it('should return empty string when tmux not available', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 1,
                stdout: '',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            const content = capturePaneContent('%0');
            expect(content).toBe('');
        });
    });
    describe('security: input validation', () => {
        it('should reject invalid pane IDs in capturePaneContent', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            // Valid pane ID should work
            vi.mocked(tmuxExec).mockReturnValue('content');
            const validResult = capturePaneContent('%0');
            expect(validResult).toBe('content');
            // Invalid pane IDs should return empty string (not execute command)
            const invalidIds = [
                '; rm -rf /',
                '%0; echo hacked',
                '$(whoami)',
                '%0`id`',
                '../etc/passwd',
                '',
                'abc',
            ];
            for (const invalidId of invalidIds) {
                vi.mocked(tmuxExec).mockClear();
                const result = capturePaneContent(invalidId);
                expect(result).toBe('');
            }
        });
        it('should validate lines parameter bounds', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            vi.mocked(tmuxExec).mockReturnValue('content');
            // Should clamp negative to 1
            capturePaneContent('%0', -5);
            expect(tmuxExec).toHaveBeenCalledWith(expect.arrayContaining(['-S', '-1']), expect.any(Object));
            // Should clamp excessive values to 100
            vi.mocked(tmuxExec).mockClear();
            capturePaneContent('%0', 1000);
            expect(tmuxExec).toHaveBeenCalledWith(expect.arrayContaining(['-S', '-100']), expect.any(Object));
        });
    });
    describe('formatBlockedPanesSummary', () => {
        it('should format empty list', () => {
            const result = formatBlockedPanesSummary([]);
            expect(result).toBe('No blocked Claude Code sessions detected.');
        });
        it('should format blocked panes', () => {
            const panes = [
                {
                    id: '%0',
                    session: 'main',
                    windowIndex: 0,
                    windowName: 'dev',
                    paneIndex: 0,
                    isActive: true,
                    analysis: {
                        hasClaudeCode: true,
                        hasRateLimitMessage: true,
                        isBlocked: true,
                        rateLimitType: 'five_hour',
                        confidence: 0.9,
                    },
                    firstDetectedAt: new Date(),
                    resumeAttempted: false,
                },
            ];
            const result = formatBlockedPanesSummary(panes);
            expect(result).toContain('Found 1 blocked');
            expect(result).toContain('%0');
            expect(result).toContain('five_hour');
            expect(result).toContain('90%');
        });
        it('should show resume status', () => {
            const panes = [
                {
                    id: '%0',
                    session: 'main',
                    windowIndex: 0,
                    windowName: 'dev',
                    paneIndex: 0,
                    isActive: true,
                    analysis: {
                        hasClaudeCode: true,
                        hasRateLimitMessage: true,
                        isBlocked: true,
                        confidence: 0.8,
                    },
                    firstDetectedAt: new Date(),
                    resumeAttempted: true,
                    resumeSuccessful: true,
                },
            ];
            const result = formatBlockedPanesSummary(panes);
            expect(result).toContain('[RESUMED]');
        });
    });
    // ── Regression: stale tmux keyword false-positives ────────────────────────
    describe('analyzePaneContent — false-positive suppression', () => {
        it('should NOT flag git log with "weekly" in a commit message as rate-limited', () => {
            // Reproduces: running `git log` in a Claude Code session pane where a
            // commit message contains "weekly" caused a false blocked-pane alert.
            const content = `
        Claude Code v1.0
        $ git log --oneline -3
        commit abc1234def5678901234
        Author: Dev <dev@example.com>
        Date:   Mon Jan 1 10:00:00 2024 +0000

            Fix weekly report generation bug

        commit def5678abc1234567890
        Author: Dev <dev@example.com>
        Date:   Sun Dec 31 09:00:00 2023 +0000

            Update assistant configuration docs

        > `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(false);
            expect(result.isBlocked).toBe(false);
        });
        it('should NOT flag git diff patch containing "weekly" in diff context', () => {
            const content = `
        claude
        $ git diff HEAD~1
        diff --git a/src/reports/weekly.ts b/src/reports/weekly.ts
        --- a/src/reports/weekly.ts
        +++ b/src/reports/weekly.ts
        @@ -1,3 +1,4 @@
        -// weekly report generator
        +// weekly report generator (updated)
        > `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(false);
            expect(result.isBlocked).toBe(false);
        });
        it('should STILL detect genuine "weekly usage limit" rate-limit message', () => {
            // Positive control: genuine Claude Code rate-limit screen must still trigger.
            const content = `
        Claude Code

        ⚠️  Weekly usage limit reached

        You've used your weekly allocation of tokens.
        Limit resets Monday at 12:00 AM UTC.

        [1] Continue when limit resets
        [2] Exit

        Enter choice: `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(true);
            expect(result.rateLimitType).toBe('weekly');
        });
        it('should STILL detect "weekly quota exceeded" phrasing', () => {
            const content = `
        Claude Code
        Weekly usage quota exceeded
        Please try again later
      `;
            const result = analyzePaneContent(content);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.rateLimitType).toBe('weekly');
        });
    });
    // ── Regression: scanForBlockedPanes stale-history via cursor tracking ──────
    describe('scanForBlockedPanes — cursor-tracked stateDir path', () => {
        const tmuxAvailableReturn = {
            status: 0,
            stdout: '/usr/bin/tmux',
            stderr: '',
            signal: null,
            pid: 1234,
            output: [],
        };
        it('skips panes with no new output when stateDir is provided (stale suppression)', () => {
            vi.mocked(tmuxSpawn).mockReturnValue(tmuxAvailableReturn);
            vi.mocked(tmuxExec).mockReturnValue('main:0.0 %0 1 dev Claude\n');
            // getNewPaneTail returns '' → no new lines → pane should be skipped
            vi.mocked(getNewPaneTail).mockReturnValue('');
            const blocked = scanForBlockedPanes(15, '/project/.omc/state');
            expect(blocked).toHaveLength(0);
            // getNewPaneTail must be called with the provided stateDir
            expect(getNewPaneTail).toHaveBeenCalledWith('%0', '/project/.omc/state', 15);
        });
        it('detects a blocked pane from fresh delta lines when stateDir is provided', () => {
            vi.mocked(tmuxSpawn).mockReturnValue(tmuxAvailableReturn);
            vi.mocked(tmuxExec).mockReturnValue('main:0.0 %0 1 dev Claude\n');
            // getNewPaneTail returns new rate-limit content
            vi.mocked(getNewPaneTail).mockReturnValue('Claude Code\nYou\'ve hit your limit · resets Feb 17 at 2pm\n❯ 1. Stop and wait\nEnter to confirm');
            const blocked = scanForBlockedPanes(15, '/project/.omc/state');
            expect(blocked).toHaveLength(1);
            expect(blocked[0].id).toBe('%0');
            expect(blocked[0].analysis.isBlocked).toBe(true);
        });
        it('falls back to capturePaneContent when no stateDir provided', () => {
            vi.mocked(tmuxSpawn).mockReturnValue(tmuxAvailableReturn);
            // listTmuxPanes + capturePaneContent both use tmuxExec
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('main:0.0 %0 1 dev Claude\n') // listTmuxPanes
                .mockReturnValueOnce(''); // capturePaneContent → empty
            const blocked = scanForBlockedPanes(15);
            // capturePaneContent used, getNewPaneTail must NOT be called
            expect(getNewPaneTail).not.toHaveBeenCalled();
            expect(blocked).toHaveLength(0);
        });
    });
});
//# sourceMappingURL=tmux-detector.test.js.map