import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('child_process', () => ({
    execSync: vi.fn(),
    execFileSync: vi.fn(),
}));
vi.mock('../installer/index.js', async () => {
    const actual = await vi.importActual('../installer/index.js');
    return {
        ...actual,
        install: vi.fn(),
        HOOKS_DIR: '/tmp/omc-test-hooks',
        isProjectScopedPlugin: vi.fn(),
        checkNodeVersion: vi.fn(),
    };
});
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        cpSync: vi.fn(),
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});
import { execSync, execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { install, isProjectScopedPlugin, checkNodeVersion } from '../installer/index.js';
import * as hooksModule from '../installer/hooks.js';
import { reconcileUpdateRuntime, performUpdate, shouldBlockStandaloneUpdateInCurrentSession, syncPluginCache, } from '../features/auto-update.js';
const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedCpSync = vi.mocked(cpSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedInstall = vi.mocked(install);
const mockedIsProjectScopedPlugin = vi.mocked(isProjectScopedPlugin);
const mockedCheckNodeVersion = vi.mocked(checkNodeVersion);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
function mockPlatform(platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}
describe('auto-update reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedCpSync.mockImplementation(() => undefined);
        mockedExistsSync.mockReturnValue(true);
        mockedIsProjectScopedPlugin.mockReturnValue(false);
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path).includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            return '';
        });
        mockedCheckNodeVersion.mockReturnValue({
            valid: true,
            current: 20,
            required: 20,
        });
        mockedInstall.mockReturnValue({
            success: true,
            message: 'ok',
            installedAgents: [],
            installedCommands: [],
            installedSkills: [],
            hooksConfigured: true,
            hookConflicts: [],
            errors: [],
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.OMC_UPDATE_RECONCILE;
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });
    it('reconciles runtime state and refreshes hooks after update', () => {
        mockedExistsSync.mockReturnValue(false);
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/omc-test-hooks', { recursive: true });
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipClaudeCheck: true,
            forceHooks: true,
            refreshHooksInPlugin: true,
        });
    });
    it('skips hooks directory prep in project-scoped plugin reconciliation', () => {
        mockedIsProjectScopedPlugin.mockReturnValue(true);
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedMkdirSync).not.toHaveBeenCalled();
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipClaudeCheck: true,
            forceHooks: true,
            refreshHooksInPlugin: false,
        });
    });
    it('is idempotent when reconciliation runs repeatedly', () => {
        const first = reconcileUpdateRuntime({ verbose: false });
        const second = reconcileUpdateRuntime({ verbose: false });
        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        expect(mockedInstall).toHaveBeenNthCalledWith(1, {
            force: true,
            verbose: false,
            skipClaudeCheck: true,
            forceHooks: true,
            refreshHooksInPlugin: true,
        });
        expect(mockedInstall).toHaveBeenNthCalledWith(2, {
            force: true,
            verbose: false,
            skipClaudeCheck: true,
            forceHooks: true,
            refreshHooksInPlugin: true,
        });
    });
    it('syncs active plugin cache roots and logs when copy occurs', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const activeRoot = '/tmp/.claude/plugins/cache/omc/oh-my-claudecode/4.1.5';
        mockedReadFileSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return JSON.stringify({
                    plugins: {
                        'oh-my-claudecode': [{ installPath: activeRoot }],
                    },
                });
            }
            return '';
        });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return true;
            }
            if (normalized === activeRoot) {
                return true;
            }
            if (normalized.includes('/node_modules/')) {
                return false;
            }
            return true;
        });
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedCpSync).toHaveBeenCalledWith(expect.stringContaining('/dist'), `${activeRoot}/dist`, expect.objectContaining({ recursive: true, force: true }));
        expect(mockedCpSync).toHaveBeenCalledWith(expect.stringContaining('/package.json'), `${activeRoot}/package.json`, expect.objectContaining({ recursive: true, force: true }));
        expect(mockedCpSync).not.toHaveBeenCalledWith(expect.stringContaining('/node_modules'), expect.anything(), expect.anything());
        expect(consoleLogSpy).toHaveBeenCalledWith('[omc update] Synced plugin cache');
    });
    it('skips plugin cache sync silently when no active plugin roots exist', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return false;
            }
            return true;
        });
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedCpSync).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalledWith('[omc update] Synced plugin cache');
    });
    it('syncs the plugin cache directory when cache root exists', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const versionedCacheRoot = `${cacheRoot}/4.9.0`;
        mockedExecSync.mockImplementation((command) => {
            if (command === 'npm root -g') {
                return '/usr/lib/node_modules\n';
            }
            return '';
        });
        mockedReadFileSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === '/usr/lib/node_modules/oh-my-claude-sisyphus/package.json') {
                return JSON.stringify({ version: '4.9.0' });
            }
            if (normalized.includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            return '';
        });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === cacheRoot) {
                return true;
            }
            if (normalized.startsWith('/usr/lib/node_modules/oh-my-claude-sisyphus/')) {
                return normalized.endsWith('/dist') || normalized.endsWith('/package.json');
            }
            return true;
        });
        const result = syncPluginCache();
        expect(result).toEqual({ synced: true, skipped: false, errors: [] });
        expect(mockedExecSync).toHaveBeenCalledWith('npm root -g', expect.objectContaining({
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 10000,
        }));
        expect(mockedMkdirSync).toHaveBeenCalledWith(versionedCacheRoot, { recursive: true });
        expect(mockedCpSync).toHaveBeenCalledWith('/usr/lib/node_modules/oh-my-claude-sisyphus/dist', `${versionedCacheRoot}/dist`, expect.objectContaining({ recursive: true, force: true }));
        expect(mockedCpSync).toHaveBeenCalledWith('/usr/lib/node_modules/oh-my-claude-sisyphus/package.json', `${versionedCacheRoot}/package.json`, expect.objectContaining({ recursive: true, force: true }));
        expect(consoleLogSpy).toHaveBeenCalledWith('[omc update] Plugin cache synced');
    });
    it('skips plugin cache sync gracefully when cache dir does not exist', () => {
        const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === cacheRoot) {
                return false;
            }
            return true;
        });
        const result = syncPluginCache();
        expect(result).toEqual({ synced: false, skipped: true, errors: [] });
        expect(mockedExecSync).not.toHaveBeenCalledWith('npm root -g', expect.anything());
        expect(mockedCpSync).not.toHaveBeenCalled();
    });
    it('handles plugin cache sync errors non-fatally', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const versionedCacheRoot = `${cacheRoot}/4.9.0`;
        mockedExecSync.mockImplementation((command) => {
            if (command === 'npm root -g') {
                return '/usr/lib/node_modules\n';
            }
            return '';
        });
        mockedReadFileSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === '/usr/lib/node_modules/oh-my-claude-sisyphus/package.json') {
                return JSON.stringify({ version: '4.9.0' });
            }
            if (normalized.includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            return '';
        });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === cacheRoot) {
                return true;
            }
            if (normalized.startsWith('/usr/lib/node_modules/oh-my-claude-sisyphus/')) {
                return normalized.endsWith('/dist');
            }
            return true;
        });
        mockedCpSync.mockImplementation(() => {
            throw new Error('copy failed');
        });
        const result = syncPluginCache();
        expect(result.synced).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.errors).toEqual([
            `Failed to sync dist to ${versionedCacheRoot}: copy failed`,
        ]);
        expect(consoleWarnSpy).toHaveBeenCalledWith(`[omc update] Plugin cache sync warning: Failed to sync dist to ${versionedCacheRoot}: copy failed`);
    });
    it('only blocks standalone update inside an active plugin session', () => {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        delete process.env.CLAUDE_CODE_ENTRYPOINT;
        delete process.env.CLAUDE_SESSION_ID;
        delete process.env.CLAUDECODE_SESSION_ID;
        expect(shouldBlockStandaloneUpdateInCurrentSession()).toBe(false);
        process.env.CLAUDE_PLUGIN_ROOT = '/tmp/.claude/plugins/cache/omc/oh-my-claudecode/4.1.5';
        expect(shouldBlockStandaloneUpdateInCurrentSession()).toBe(false);
        process.env.CLAUDE_CODE_ENTRYPOINT = 'hook';
        expect(shouldBlockStandaloneUpdateInCurrentSession()).toBe(true);
        delete process.env.CLAUDE_CODE_ENTRYPOINT;
        process.env.CLAUDE_SESSION_ID = 'session-123';
        expect(shouldBlockStandaloneUpdateInCurrentSession()).toBe(true);
    });
    it('dedupes plugin roots and ignores missing targets during sync', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const activeRoot = '/tmp/.claude/plugins/cache/omc/oh-my-claudecode/4.1.5';
        const staleRoot = '/tmp/.claude/plugins/cache/omc/oh-my-claudecode/4.1.4';
        process.env.CLAUDE_PLUGIN_ROOT = activeRoot;
        mockedReadFileSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return JSON.stringify({
                    plugins: {
                        'oh-my-claudecode': [
                            { installPath: activeRoot },
                            { installPath: staleRoot },
                        ],
                    },
                });
            }
            return '';
        });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return true;
            }
            if (normalized === activeRoot) {
                return true;
            }
            if (normalized === staleRoot) {
                return false;
            }
            return true;
        });
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        const targetCalls = mockedCpSync.mock.calls.filter(([, destination]) => String(destination).startsWith(activeRoot));
        expect(targetCalls.length).toBeGreaterThan(0);
        expect(mockedCpSync.mock.calls.some(([, destination]) => String(destination).startsWith(staleRoot))).toBe(false);
        expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        expect(consoleLogSpy).toHaveBeenCalledWith('[omc update] Synced plugin cache');
    });
    it('allows standalone update when CLAUDE_PLUGIN_ROOT is inherited without an active Claude session', async () => {
        const pluginRoot = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.1.5');
        const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        process.env.OMC_UPDATE_RECONCILE = '1';
        process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
        delete process.env.CLAUDE_CODE_ENTRYPOINT;
        delete process.env.CLAUDE_SESSION_ID;
        delete process.env.CLAUDECODE_SESSION_ID;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockImplementation((command) => {
            if (command === 'npm install -g oh-my-claude-sisyphus@latest') {
                return '';
            }
            if (command === 'npm root -g') {
                return '/usr/lib/node_modules\n';
            }
            return '';
        });
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === pluginRoot.replace(/\\/g, '/')) {
                return true;
            }
            if (normalized === cacheRoot.replace(/\\/g, '/')) {
                return false;
            }
            if (normalized.endsWith('/plugins/installed_plugins.json')) {
                return true;
            }
            return true;
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecSync).toHaveBeenCalledWith('npm install -g oh-my-claude-sisyphus@latest', expect.any(Object));
    });
    it('runs reconciliation as part of performUpdate', async () => {
        // Set env var so performUpdate takes the direct reconciliation path
        // (simulates being in the re-exec'd process after npm install)
        process.env.OMC_UPDATE_RECONCILE = '1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecSync).toHaveBeenCalledWith('npm install -g oh-my-claude-sisyphus@latest', expect.any(Object));
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipClaudeCheck: true,
            forceHooks: true,
            refreshHooksInPlugin: true,
        });
        delete process.env.OMC_UPDATE_RECONCILE;
    });
    it('does not persist metadata when reconciliation fails', async () => {
        // Set env var so performUpdate takes the direct reconciliation path
        process.env.OMC_UPDATE_RECONCILE = '1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedInstall.mockReturnValue({
            success: false,
            message: 'fail',
            installedAgents: [],
            installedCommands: [],
            installedSkills: [],
            hooksConfigured: false,
            hookConflicts: [],
            errors: ['boom'],
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(false);
        expect(result.errors).toEqual(['Reconciliation failed: boom']);
        expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });
    it('skips marketplace auto-sync when the marketplace clone has local modifications', async () => {
        process.env.OMC_UPDATE_RECONCILE = '1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedExecFileSync.mockImplementation((command, args) => {
            if (command !== 'git') {
                return '';
            }
            if (args?.includes('fetch') || args?.includes('checkout')) {
                return '';
            }
            if (args?.includes('rev-parse')) {
                return 'main\n';
            }
            if (args?.includes('status')) {
                return ' M package.json\n?? scratch.txt\n';
            }
            throw new Error(`Unexpected git command: ${String(args?.join(' '))}`);
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecFileSync).toHaveBeenCalledWith('git', ['-C', expect.stringContaining('/plugins/marketplaces/omc'), 'status', '--porcelain', '--untracked-files=normal'], expect.any(Object));
        expect(mockedExecFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['rev-list', '--left-right', '--count', 'HEAD...origin/main']), expect.any(Object));
        expect(mockedExecFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['merge', '--ff-only', 'origin/main']), expect.any(Object));
        delete process.env.OMC_UPDATE_RECONCILE;
    });
    it('skips marketplace auto-sync when the marketplace clone has local commits', async () => {
        process.env.OMC_UPDATE_RECONCILE = '1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedExecFileSync.mockImplementation((command, args) => {
            if (command !== 'git') {
                return '';
            }
            if (args?.includes('fetch') || args?.includes('checkout')) {
                return '';
            }
            if (args?.includes('rev-parse')) {
                return 'main\n';
            }
            if (args?.includes('status')) {
                return '';
            }
            if (args?.includes('rev-list')) {
                return '1 0\n';
            }
            throw new Error(`Unexpected git command: ${String(args?.join(' '))}`);
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecFileSync).toHaveBeenCalledWith('git', ['-C', expect.stringContaining('/plugins/marketplaces/omc'), 'rev-list', '--left-right', '--count', 'HEAD...origin/main'], expect.any(Object));
        expect(mockedExecFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['merge', '--ff-only', 'origin/main']), expect.any(Object));
        delete process.env.OMC_UPDATE_RECONCILE;
    });
    it('fast-forwards a clean marketplace clone when origin/main is ahead', async () => {
        process.env.OMC_UPDATE_RECONCILE = '1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedExecFileSync.mockImplementation((command, args) => {
            if (command !== 'git') {
                return '';
            }
            if (args?.includes('fetch') || args?.includes('checkout') || args?.includes('merge')) {
                return '';
            }
            if (args?.includes('rev-parse')) {
                return 'main\n';
            }
            if (args?.includes('status')) {
                return '';
            }
            if (args?.includes('rev-list')) {
                return '0 3\n';
            }
            throw new Error(`Unexpected git command: ${String(args?.join(' '))}`);
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecFileSync).toHaveBeenCalledWith('git', ['-C', expect.stringContaining('/plugins/marketplaces/omc'), 'merge', '--ff-only', 'origin/main'], expect.any(Object));
        expect(mockedExecFileSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['reset', '--hard', 'origin/main']), expect.any(Object));
        delete process.env.OMC_UPDATE_RECONCILE;
    });
    it('re-execs with omc.cmd on Windows and persists metadata after reconciliation', async () => {
        mockPlatform('win32');
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.endsWith('/plugins/marketplaces/omc')) {
                return false;
            }
            return true;
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.6',
                name: '4.1.6',
                published_at: '2026-02-10T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockImplementation((command) => {
            if (command === 'npm install -g oh-my-claude-sisyphus@latest') {
                return '';
            }
            throw new Error(`Unexpected execSync command: ${command}`);
        });
        mockedExecFileSync.mockImplementation((command) => {
            if (command === 'where.exe') {
                return 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd\r\n';
            }
            if (command === 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd') {
                return '';
            }
            throw new Error(`Unexpected execFileSync command: ${command}`);
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecSync).toHaveBeenCalledWith('npm install -g oh-my-claude-sisyphus@latest', expect.objectContaining({
            windowsHide: true,
        }));
        expect(mockedExecFileSync).toHaveBeenNthCalledWith(1, 'where.exe', ['omc.cmd'], expect.objectContaining({
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000,
            windowsHide: true,
        }));
        expect(mockedExecFileSync).toHaveBeenNthCalledWith(2, 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd', ['update-reconcile'], expect.objectContaining({
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 60000,
            shell: true,
            windowsHide: true,
            env: expect.objectContaining({ OMC_UPDATE_RECONCILE: '1' }),
        }));
        expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.stringContaining('.omc-version.json'), expect.stringContaining('"version": "4.1.6"'));
    });
    it('does not persist metadata when Windows reconcile re-exec fails with ENOENT', async () => {
        mockPlatform('win32');
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized.endsWith('/plugins/marketplaces/omc')) {
                return false;
            }
            return true;
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.6',
                name: '4.1.6',
                published_at: '2026-02-10T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedExecFileSync.mockImplementation((command) => {
            if (command === 'where.exe') {
                return 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd\r\n';
            }
            if (command === 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd') {
                const error = Object.assign(new Error('spawnSync C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd ENOENT'), {
                    code: 'ENOENT',
                });
                throw error;
            }
            throw new Error(`Unexpected execFileSync command: ${command}`);
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(false);
        expect(result.message).toBe('Updated to 4.1.6, but runtime reconciliation failed');
        expect(result.errors).toEqual(['spawnSync C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd ENOENT']);
        expect(mockedExecFileSync).toHaveBeenNthCalledWith(2, 'C:\\Users\\bellman\\AppData\\Roaming\\npm\\omc.cmd', ['update-reconcile'], expect.objectContaining({
            shell: true,
            windowsHide: true,
            env: expect.objectContaining({ OMC_UPDATE_RECONCILE: '1' }),
        }));
        expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });
    it('preserves non-OMC hooks when refreshing plugin hooks during reconciliation', () => {
        const existingSettings = {
            hooks: {
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
                            },
                        ],
                    },
                ],
            },
        };
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        const baseHooks = hooksModule.getHooksSettingsConfig();
        const freshHooks = {
            ...baseHooks,
            hooks: {
                ...baseHooks.hooks,
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/keyword-detector.mjs',
                            },
                        ],
                    },
                ],
            },
        };
        mockedExistsSync.mockImplementation((path) => {
            const normalized = String(path).replace(/\\/g, '/');
            if (normalized === settingsPath) {
                return true;
            }
            if (normalized.endsWith('/.claude/hud')) {
                return false;
            }
            if (normalized.includes('/hooks/')) {
                return false;
            }
            return true;
        });
        mockedIsProjectScopedPlugin.mockReturnValue(false);
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path) === settingsPath) {
                return JSON.stringify(existingSettings);
            }
            if (String(path).includes('/hooks/')) {
                return 'hook-script';
            }
            return '';
        });
        vi.spyOn(hooksModule, 'getHooksSettingsConfig').mockReturnValue(freshHooks);
        const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        process.env.CLAUDE_PLUGIN_ROOT = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.1.5');
        const result = install({
            force: true,
            skipClaudeCheck: true,
            refreshHooksInPlugin: true,
        });
        if (originalPluginRoot !== undefined) {
            process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
        }
        else {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        const settingsWrite = mockedWriteFileSync.mock.calls.find((call) => String(call[0]).includes('settings.json'));
        if (settingsWrite) {
            const writtenSettings = JSON.parse(String(settingsWrite[1]));
            expect(writtenSettings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('node $HOME/.claude/hooks/other-plugin.mjs');
        }
        expect(result.hooksConfigured).toBe(true);
    });
});
//# sourceMappingURL=auto-update.test.js.map