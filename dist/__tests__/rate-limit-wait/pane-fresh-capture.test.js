/**
 * Regression tests for pane-fresh-capture.ts
 *
 * Verifies delta-only pane tail capture: only lines newly appended since the
 * last scan are returned. Stale scrollback is suppressed to prevent false
 * keyword alerts after blockers are resolved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('fs');
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxExec: vi.fn() };
});
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmuxExec } from '../../cli/tmux-utils.js';
import { getNewPaneTail, getPaneHistorySize } from '../../features/rate-limit-wait/pane-fresh-capture.js';
const STATE_DIR = '/project/.omc/state';
const PANE_ID = '%5';
/** Set up fs mock so state file does not exist. */
function noStateFile() {
    vi.mocked(existsSync).mockReturnValue(false);
}
/** Set up fs mock so state file contains the given pane positions. */
function withStateFile(positions) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(positions));
}
/** Queue tmuxExec to return history_size then (optionally) captured lines. */
function mockHistorySize(size, captureOutput = '') {
    vi.mocked(tmuxExec)
        .mockReturnValueOnce(`${size}\n`) // display-message #{history_size}
        .mockReturnValueOnce(captureOutput); // capture-pane
}
describe('pane-fresh-capture', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mkdirSync).mockReturnValue(undefined);
        vi.mocked(writeFileSync).mockReturnValue(undefined);
    });
    describe('getNewPaneTail — invalid pane ID', () => {
        it('returns empty string immediately without touching tmux', () => {
            const invalidIds = [
                '',
                'abc',
                '%',
                '; rm -rf /',
                '%0; echo hacked',
                '$(whoami)',
                '%0`id`',
                '../etc/passwd',
            ];
            for (const id of invalidIds) {
                const result = getNewPaneTail(id, STATE_DIR, 15);
                expect(result).toBe('');
                expect(tmuxExec).not.toHaveBeenCalled();
                vi.clearAllMocks();
            }
        });
    });
    describe('getNewPaneTail — terminated / unavailable pane', () => {
        it('returns empty string when history_size query throws', () => {
            vi.mocked(tmuxExec).mockImplementation(() => {
                throw new Error('no server running');
            });
            noStateFile();
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe('');
        });
        it('returns empty string when history_size is non-numeric', () => {
            vi.mocked(tmuxExec).mockReturnValue('');
            noStateFile();
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe('');
        });
        it('does not replay stale content from a terminated pane', () => {
            // Pane existed before (has stored position), but is now gone.
            withStateFile({ [PANE_ID]: 100 });
            vi.mocked(tmuxExec).mockImplementation(() => {
                throw new Error('pane %5 not found');
            });
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe('');
            // capture-pane must not be called when pane is gone
            expect(tmuxExec).toHaveBeenCalledTimes(1);
        });
    });
    describe('getNewPaneTail — first scan (no prior state)', () => {
        it('returns a bounded tail for initial context', () => {
            const tail = 'line A\nline B\nline C\n';
            noStateFile();
            mockHistorySize(100, tail);
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe(tail);
        });
        it('passes correct -S offset to capture-pane on first scan', () => {
            noStateFile();
            mockHistorySize(200, 'output\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 10);
            const captureCall = vi.mocked(tmuxExec).mock.calls[1];
            expect(captureCall[0]).toContain('-S');
            expect(captureCall[0]).toContain('-10');
        });
        it('persists the current history_size after first scan', () => {
            noStateFile();
            mockHistorySize(42, 'tail\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(writeFileSync).toHaveBeenCalled();
            const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1]);
            expect(written[PANE_ID]).toBe(42);
        });
    });
    describe('getNewPaneTail — subsequent scans (stale pane)', () => {
        it('returns empty string when no new lines since last scan', () => {
            withStateFile({ [PANE_ID]: 100 });
            // history_size unchanged — same value as stored
            vi.mocked(tmuxExec).mockReturnValueOnce('100\n');
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe('');
        });
        it('does not call capture-pane when no new lines', () => {
            withStateFile({ [PANE_ID]: 100 });
            vi.mocked(tmuxExec).mockReturnValueOnce('100\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            // Only the display-message call, no capture-pane
            expect(tmuxExec).toHaveBeenCalledTimes(1);
        });
        it('still updates the stored position even when stale', () => {
            withStateFile({ [PANE_ID]: 100 });
            vi.mocked(tmuxExec).mockReturnValueOnce('100\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(writeFileSync).toHaveBeenCalled();
        });
    });
    describe('getNewPaneTail — subsequent scans (fresh output)', () => {
        it('returns only new lines since last scan', () => {
            const newContent = 'error: TS5055 found\n2 failed\n';
            withStateFile({ [PANE_ID]: 100 });
            mockHistorySize(102, newContent);
            const result = getNewPaneTail(PANE_ID, STATE_DIR, 15);
            expect(result).toBe(newContent);
        });
        it('caps returned lines at maxLines even when delta is larger', () => {
            withStateFile({ [PANE_ID]: 0 });
            // 200 new lines written since last scan
            mockHistorySize(200, 'capped output\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            const captureCall = vi.mocked(tmuxExec).mock.calls[1];
            // Should request at most 15 lines, not 200
            expect(captureCall[0]).toContain('-15');
            expect(captureCall[0]).not.toContain('-200');
        });
        it('updates stored position to current history_size', () => {
            withStateFile({ [PANE_ID]: 50 });
            mockHistorySize(65, 'new lines\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1]);
            expect(written[PANE_ID]).toBe(65);
        });
        it('preserves positions for other panes in state', () => {
            withStateFile({ [PANE_ID]: 10, '%9': 77 });
            mockHistorySize(25, 'delta\n');
            getNewPaneTail(PANE_ID, STATE_DIR, 15);
            const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1]);
            expect(written['%9']).toBe(77);
            expect(written[PANE_ID]).toBe(25);
        });
    });
    describe('getPaneHistorySize', () => {
        it('returns numeric history size on success', () => {
            vi.mocked(tmuxExec).mockReturnValue('  137  \n');
            const result = getPaneHistorySize('%3');
            expect(result).toBe(137);
            expect(tmuxExec).toHaveBeenCalledWith(['display-message', '-t', '%3', '-p', '#{pane_dead} #{history_size}'], expect.objectContaining({ timeout: 3000 }));
        });
        it('returns null when tmuxExec throws', () => {
            vi.mocked(tmuxExec).mockImplementation(() => {
                throw new Error('no tmux');
            });
            expect(getPaneHistorySize('%3')).toBeNull();
        });
        it('returns null when tmux reports the pane as dead', () => {
            vi.mocked(tmuxExec).mockReturnValue('1 137\n');
            expect(getPaneHistorySize('%3')).toBeNull();
        });
        it('parses history size when tmux reports a live pane', () => {
            vi.mocked(tmuxExec).mockReturnValue('0 137\n');
            expect(getPaneHistorySize('%3')).toBe(137);
        });
        it('returns null for non-numeric output', () => {
            vi.mocked(tmuxExec).mockReturnValue('not-a-number');
            expect(getPaneHistorySize('%3')).toBeNull();
        });
        it('returns null for negative output', () => {
            vi.mocked(tmuxExec).mockReturnValue('-1');
            expect(getPaneHistorySize('%3')).toBeNull();
        });
    });
});
//# sourceMappingURL=pane-fresh-capture.test.js.map