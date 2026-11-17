import { describe, it, expect, afterEach } from 'vitest';
import { toForwardSlash, toShellPath, getDataDir, getConfigDir, getStateDir, getGlobalOmcConfigRoot, getGlobalOmcStateRoot, getGlobalOmcConfigPath, getGlobalOmcStatePath, getGlobalOmcConfigCandidates, getGlobalOmcStateCandidates, getLegacyOmcDir, versionLeaf, compareSemverDesc } from '../paths.js';
describe('cross-platform path utilities', () => {
    describe('toForwardSlash', () => {
        it('should convert backslashes to forward slashes', () => {
            expect(toForwardSlash('C:\\Users\\test\\.claude')).toBe('C:/Users/test/.claude');
        });
        it('should leave forward slashes unchanged', () => {
            expect(toForwardSlash('/home/user/.claude')).toBe('/home/user/.claude');
        });
        it('should handle mixed slashes', () => {
            expect(toForwardSlash('C:\\Users/test\\.claude')).toBe('C:/Users/test/.claude');
        });
        it('should handle empty string', () => {
            expect(toForwardSlash('')).toBe('');
        });
        it('should handle UNC paths', () => {
            expect(toForwardSlash('\\\\server\\share\\path')).toBe('//server/share/path');
        });
    });
    describe('toShellPath', () => {
        it('should convert backslashes to forward slashes', () => {
            expect(toShellPath('C:\\Users\\test')).toBe('C:/Users/test');
        });
        it('should quote paths with spaces', () => {
            expect(toShellPath('/path/with spaces/file')).toBe('"/path/with spaces/file"');
        });
        it('should quote Windows paths with spaces', () => {
            expect(toShellPath('C:\\Program Files\\app')).toBe('"C:/Program Files/app"');
        });
        it('should not quote paths without spaces', () => {
            expect(toShellPath('/simple/path')).toBe('/simple/path');
        });
        it('should handle empty string', () => {
            expect(toShellPath('')).toBe('');
        });
    });
    describe('getDataDir', () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };
        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            process.env = { ...originalEnv };
        });
        it('should use LOCALAPPDATA on Windows when set', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local';
            expect(getDataDir()).toBe('C:\\Users\\Test\\AppData\\Local');
        });
        it('should use XDG_DATA_HOME on Unix when set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_DATA_HOME = '/custom/data';
            expect(getDataDir()).toBe('/custom/data');
        });
        it('should fall back to .local/share on Unix when XDG not set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            delete process.env.XDG_DATA_HOME;
            const result = getDataDir();
            expect(result).toContain('.local');
            expect(result).toContain('share');
        });
    });
    describe('getConfigDir', () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };
        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            process.env = { ...originalEnv };
        });
        it('should use APPDATA on Windows when set', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
            expect(getConfigDir()).toBe('C:\\Users\\Test\\AppData\\Roaming');
        });
        it('should use XDG_CONFIG_HOME on Unix when set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_CONFIG_HOME = '/custom/config';
            expect(getConfigDir()).toBe('/custom/config');
        });
        it('should fall back to .config on Unix when XDG not set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            delete process.env.XDG_CONFIG_HOME;
            const result = getConfigDir();
            expect(result).toContain('.config');
        });
    });
    describe('getStateDir', () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };
        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            process.env = { ...originalEnv };
        });
        it('should use LOCALAPPDATA on Windows when set', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local';
            expect(getStateDir()).toBe('C:\\Users\\Test\\AppData\\Local');
        });
        it('should use XDG_STATE_HOME on Unix when set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_STATE_HOME = '/custom/state';
            expect(getStateDir()).toBe('/custom/state');
        });
        it('should fall back to .local/state on Unix when XDG not set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            delete process.env.XDG_STATE_HOME;
            const result = getStateDir();
            expect(result).toContain('.local');
            expect(result).toContain('state');
        });
    });
    describe('global OMC path helpers', () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };
        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            process.env = { ...originalEnv };
        });
        it('should use XDG config root for global OMC config on Linux', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_CONFIG_HOME = '/custom/config';
            delete process.env.OMC_HOME;
            expect(getGlobalOmcConfigRoot()).toBe('/custom/config/omc');
            expect(getGlobalOmcConfigPath('config.json')).toBe('/custom/config/omc/config.json');
        });
        it('should use XDG state root for global OMC state on Linux', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_STATE_HOME = '/custom/state';
            delete process.env.OMC_HOME;
            expect(getGlobalOmcStateRoot()).toBe('/custom/state/omc');
            expect(getGlobalOmcStatePath('daemon.json')).toBe('/custom/state/omc/daemon.json');
        });
        it('should keep OMC_HOME authoritative for config and state roots', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.OMC_HOME = '/override/omc';
            process.env.XDG_CONFIG_HOME = '/custom/config';
            process.env.XDG_STATE_HOME = '/custom/state';
            expect(getGlobalOmcConfigRoot()).toBe('/override/omc');
            expect(getGlobalOmcStateRoot()).toBe('/override/omc/state');
        });
        it('should keep explicit OMC_HOME state candidates backward compatible', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.OMC_HOME = '/override/omc';
            expect(getGlobalOmcStateCandidates('mcp-registry-state.json')).toEqual([
                '/override/omc/state/mcp-registry-state.json',
                '/override/omc/mcp-registry-state.json',
            ]);
        });
        it('should fall back to legacy ~/.omc root on macOS', () => {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            delete process.env.OMC_HOME;
            delete process.env.XDG_CONFIG_HOME;
            delete process.env.XDG_STATE_HOME;
            expect(getGlobalOmcConfigRoot()).toBe(getLegacyOmcDir());
            expect(getGlobalOmcStateRoot()).toBe(`${getLegacyOmcDir()}/state`);
        });
        it('should include legacy fallback candidates for config and state paths', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.XDG_CONFIG_HOME = '/custom/config';
            process.env.XDG_STATE_HOME = '/custom/state';
            delete process.env.OMC_HOME;
            expect(getGlobalOmcConfigCandidates('config.json')).toEqual([
                '/custom/config/omc/config.json',
                `${getLegacyOmcDir()}/config.json`,
            ]);
            expect(getGlobalOmcStateCandidates('reply-session-registry.jsonl')).toEqual([
                '/custom/state/omc/reply-session-registry.jsonl',
                `${getLegacyOmcDir()}/state/reply-session-registry.jsonl`,
            ]);
        });
    });
});
describe('active plugin cache target selection', () => {
    it('extracts the version leaf from either path separator', () => {
        // These paths come from the plugin registration file, so on Windows they are
        // native. Splitting on '/' alone returned the whole string, and the
        // comparator then read the drive and directory names as version components.
        expect(versionLeaf('/home/u/.claude/plugins/cache/omc/ohmy/1.2.3')).toBe('1.2.3');
        expect(versionLeaf('C:\\Users\\u\\.claude\\plugins\\cache\\omc\\ohmy\\1.2.3')).toBe('1.2.3');
        expect(versionLeaf('C:\\Users\\u\\.claude\\plugins\\cache\\omc\\ohmy\\1.2.3\\')).toBe('1.2.3');
    });
    it('selects the newest active version from native Windows paths', () => {
        // The exact expression used at the call site. Before the leaf fix both of
        // these parsed to the same leading components and compared equal, so the
        // stale directory could be relinked to whichever came first.
        const dirs = [
            'C:\\Users\\u\\.claude\\plugins\\cache\\omc\\ohmy\\1.2.3',
            'C:\\Users\\u\\.claude\\plugins\\cache\\omc\\ohmy\\1.2.4',
        ];
        const newestFirst = [...dirs].sort((a, b) => compareSemverDesc(versionLeaf(a), versionLeaf(b)));
        expect(versionLeaf(newestFirst[0])).toBe('1.2.4');
        const reversed = [...dirs].reverse().sort((a, b) => compareSemverDesc(versionLeaf(a), versionLeaf(b)));
        expect(versionLeaf(reversed[0])).toBe('1.2.4');
    });
    it('selects the newest active version from POSIX paths', () => {
        const dirs = [
            '/home/u/.claude/plugins/cache/omc/ohmy/1.2.10',
            '/home/u/.claude/plugins/cache/omc/ohmy/1.2.9',
        ];
        const newestFirst = [...dirs].sort((a, b) => compareSemverDesc(versionLeaf(a), versionLeaf(b)));
        expect(versionLeaf(newestFirst[0])).toBe('1.2.10');
    });
});
//# sourceMappingURL=paths.test.js.map