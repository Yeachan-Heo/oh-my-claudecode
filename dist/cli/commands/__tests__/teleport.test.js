import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        rmSync: vi.fn(),
        symlinkSync: vi.fn(),
        lstatSync: vi.fn((target) => ({
            isDirectory: () => typeof target === 'string' && !target.endsWith('/.git'),
            isSymbolicLink: () => false,
        })),
    };
});
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execSync: vi.fn(),
        execFileSync: vi.fn(),
    };
});
vi.mock('../../../config/loader.js', () => ({
    loadConfig: vi.fn(),
}));
vi.mock('../../../providers/index.js', () => ({
    parseRemoteUrl: vi.fn(),
    getProvider: vi.fn(),
}));
import { existsSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { loadConfig } from '../../../config/loader.js';
import { teleportCommand, teleportRemoveCommand } from '../teleport.js';
describe('teleportCommand', () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        execFileSync.mockImplementation((command, args) => {
            if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel')
                return '/repo';
            if (command === 'git' && args.join(' ') === 'remote get-url origin')
                return 'git@github.com:owner/repo.git';
            return Buffer.from('');
        });
        existsSync.mockImplementation((target) => {
            if (typeof target !== 'string')
                return false;
            if (target === '/root/issue')
                return true;
            if (target.includes('/issue/repo-'))
                return false;
            if (target === '/repo/package-lock.json')
                return true;
            if (target === '/repo/node_modules')
                return true;
            return false;
        });
        readFileSync.mockImplementation((target) => {
            if (target === '/repo/package.json')
                return '{"name":"repo","version":"1.0.0"}';
            if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
                return '{"name":"repo","version":"1.0.0"}';
            }
            throw new Error(`unexpected readFileSync(${String(target)})`);
        });
        loadConfig.mockReturnValue({
            teleport: { symlinkNodeModules: true },
        });
        const { parseRemoteUrl, getProvider } = await import('../../../providers/index.js');
        parseRemoteUrl.mockReturnValue({
            owner: 'owner',
            repo: 'repo',
            provider: 'github',
        });
        getProvider.mockReturnValue({
            displayName: 'GitHub',
            getRequiredCLI: () => 'gh',
            viewPR: () => null,
            viewIssue: () => ({ title: 'test issue' }),
            prRefspec: null,
        });
    });
    it('passes branchName and baseBranch as discrete array arguments, never as a shell string', async () => {
        await teleportCommand('#1', { base: 'main; touch /tmp/pwned', worktreePath: '/root' });
        expect(execFileSync).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main; touch /tmp/pwned'], { cwd: '/repo', stdio: 'pipe', windowsHide: true });
    });
    it('does not invoke execSync for git fetch/branch/worktree creation commands', async () => {
        await teleportCommand('#2', { base: 'dev', worktreePath: '/root' });
        const execSyncCalls = execSync.mock.calls;
        const gitShellCalls = execSyncCalls.filter((args) => {
            const cmd = args[0];
            return typeof cmd === 'string' &&
                (cmd.includes('git fetch') || cmd.includes('git branch') || cmd.includes('git worktree add'));
        });
        expect(gitShellCalls).toHaveLength(0);
    });
    it('symlinks node_modules when package.json matches and config allows it', async () => {
        await teleportCommand('#1', { worktreePath: '/root' });
        expect(symlinkSync).toHaveBeenCalledWith('/repo/node_modules', '/root/issue/repo-1/node_modules', expect.stringMatching(/dir|junction/));
        const installCalls = execFileSync.mock.calls.filter(([cmd]) => cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn');
        expect(installCalls).toHaveLength(0);
    });
    it('falls back to install with a warning when package.json differs', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        readFileSync.mockImplementation((target) => {
            if (target === '/repo/package.json')
                return '{"name":"repo","version":"1.0.0"}';
            if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
                return '{"name":"repo","version":"2.0.0"}';
            }
            throw new Error(`unexpected readFileSync(${String(target)})`);
        });
        await teleportCommand('#1', { worktreePath: '/root' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('package.json differs'));
        expect(symlinkSync).not.toHaveBeenCalled();
        expect(execFileSync).toHaveBeenCalledWith('npm', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
    });
    it('falls back to pnpm install when symlinking is disabled in config', async () => {
        loadConfig.mockReturnValue({
            teleport: { symlinkNodeModules: false },
        });
        existsSync.mockImplementation((target) => {
            if (typeof target !== 'string')
                return false;
            if (target === '/root/issue')
                return true;
            if (target.includes('/issue/repo-'))
                return false;
            if (target === '/repo/pnpm-lock.yaml')
                return true;
            if (target === '/repo/node_modules')
                return true;
            return false;
        });
        await teleportCommand('#1', { worktreePath: '/root' });
        expect(symlinkSync).not.toHaveBeenCalled();
        expect(execFileSync).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
    });
    it('falls back to yarn install when parent package.json cannot be read', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        existsSync.mockImplementation((target) => {
            if (typeof target !== 'string')
                return false;
            if (target === '/root/issue')
                return true;
            if (target.includes('/issue/repo-'))
                return false;
            if (target === '/repo/yarn.lock')
                return true;
            if (target === '/repo/node_modules')
                return true;
            return false;
        });
        readFileSync.mockImplementation((target) => {
            if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
                return '{"name":"repo","version":"1.0.0"}';
            }
            throw new Error(`unexpected readFileSync(${String(target)})`);
        });
        await teleportCommand('#1', { worktreePath: '/root' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not read package.json'));
        expect(execFileSync).toHaveBeenCalledWith('yarn', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
    });
});
describe('teleportRemoveCommand', () => {
    const worktreeRoot = join(homedir(), 'Workspace', 'omc-worktrees');
    const targetPath = join(worktreeRoot, 'repo-3089');
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => { });
        vi.spyOn(console, 'log').mockImplementation(() => { });
        existsSync.mockImplementation((target) => target === targetPath);
        execFileSync.mockReturnValue(Buffer.from(''));
    });
    it.each(['.git', '/repo/.git', 'C:\\repo\\.git'])('refuses a main repo git-dir shape %s and does not remove the directory', async (gitDir) => {
        execFileSync.mockImplementation((command, args) => {
            if (command === 'git' && args.join(' ') === 'status --porcelain')
                return '';
            if (command === 'git' && args.join(' ') === 'rev-parse --git-dir')
                return `${gitDir}\n`;
            return Buffer.from('');
        });
        const result = await teleportRemoveCommand(targetPath, {});
        expect(result).toBe(1);
        expect(rmSync).not.toHaveBeenCalled();
        expect(execFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['worktree', 'remove']), expect.anything());
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('is not a registered worktree git-dir'));
    });
    it('refuses an unexpected non-worktree git-dir and does not remove the directory', async () => {
        execFileSync.mockImplementation((command, args) => {
            if (command === 'git' && args.join(' ') === 'status --porcelain')
                return '';
            if (command === 'git' && args.join(' ') === 'rev-parse --git-dir')
                return '/tmp/unexpected/gitdir\n';
            return Buffer.from('');
        });
        const result = await teleportRemoveCommand(targetPath, { force: true });
        expect(result).toBe(1);
        expect(rmSync).not.toHaveBeenCalled();
        expect(execFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['worktree', 'remove']), expect.anything());
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('is not a registered worktree git-dir'));
    });
    it('removes a registered worktree through git worktree remove', async () => {
        execFileSync.mockImplementation((command, args) => {
            if (command === 'git' && args.join(' ') === 'status --porcelain')
                return '';
            if (command === 'git' && args.join(' ') === 'rev-parse --git-dir')
                return '/repo/.git/worktrees/repo-3089\n';
            return Buffer.from('');
        });
        const result = await teleportRemoveCommand(targetPath, { force: true });
        expect(result).toBe(0);
        expect(rmSync).not.toHaveBeenCalled();
        expect(execFileSync).toHaveBeenCalledWith('git', ['worktree', 'remove', '--force', targetPath], { cwd: '/repo', stdio: 'pipe', windowsHide: true });
    });
});
//# sourceMappingURL=teleport.test.js.map