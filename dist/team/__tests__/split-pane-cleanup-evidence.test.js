import { describe, it, expect, vi } from 'vitest';
vi.mock('../../cli/tmux-utils.js', () => ({
    tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    tmuxSpawn: vi.fn(),
}));
// killTeamSession is in tmux-session which has many deps - test the contract via direct import
import { killTeamSession, resolveSplitPaneWorkerPaneIds } from '../tmux-session.js';
describe('split-pane cleanup evidence (exact-head 70d5 P1)', () => {
    it('resolveSplitPaneWorkerPaneIds only dedupes recorded ids (no invention)', async () => {
        await expect(resolveSplitPaneWorkerPaneIds('sess:0', undefined, '%1')).resolves.toEqual([]);
        await expect(resolveSplitPaneWorkerPaneIds('sess:0', [], '%1')).resolves.toEqual([]);
    });
    it('killTeamSession fails closed for split-pane with empty pane list', async () => {
        await expect(killTeamSession('sess:0', [], '%1', { sessionMode: 'split-pane' })).resolves.toBe(false);
        await expect(killTeamSession('sess:0', undefined, '%1', { sessionMode: 'split-pane' })).resolves.toBe(false);
    });
});
//# sourceMappingURL=split-pane-cleanup-evidence.test.js.map