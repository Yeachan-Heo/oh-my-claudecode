/**
 * Tests for tmux-detector.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzePaneContent, isTmuxAvailable, listTmuxPanes, capturePaneContent, formatBlockedPanesSummary, scanForBlockedPanes, revalidateBlockedPanes, } from '../../features/rate-limit-wait/tmux-detector.js';
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
        it('should detect OMC HUD rate-limit pane without Claude branding', () => {
            const content = `
        ● You've hit your session limit · resets 12pm (Asia/Tokyo)
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(true);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(true);
            expect(result.rateLimitType).toBe('unknown');
            expect(result.confidence).toBeGreaterThanOrEqual(0.6);
        });
        it('should not treat cat output of a full blocked HUD transcript as a live blocked pane', () => {
            const content = `
        $ cat copied-hud.txt
        ● You've hit your session limit · resets 12pm (Asia/Tokyo)
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat labeled saved terminal output of a full blocked HUD transcript as live', () => {
            const content = `
        copied from saved terminal output:
        ● You've hit your session limit · resets 12pm (Asia/Tokyo)
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied footer, border, and mode with API rate-limit text as live', () => {
            const content = `
        copied from saved terminal output:
        Error: rate limit exceeded
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied HUD snippets plus rate-limit text as OMC pane evidence', () => {
            const content = `
        $ cat notes.txt
        copied from another pane:
        [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
        unrelated API response: Error: rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied full HUD block followed by rate-limit output as OMC pane evidence', () => {
            const content = `
        $ cat copied-hud.txt
        [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
        ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
        unrelated API response: Error: rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied full HUD block without shell prompt as OMC pane evidence', () => {
            const content = `
        copied from saved terminal output:
        unrelated API response: Error: rate limit exceeded
        [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
        ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied HUD chrome without shell prompt as OMC pane evidence', () => {
            const content = `
        copied from saved terminal output:
        unrelated API response: Error: rate limit exceeded
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
        [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat copied HUD chrome from cat output as OMC pane evidence', () => {
            const content = `
        $ cat copied-hud.txt
        unrelated API response: Error: rate limit exceeded
        ─────────────────────────────────────────────
        ❯
        ─────────────────────────────────────────────
        [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat search output containing HUD markers as OMC pane evidence', () => {
            const content = `
        $ rg "OMC#|shift\\+tab|rate limit" src
        src/__tests__/rate-limit-wait/tmux-detector.test.ts
        *152cz|          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
        *153lu|          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
        *154aa|          Error: rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat test output containing shift-tab HUD help as OMC pane evidence', () => {
            const content = `
        FAIL src/team/__tests__/tmux-session.test.ts
        AssertionError: expected output to contain "⏵⏵ auto mode on (shift+tab to cycle)"
        stderr | api-client.test.ts > retries after rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
        });
        it('should not flag plain shell output without Claude or OMC evidence', () => {
            const content = `
        $ npm run build
        Build completed successfully.
        $ git status
        On branch dev
        nothing to commit, working tree clean
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(false);
            expect(result.isBlocked).toBe(false);
        });
        it('should not treat model labels alone as Claude or OMC evidence', () => {
            const content = `
        $ echo "Model: Opus 4.8"
        Model: Opus 4.8
        Error: rate limit exceeded
      `;
            const result = analyzePaneContent(content);
            expect(result.hasClaudeCode).toBe(false);
            expect(result.hasRateLimitMessage).toBe(true);
            expect(result.isBlocked).toBe(false);
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
        it('keeps the pane id when the session name contains spaces', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            vi.mocked(tmuxExec).mockReturnValue('my project:2.1 %7 1 dev Claude\n');
            expect(listTmuxPanes()).toEqual([{
                    id: '%7',
                    session: 'my project',
                    windowIndex: 2,
                    windowName: 'dev',
                    paneIndex: 1,
                    title: 'Claude',
                    isActive: true,
                }]);
        });
        it('preserves leading and trailing spaces in a session name', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
            vi.mocked(tmuxExec).mockReturnValue(' my project :2.1 %7 1 dev Claude\n');
            expect(listTmuxPanes()).toEqual([{
                    id: '%7',
                    session: ' my project ',
                    windowIndex: 2,
                    windowName: 'dev',
                    paneIndex: 1,
                    title: 'Claude',
                    isActive: true,
                }]);
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
    describe('revalidateBlockedPanes', () => {
        const trackedPane = {
            id: '%0',
            session: 'main',
            windowIndex: 0,
            windowName: 'dev',
            paneIndex: 0,
            isActive: true,
            analysis: { hasClaudeCode: true, hasRateLimitMessage: true, isBlocked: true, confidence: 1 },
            firstDetectedAt: new Date('2026-01-01T00:00:00.000Z'),
            resumeAttempted: false,
        };
        const paneList = 'main:0.0 %0 1 dev Claude\n';
        const livePrompt = [
            'Claude Code v1.2.3',
            "You've reached your rate limit. Please wait for the limit to reset.",
            '[1] Continue when ready',
            '[2] Exit',
            'Enter to confirm',
        ].join('\n');
        const selectedResumePrompt = [
            'Claude Code v1.2.3',
            "You've reached your rate limit. Please wait for the limit to reset.",
            '❯ 1. Continue when ready',
        ].join('\n');
        const stopAndWaitPrompt = [
            'Claude Code',
            "You've hit your limit · resets Feb 17 at 2pm",
            '❯ 1. Stop and wait',
            'Enter to confirm',
        ].join('\n');
        const weeklyLimitChoicePrompt = [
            'Claude Code v1.0.0',
            'Weekly usage limit reached',
            "You've used your weekly allocation of tokens.",
            'Limit resets on Monday at 12:00 AM UTC.',
            'Options:',
            '[1] Continue when limit resets',
            '[2] Exit',
            'Enter choice:',
        ].join('\n');
        const waitAndContinuePrompt = [
            'Claude Code',
            "You've reached your usage limit for the 5-hour period.",
            'Your limit will reset at 3:45 PM.',
            'What would you like to do?',
            '[1] Wait and continue automatically when limit resets',
            '[2] Switch to a different conversation',
            '[3] Exit',
            '>',
        ].join('\n');
        function makeTmuxAvailable() {
            vi.mocked(tmuxSpawn).mockReturnValue({
                status: 0,
                stdout: '/usr/bin/tmux',
                stderr: '',
                signal: null,
                pid: 1234,
                output: [],
            });
        }
        it('requires a live continuation option near the current pane prompt', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(livePrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('revalidates a live pane after its window is renamed', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('main:0.0 %0 1 renamed Claude\n')
                .mockReturnValueOnce(livePrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'renamed' },
            ]);
        });
        it('recognizes a cursor-selected continuation option', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(selectedResumePrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('recognizes the live stop-and-wait confirmation prompt', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(stopAndWaitPrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('recognizes the supported weekly-limit Enter choice prompt', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(weeklyLimitChoicePrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('recognizes the supported wait-and-continue prompt with a bare selector', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(waitAndContinuePrompt);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('rejects a stale bare selector when a conversation line follows it', () => {
            makeTmuxAvailable();
            const resumedConversation = [
                'Claude Code',
                "You've reached your usage limit for the 5-hour period.",
                'What would you like to do?',
                '[1] Wait and continue automatically when limit resets',
                '>',
                '❯ Please explain the test failure',
                '[OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%',
                '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(resumedConversation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('rejects a new bare selector after a conversation following an old resume menu', () => {
            makeTmuxAvailable();
            const resumedConversation = [
                'Claude Code',
                "You've reached your usage limit for the 5-hour period.",
                'What would you like to do?',
                '[1] Wait and continue automatically when limit resets',
                '>',
                'I can help you run the tests.',
                '>',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(resumedConversation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('rejects confirmation wording when it is part of a conversation line', () => {
            makeTmuxAvailable();
            const resumedConversation = [
                'Claude Code',
                "You've reached your usage limit for the 5-hour period.",
                'What would you like to do?',
                '[1] Wait and continue automatically when limit resets',
                '>',
                'Press Enter to confirm the migration',
                '[OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%',
                '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(resumedConversation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('rejects a stale rate-limit option before an unrelated confirmation menu', () => {
            makeTmuxAvailable();
            const unrelatedConfirmation = [
                'Claude Code v1.2.3',
                "You've reached your rate limit. Please wait for the limit to reset.",
                '[1] Continue when ready',
                'Run this command?',
                '[1] Yes',
                '[2] No',
                'Enter to confirm',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(unrelatedConfirmation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('ignores live OMC HUD footer lines when checking the prompt', () => {
            makeTmuxAvailable();
            const livePromptWithHud = [
                livePrompt,
                '[OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%',
                '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(livePromptWithHud);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('ignores model-only OMC HUD rows when checking the prompt', () => {
            makeTmuxAvailable();
            const livePromptWithModelHud = [
                livePrompt,
                '[OMC#4.15.1L] | Model: Opus 4.8',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(livePromptWithModelHud);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('ignores the OMC HUD marker when model metadata is unavailable', () => {
            makeTmuxAvailable();
            const livePromptWithoutModelHud = [
                livePrompt,
                '[OMC#4.15.1L]',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(livePromptWithoutModelHud);
            expect(revalidateBlockedPanes([trackedPane])).toMatchObject([
                { id: '%0', session: 'main', windowName: 'dev' },
            ]);
        });
        it('rejects old rate-limit text after the pane has resumed into a conversation', () => {
            makeTmuxAvailable();
            const activeConversation = [
                'Claude Code v1.2.3',
                "You've reached your rate limit. Please wait for the limit to reset.",
                '[1] Continue when ready',
                '[2] Exit',
                '1. Run the tests',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(activeConversation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('rejects a cursor-prefixed conversation line after an old menu', () => {
            makeTmuxAvailable();
            const activeConversation = [
                'Claude Code v1.2.3',
                "You've reached your rate limit. Please wait for the limit to reset.",
                '[1] Continue when ready',
                '[2] Exit',
                '❯ 1. Run the tests',
            ].join('\n');
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockReturnValueOnce(activeConversation);
            expect(revalidateBlockedPanes([trackedPane])).toEqual([]);
        });
        it('returns inconclusive when pane listing fails', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec).mockImplementationOnce(() => {
                throw new Error('tmux server unavailable');
            });
            expect(revalidateBlockedPanes([trackedPane])).toBeNull();
        });
        it('returns inconclusive when a tracked pane capture fails', () => {
            makeTmuxAvailable();
            vi.mocked(tmuxExec)
                .mockReturnValueOnce(paneList)
                .mockImplementationOnce(() => {
                throw new Error('pane capture failed');
            });
            expect(revalidateBlockedPanes([trackedPane])).toBeNull();
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
        it('does not report non-Claude panes with copied HUD and rate-limit output', () => {
            vi.mocked(tmuxSpawn).mockReturnValue(tmuxAvailableReturn);
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('main:0.0 %0 1 dev shell\n')
                .mockReturnValueOnce(`
          $ cat copied-hud.txt
          [OMC#4.15.1L] | Model: Opus 4.8 | 5h:100% wk:14% | thinking | session:80m | ctx:14%
          ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
          unrelated API response: Error: rate limit exceeded
        `);
            const blocked = scanForBlockedPanes(15);
            expect(blocked).toHaveLength(0);
        });
    });
});
//# sourceMappingURL=tmux-detector.test.js.map