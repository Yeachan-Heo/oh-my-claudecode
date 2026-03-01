import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveShellPath, resolvedEnv, _resetShellPathCache } from '../shell-path.js';
import { spawnSync } from 'child_process';
vi.mock('child_process', () => ({
    spawnSync: vi.fn(),
}));
const mockSpawnSync = vi.mocked(spawnSync);
describe('shell-path', () => {
    beforeEach(() => {
        _resetShellPathCache();
        mockSpawnSync.mockReset();
    });
    describe('resolveShellPath', () => {
        it('parses PATH from env output', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('HOME=/Users/test\nPATH=/usr/local/bin:/usr/bin:/bin\nSHELL=/bin/zsh\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            expect(resolveShellPath()).toBe('/usr/local/bin:/usr/bin:/bin');
        });
        it('ignores dotfile stdout noise (conda init, greetings)', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('Welcome to my shell!\nconda activated\nHOME=/Users/test\nPATH=/opt/conda/bin:/usr/bin\nSHELL=/bin/bash\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            expect(resolveShellPath()).toBe('/opt/conda/bin:/usr/bin');
        });
        it('handles fish shell env output (colon-separated in env)', () => {
            // fish's `env` command outputs PATH= with colons, unlike `echo $PATH` which is space-separated
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('HOME=/Users/test\nPATH=/Users/test/.local/bin:/usr/local/bin:/usr/bin\nSHELL=/usr/bin/fish\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            expect(resolveShellPath()).toBe('/Users/test/.local/bin:/usr/local/bin:/usr/bin');
        });
        it('falls back to process.env.PATH when spawnSync fails', () => {
            mockSpawnSync.mockImplementation(() => { throw new Error('spawn failed'); });
            const original = process.env.PATH;
            process.env.PATH = '/fallback/bin';
            try {
                expect(resolveShellPath()).toBe('/fallback/bin');
            }
            finally {
                process.env.PATH = original;
            }
        });
        it('falls back when spawnSync returns non-zero exit', () => {
            mockSpawnSync.mockReturnValue({
                status: 1,
                stdout: Buffer.from(''),
                stderr: Buffer.from('error'),
                pid: 0, output: [], signal: null,
            });
            const original = process.env.PATH;
            process.env.PATH = '/fallback/bin';
            try {
                expect(resolveShellPath()).toBe('/fallback/bin');
            }
            finally {
                process.env.PATH = original;
            }
        });
        it('falls back when env output has no PATH= line', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('HOME=/Users/test\nSHELL=/bin/zsh\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            const original = process.env.PATH;
            process.env.PATH = '/fallback/bin';
            try {
                expect(resolveShellPath()).toBe('/fallback/bin');
            }
            finally {
                process.env.PATH = original;
            }
        });
        it('invokes login shell with env command', () => {
            const originalShell = process.env.SHELL;
            process.env.SHELL = '/bin/zsh';
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/usr/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            resolveShellPath();
            expect(mockSpawnSync).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'env'], expect.objectContaining({ timeout: 5000 }));
            process.env.SHELL = originalShell;
        });
        it('skips spawn on Windows and uses process.env.PATH', () => {
            const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'win32' });
            const original = process.env.PATH;
            process.env.PATH = '/windows/system32';
            try {
                expect(resolveShellPath()).toBe('/windows/system32');
                expect(mockSpawnSync).not.toHaveBeenCalled();
            }
            finally {
                process.env.PATH = original;
                if (originalPlatform)
                    Object.defineProperty(process, 'platform', originalPlatform);
            }
        });
        it('caches result on second call', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/cached/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            resolveShellPath();
            resolveShellPath();
            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
        });
        it('re-resolves after cache reset', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/first/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            expect(resolveShellPath()).toBe('/first/bin');
            _resetShellPathCache();
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/second/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            expect(resolveShellPath()).toBe('/second/bin');
            expect(mockSpawnSync).toHaveBeenCalledTimes(2);
        });
    });
    describe('resolvedEnv', () => {
        it('merges resolved PATH and extra vars into process.env', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/resolved/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            const env = resolvedEnv({ MY_VAR: 'test' });
            expect(env.PATH).toBe('/resolved/bin');
            expect(env.MY_VAR).toBe('test');
        });
        it('extra vars override PATH if explicitly passed', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/resolved/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            const env = resolvedEnv({ PATH: '/override/bin' });
            expect(env.PATH).toBe('/override/bin');
        });
        it('uses existing PATH key casing from process.env (Windows compat)', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: Buffer.from('PATH=/resolved/bin\n'),
                stderr: Buffer.from(''),
                pid: 0, output: [], signal: null,
            });
            // Simulate Windows-style `Path` key
            const origPath = process.env.PATH;
            const origPathLower = process.env.Path;
            delete process.env.PATH;
            process.env.Path = '/windows/system32';
            try {
                const env = resolvedEnv();
                // Should write to `Path` (existing casing), not create a new `PATH`
                expect(env.Path).toBe('/resolved/bin');
                expect(Object.keys(env).filter(k => k.toUpperCase() === 'PATH')).toHaveLength(1);
            }
            finally {
                delete process.env.Path;
                if (origPath !== undefined)
                    process.env.PATH = origPath;
                if (origPathLower !== undefined)
                    process.env.Path = origPathLower;
            }
        });
    });
});
//# sourceMappingURL=shell-path.test.js.map