import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));
import { execFileSync } from 'node:child_process';
import { getIdleNotificationRepoState } from '../idle-repo-state.js';
describe('getIdleNotificationRepoState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('builds a stable zero-backlog signature from git and GitHub state', () => {
        const directory = 'C:\\repo folder; & echo owned\\worktree';
        vi.mocked(execFileSync)
            .mockReturnValueOnce('git@github.com:Yeachan-Heo/oh-my-claudecode.git\n')
            .mockReturnValueOnce('abc123\n')
            .mockReturnValueOnce('')
            .mockReturnValueOnce('[]')
            .mockReturnValueOnce('[]')
            .mockReturnValueOnce('[]');
        const result = getIdleNotificationRepoState(directory);
        expect(result).toEqual({
            signature: JSON.stringify({
                repo: 'Yeachan-Heo/oh-my-claudecode',
                headSha: 'abc123',
                dirty: false,
                openPrNumbers: [],
                openIssueNumbers: [],
                failingRunIds: [],
            }),
            backlogZero: true,
        });
        const gitOptions = {
            cwd: directory,
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        };
        expect(execFileSync).toHaveBeenNthCalledWith(1, 'git', ['remote', 'get-url', 'origin'], gitOptions);
        expect(execFileSync).toHaveBeenNthCalledWith(2, 'git', ['rev-parse', 'HEAD'], gitOptions);
        expect(execFileSync).toHaveBeenNthCalledWith(3, 'git', ['status', '--porcelain'], gitOptions);
    });
    it('returns non-zero backlog when PRs, issues, or failing runs exist', () => {
        vi.mocked(execFileSync)
            .mockReturnValueOnce('https://github.com/Yeachan-Heo/oh-my-claudecode.git\n')
            .mockReturnValueOnce('def456\n')
            .mockReturnValueOnce(' M src/file.ts\n')
            .mockReturnValueOnce('[{"number":2472}]')
            .mockReturnValueOnce('[{"number":2473}]')
            .mockReturnValueOnce('[{"databaseId":91,"conclusion":"failure"},{"databaseId":92,"conclusion":"success"}]');
        const result = getIdleNotificationRepoState('/repo');
        expect(result?.backlogZero).toBe(false);
        expect(result?.signature).toBe(JSON.stringify({
            repo: 'Yeachan-Heo/oh-my-claudecode',
            headSha: 'def456',
            dirty: true,
            openPrNumbers: [2472],
            openIssueNumbers: [2473],
            failingRunIds: [91],
        }));
    });
    it('returns null when the repo is not hosted on GitHub', () => {
        vi.mocked(execFileSync).mockReturnValueOnce('git@gitlab.com:group/project.git\n');
        expect(getIdleNotificationRepoState('/repo')).toBeNull();
    });
    it('returns null when GitHub queries fail', () => {
        vi.mocked(execFileSync)
            .mockReturnValueOnce('git@github.com:Yeachan-Heo/oh-my-claudecode.git\n')
            .mockReturnValueOnce('abc123\n')
            .mockReturnValueOnce('')
            .mockImplementationOnce(() => {
            throw new Error('gh unavailable');
        });
        expect(getIdleNotificationRepoState('/repo')).toBeNull();
    });
});
//# sourceMappingURL=idle-repo-state.test.js.map