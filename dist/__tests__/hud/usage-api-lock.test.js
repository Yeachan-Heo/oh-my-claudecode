import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
const CLAUDE_CONFIG_DIR = '/tmp/test-claude';
const CACHE_PATH = `${CLAUDE_CONFIG_DIR}/plugins/oh-my-claudecode/.usage-cache.json`;
const LOCK_PATH = `${CACHE_PATH}.lock`;
function createFsMock(initialFiles) {
    const files = new Map(Object.entries(initialFiles));
    const directories = new Set([CLAUDE_CONFIG_DIR]);
    const existsSync = vi.fn((path) => files.has(String(path)) || directories.has(String(path)));
    const readFileSync = vi.fn((path) => {
        const content = files.get(String(path));
        if (content == null)
            throw new Error(`ENOENT: ${path}`);
        return content;
    });
    const writeFileSync = vi.fn((path, content) => {
        files.set(String(path), String(content));
    });
    const mkdirSync = vi.fn((path) => {
        directories.add(String(path));
    });
    const unlinkSync = vi.fn((path) => {
        files.delete(String(path));
    });
    const openSync = vi.fn((path) => {
        const normalized = String(path);
        if (files.has(normalized)) {
            const err = new Error(`EEXIST: ${normalized}`);
            err.code = 'EEXIST';
            throw err;
        }
        files.set(normalized, '');
        return 1;
    });
    const statSync = vi.fn((path) => {
        if (!files.has(String(path)))
            throw new Error(`ENOENT: ${path}`);
        return { mtimeMs: Date.now() };
    });
    return {
        files,
        fsModule: {
            existsSync,
            readFileSync,
            writeFileSync,
            mkdirSync,
            unlinkSync,
            openSync,
            statSync,
            writeSync: vi.fn(),
            closeSync: vi.fn(),
            renameSync: vi.fn(),
            constants: {
                O_CREAT: 0x40,
                O_EXCL: 0x80,
                O_WRONLY: 0x1,
            },
        },
    };
}
describe('getUsage lock failure fallback', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    });
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.unmock('../../utils/config-dir.js');
        vi.unmock('../../utils/ssrf-guard.js');
        vi.unmock('fs');
        vi.unmock('child_process');
        vi.unmock('https');
    });
    it('returns stale cache without throwing when lock acquisition fails', async () => {
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            data: {
                fiveHourPercent: 11,
                fiveHourResetsAt: null,
            },
        });
        // Lock file already exists → openSync throws EEXIST → lock fails
        const { files, fsModule } = createFsMock({
            [CACHE_PATH]: expiredCache,
            [LOCK_PATH]: JSON.stringify({ pid: 999999, timestamp: Date.now() }),
        });
        // Make the lock holder appear alive so lock is not considered stale
        const originalKill = process.kill;
        process.kill = ((pid, signal) => {
            if (signal === 0 && pid === 999999)
                return true;
            return originalKill.call(process, pid, signal);
        });
        vi.doMock('../../utils/config-dir.js', () => ({
            getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
        }));
        vi.doMock('../../utils/ssrf-guard.js', () => ({
            validateAnthropicBaseUrl: () => ({ allowed: true }),
        }));
        vi.doMock('child_process', async () => ({
            ...(await vi.importActual('child_process')),
            execSync: vi.fn(),
        }));
        vi.doMock('fs', () => fsModule);
        vi.doMock('https', () => ({
            default: {
                request: vi.fn(),
            },
        }));
        const { getUsage } = await import('../../hud/usage-api.js');
        const httpsModule = await import('https');
        // Should NOT throw, should return stale data
        const result = await getUsage();
        expect(result.rateLimits).toEqual({
            fiveHourPercent: 11,
            fiveHourResetsAt: null,
        });
        // Should not have made any API call
        expect(httpsModule.default.request).not.toHaveBeenCalled();
        // Should not have modified the cache file (no race with lock holder)
        expect(files.get(CACHE_PATH)).toBe(expiredCache);
        process.kill = originalKill;
    });
    it('returns error result when lock fails and no stale cache exists', async () => {
        // No cache file at all, lock held by another process
        const { fsModule } = createFsMock({
            [LOCK_PATH]: JSON.stringify({ pid: 999999, timestamp: Date.now() }),
        });
        const originalKill = process.kill;
        process.kill = ((pid, signal) => {
            if (signal === 0 && pid === 999999)
                return true;
            return originalKill.call(process, pid, signal);
        });
        vi.doMock('../../utils/config-dir.js', () => ({
            getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
        }));
        vi.doMock('../../utils/ssrf-guard.js', () => ({
            validateAnthropicBaseUrl: () => ({ allowed: true }),
        }));
        vi.doMock('child_process', async () => ({
            ...(await vi.importActual('child_process')),
            execSync: vi.fn(),
        }));
        vi.doMock('fs', () => fsModule);
        vi.doMock('https', () => ({
            default: {
                request: vi.fn(),
            },
        }));
        const { getUsage } = await import('../../hud/usage-api.js');
        // Should NOT throw, should return error result
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBeDefined();
        process.kill = originalKill;
    });
});
describe('getUsage lock behavior', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    });
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.unmock('../../utils/config-dir.js');
        vi.unmock('../../utils/ssrf-guard.js');
        vi.unmock('fs');
        vi.unmock('child_process');
        vi.unmock('https');
    });
    it('acquires lock before API call when cache is expired', async () => {
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            data: {
                fiveHourPercent: 12,
                fiveHourResetsAt: null,
            },
        });
        const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        let requestSawLock = false;
        vi.doMock('../../utils/config-dir.js', () => ({
            getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
        }));
        vi.doMock('../../utils/ssrf-guard.js', () => ({
            validateAnthropicBaseUrl: () => ({ allowed: true }),
        }));
        vi.doMock('child_process', async () => ({
            ...(await vi.importActual('child_process')),
            execSync: vi.fn(),
        }));
        vi.doMock('fs', () => fsModule);
        vi.doMock('https', () => ({
            default: {
                request: vi.fn((options, callback) => {
                    requestSawLock = files.has(LOCK_PATH);
                    const req = new EventEmitter();
                    req.destroy = vi.fn();
                    req.end = () => {
                        setTimeout(() => {
                            const res = new EventEmitter();
                            res.statusCode = 200;
                            callback(res);
                            res.emit('data', JSON.stringify({
                                data: {
                                    limits: [
                                        { type: 'TOKENS_LIMIT', percentage: 67, nextResetTime: Date.now() + 3_600_000 },
                                    ],
                                },
                            }));
                            res.emit('end');
                        }, 10);
                    };
                    return req;
                }),
            },
        }));
        const { getUsage } = await import('../../hud/usage-api.js');
        const httpsModule = await import('https');
        const [first, second] = await Promise.all([getUsage(), getUsage()]);
        expect(requestSawLock).toBe(true);
        expect(fsModule.openSync.mock.invocationCallOrder[0]).toBeLessThan(httpsModule.default.request.mock.invocationCallOrder[0]);
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        expect(first).toEqual({
            rateLimits: {
                fiveHourPercent: 67,
                fiveHourResetsAt: expect.any(Date),
                monthlyPercent: undefined,
                monthlyResetsAt: undefined,
            },
        });
        // With fail-fast locking, the second concurrent call returns stale cache
        // (lock held by first call) or fresh data (if lock released in time)
        expect(second.rateLimits).toBeDefined();
        expect(files.get(CACHE_PATH)).toContain('"source": "zai"');
    });
});
//# sourceMappingURL=usage-api-lock.test.js.map