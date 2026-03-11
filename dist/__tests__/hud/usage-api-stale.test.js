/**
 * Tests for stale data handling in usage API.
 *
 * - 429 responses should set stale: true on returned UsageResult
 * - lastSuccessAt tracks when data was last successfully fetched
 * - After 15 minutes from lastSuccessAt, stale data is discarded
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
const CLAUDE_CONFIG_DIR = '/tmp/test-claude';
const CACHE_PATH = `${CLAUDE_CONFIG_DIR}/plugins/oh-my-claudecode/.usage-cache.json`;
const CACHE_DIR = `${CLAUDE_CONFIG_DIR}/plugins/oh-my-claudecode`;
function createFsMock(initialFiles) {
    const files = new Map(Object.entries(initialFiles));
    const directories = new Set([CLAUDE_CONFIG_DIR, CACHE_DIR]);
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
function setupMocks(fsModule, httpStatus, httpBody) {
    vi.doMock('../../utils/paths.js', () => ({
        getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
    }));
    vi.doMock('../../utils/ssrf-guard.js', () => ({
        validateAnthropicBaseUrl: () => ({ allowed: true }),
    }));
    vi.doMock('child_process', () => ({
        execSync: vi.fn(),
    }));
    vi.doMock('fs', () => fsModule);
    vi.doMock('https', () => ({
        default: {
            request: vi.fn((_options, callback) => {
                const req = new EventEmitter();
                req.destroy = vi.fn();
                req.end = () => {
                    setTimeout(() => {
                        const res = new EventEmitter();
                        res.statusCode = httpStatus;
                        callback(res);
                        res.emit('data', httpBody);
                        res.emit('end');
                    }, 1);
                };
                return req;
            }),
        },
    }));
}
describe('usage API stale data handling', () => {
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
        vi.unmock('../../utils/paths.js');
        vi.unmock('../../utils/ssrf-guard.js');
        vi.unmock('fs');
        vi.unmock('child_process');
        vi.unmock('https');
    });
    it('sets stale=true when serving cached data on 429', async () => {
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            data: {
                fiveHourPercent: 11,
                fiveHourResetsAt: null,
            },
        });
        const { fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 429, '');
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        expect(result.rateLimits).toBeDefined();
        expect(result.rateLimits?.fiveHourPercent).toBe(11);
        expect(result.error).toBe('rate_limited');
        expect(result.stale).toBe(true);
    });
    it('does not set stale on successful API response', async () => {
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            data: { fiveHourPercent: 11 },
        });
        const { fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 200, JSON.stringify({
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 25, nextResetTime: Date.now() + 3_600_000 },
                ],
            },
        }));
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        expect(result.rateLimits).toBeDefined();
        expect(result.rateLimits?.fiveHourPercent).toBe(25);
        expect(result.stale).toBeUndefined();
    });
    it('preserves lastSuccessAt in cache across 429 rewrites', async () => {
        const lastSuccess = Date.now() - 300_000; // 5 minutes ago
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            lastSuccessAt: lastSuccess,
            data: { fiveHourPercent: 11 },
        });
        const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 429, '');
        const { getUsage } = await import('../../hud/usage-api.js');
        await getUsage();
        // Cache should preserve the original lastSuccessAt
        const written = JSON.parse(files.get(CACHE_PATH));
        expect(written.lastSuccessAt).toBe(lastSuccess);
    });
    it('sets lastSuccessAt on successful API response', async () => {
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            data: { fiveHourPercent: 11 },
        });
        const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 200, JSON.stringify({
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 25, nextResetTime: Date.now() + 3_600_000 },
                ],
            },
        }));
        const now = Date.now();
        const { getUsage } = await import('../../hud/usage-api.js');
        await getUsage();
        const written = JSON.parse(files.get(CACHE_PATH));
        expect(written.lastSuccessAt).toBeGreaterThanOrEqual(now);
    });
    it('discards stale data after 15 minutes from lastSuccessAt', async () => {
        const sixteenMinutesAgo = Date.now() - 16 * 60_000;
        // Cache is within rate-limited backoff window (valid) but lastSuccessAt is > 15min
        const validRateLimitedCache = JSON.stringify({
            timestamp: Date.now() - 60_000, // 1 min ago (within 2min backoff)
            source: 'zai',
            lastSuccessAt: sixteenMinutesAgo,
            data: { fiveHourPercent: 11 },
            rateLimited: true,
            rateLimitedCount: 1,
        });
        const { fsModule } = createFsMock({ [CACHE_PATH]: validRateLimitedCache });
        vi.doMock('../../utils/paths.js', () => ({
            getClaudeConfigDir: () => CLAUDE_CONFIG_DIR,
        }));
        vi.doMock('../../utils/ssrf-guard.js', () => ({
            validateAnthropicBaseUrl: () => ({ allowed: true }),
        }));
        vi.doMock('child_process', () => ({
            execSync: vi.fn(),
        }));
        vi.doMock('fs', () => fsModule);
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        // Should discard the data and show error
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('rate_limited');
    });
    it('preserves last-known-good usage on transient network failures and marks it stale', async () => {
        const lastSuccess = Date.now() - 5 * 60_000;
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            lastSuccessAt: lastSuccess,
            data: {
                fiveHourPercent: 11,
                fiveHourResetsAt: null,
            },
        });
        const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 500, '');
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 11,
                fiveHourResetsAt: null,
            },
            error: 'network',
            stale: true,
        });
        const written = JSON.parse(files.get(CACHE_PATH));
        expect(written.data).toEqual({
            fiveHourPercent: 11,
            fiveHourResetsAt: null,
        });
        expect(written.error).toBe(true);
        expect(written.errorReason).toBe('network');
        expect(written.lastSuccessAt).toBe(lastSuccess);
    });
    it('does not preserve stale fallback data past the max stale window on transient failures', async () => {
        const sixteenMinutesAgo = Date.now() - 16 * 60_000;
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 91_000,
            source: 'zai',
            lastSuccessAt: sixteenMinutesAgo,
            data: {
                fiveHourPercent: 11,
                fiveHourResetsAt: null,
            },
        });
        const { files, fsModule } = createFsMock({ [CACHE_PATH]: expiredCache });
        setupMocks(fsModule, 500, '');
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: null,
            error: 'network',
        });
        const written = JSON.parse(files.get(CACHE_PATH));
        expect(written.data).toBeNull();
        expect(written.error).toBe(true);
        expect(written.errorReason).toBe('network');
        expect(written.lastSuccessAt).toBe(sixteenMinutesAgo);
    });
    it('reuses stale transient failure cache long enough to avoid immediate retry hammering', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-10T00:00:00Z'));
        const validTransientFailureCache = JSON.stringify({
            timestamp: Date.now() - 90_000,
            source: 'zai',
            lastSuccessAt: Date.now() - 90_000,
            data: { fiveHourPercent: 11 },
            error: true,
            errorReason: 'network',
        });
        const { fsModule } = createFsMock({ [CACHE_PATH]: validTransientFailureCache });
        setupMocks(fsModule, 500, '');
        const httpsModule = await import('https');
        const { getUsage } = await import('../../hud/usage-api.js');
        const result = await getUsage();
        expect(result.rateLimits?.fiveHourPercent).toBe(11);
        expect(result.error).toBe('network');
        expect(result.stale).toBe(true);
        expect(httpsModule.default.request).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
//# sourceMappingURL=usage-api-stale.test.js.map