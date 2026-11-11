/**
 * Tests for git status HUD element
 *
 * Covers:
 * - getGitStatusCounts parsing of `git status --porcelain -b`
 * - renderGitStatus output formatting
 * - Cache behavior
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
import { getGitStatusCounts, renderGitStatus, resetGitCache } from '../elements/git.js';
const mockedExecFileSync = vi.mocked(execFileSync);
beforeEach(() => {
    vi.resetAllMocks();
    resetGitCache();
});
// ---------------------------------------------------------------------------
// getGitStatusCounts
// ---------------------------------------------------------------------------
describe('getGitStatusCounts', () => {
    it('returns zeros for clean repo', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts).toEqual({ staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 });
    });
    it('counts staged files', () => {
        mockedExecFileSync.mockReturnValue('## main\nM  file1.ts\nA  file2.ts\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.staged).toBe(2);
        expect(counts?.modified).toBe(0);
    });
    it('counts modified (unstaged) files', () => {
        mockedExecFileSync.mockReturnValue('## main\n M file1.ts\n D file2.ts\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.staged).toBe(0);
        expect(counts?.modified).toBe(2);
    });
    it('counts untracked files', () => {
        mockedExecFileSync.mockReturnValue('## main\n?? newfile.ts\n?? another.ts\n?? third.ts\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.untracked).toBe(3);
        expect(counts?.staged).toBe(0);
        expect(counts?.modified).toBe(0);
    });
    it('counts both staged and modified for same file', () => {
        // MM means staged + modified
        mockedExecFileSync.mockReturnValue('## main\nMM file.ts\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.staged).toBe(1);
        expect(counts?.modified).toBe(1);
    });
    it('parses ahead count', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main [ahead 3]\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.ahead).toBe(3);
        expect(counts?.behind).toBe(0);
    });
    it('parses behind count', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main [behind 2]\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.ahead).toBe(0);
        expect(counts?.behind).toBe(2);
    });
    it('parses ahead and behind', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main [ahead 5, behind 2]\n');
        const counts = getGitStatusCounts('/tmp');
        expect(counts?.ahead).toBe(5);
        expect(counts?.behind).toBe(2);
    });
    it('handles mixed status', () => {
        mockedExecFileSync.mockReturnValue(('## feat...origin/feat [ahead 1, behind 3]\n' +
            'M  staged.ts\n' +
            ' M modified.ts\n' +
            '?? new.ts\n' +
            'A  added.ts\n' +
            'D  deleted.ts\n' +
            ' D removed.ts\n'));
        const counts = getGitStatusCounts('/tmp');
        expect(counts).toEqual({ staged: 3, modified: 2, untracked: 1, ahead: 1, behind: 3 });
    });
    it('returns null on git error', () => {
        mockedExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
        expect(getGitStatusCounts('/tmp')).toBeNull();
    });
    it('returns cached result on second call', () => {
        mockedExecFileSync.mockReturnValue('## main\n?? file.ts\n');
        getGitStatusCounts('/tmp');
        getGitStatusCounts('/tmp');
        expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });
    it('disables optional git locks for background HUD polling', () => {
        mockedExecFileSync.mockReturnValue('## main\n');
        getGitStatusCounts('/tmp');
        expect(mockedExecFileSync).toHaveBeenCalledWith('git', ['--no-optional-locks', 'status', '--porcelain', '-b'], expect.objectContaining({ cwd: '/tmp', windowsHide: true }));
    });
});
// ---------------------------------------------------------------------------
// renderGitStatus
// ---------------------------------------------------------------------------
describe('renderGitStatus', () => {
    it('returns null for clean repo', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main\n');
        expect(renderGitStatus('/tmp')).toBeNull();
    });
    it('returns null on git error', () => {
        mockedExecFileSync.mockImplementation(() => { throw new Error('fail'); });
        expect(renderGitStatus('/tmp')).toBeNull();
    });
    it('shows staged count with + prefix', () => {
        mockedExecFileSync.mockReturnValue('## main\nA  file.ts\n');
        const result = renderGitStatus('/tmp');
        expect(result).toContain('+');
        expect(result).toContain('1');
    });
    it('shows modified count with ! prefix', () => {
        mockedExecFileSync.mockReturnValue('## main\n M file.ts\n');
        const result = renderGitStatus('/tmp');
        expect(result).toContain('!');
        expect(result).toContain('1');
    });
    it('shows untracked count with ? prefix', () => {
        mockedExecFileSync.mockReturnValue('## main\n?? file.ts\n');
        const result = renderGitStatus('/tmp');
        expect(result).toContain('?');
        expect(result).toContain('1');
    });
    it('shows ahead with ⇡', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main [ahead 2]\n');
        const result = renderGitStatus('/tmp');
        expect(result).toContain('⇡');
        expect(result).toContain('2');
    });
    it('shows behind with ⇣', () => {
        mockedExecFileSync.mockReturnValue('## main...origin/main [behind 4]\n');
        const result = renderGitStatus('/tmp');
        expect(result).toContain('⇣');
        expect(result).toContain('4');
    });
    it('uses configured status labels without changing counts', () => {
        mockedExecFileSync.mockReturnValue(('## main...origin/main [ahead 2, behind 4]\n' +
            'A  staged.ts\n' +
            ' M modified.ts\n' +
            '?? new.ts\n'));
        const result = renderGitStatus('/tmp', {
            staged: '已暂存',
            modified: '已修改',
            untracked: '未跟踪',
            ahead: '领先',
            behind: '落后',
        });
        expect(result).toContain('已暂存');
        expect(result).toContain('已修改');
        expect(result).toContain('未跟踪');
        expect(result).toContain('领先');
        expect(result).toContain('落后');
    });
});
//# sourceMappingURL=git-status.test.js.map