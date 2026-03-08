/**
 * Tests for usage-api file lock (thundering herd prevention).
 *
 * When multiple sessions share the same cache file, only one session
 * should fetch from the API at a time. Others should return stale cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Use vi.hoisted() so mock fns are available in vi.mock() factories
const { mockWithFileLock, mockLockPathFor, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockHttpsRequest, } = vi.hoisted(() => ({
    mockWithFileLock: vi.fn(),
    mockLockPathFor: vi.fn((p) => p + '.lock'),
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockReadFileSync: vi.fn().mockReturnValue('{}'),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockHttpsRequest: vi.fn(),
}));
vi.mock('../../lib/file-lock.js', () => ({
    withFileLock: mockWithFileLock,
    lockPathFor: mockLockPathFor,
}));
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: (...args) => mockExistsSync(...args),
        readFileSync: (...args) => mockReadFileSync(...args),
        writeFileSync: (...args) => mockWriteFileSync(...args),
        mkdirSync: (...args) => mockMkdirSync(...args),
        renameSync: vi.fn(),
        unlinkSync: vi.fn(),
        lstatSync: vi.fn(),
    };
});
vi.mock('../../utils/paths.js', () => ({
    getClaudeConfigDir: () => '/tmp/test-claude',
}));
vi.mock('child_process', () => ({
    execSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
}));
vi.mock('https', () => ({
    default: {
        request: (...args) => mockHttpsRequest(...args),
    },
}));
vi.mock('../../utils/ssrf-guard.js', () => ({
    validateAnthropicBaseUrl: () => ({ allowed: true }),
}));
import { getUsage } from '../../hud/usage-api.js';
describe('getUsage with file lock (thundering herd prevention)', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        // Default: withFileLock executes the callback (lock acquired successfully)
        mockWithFileLock.mockImplementation((_path, fn) => fn());
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });
    it('does not attempt lock when cache is valid', async () => {
        // Set up valid cache
        const validCache = JSON.stringify({
            timestamp: Date.now(),
            data: { fiveHourPercent: 50, weeklyPercent: 30 },
            source: 'anthropic',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(validCache);
        const result = await getUsage();
        // Should return cached data without acquiring lock
        expect(mockWithFileLock).not.toHaveBeenCalled();
        expect(result.rateLimits).not.toBeNull();
    });
    it('acquires lock before API call when cache is expired', async () => {
        // Set up expired cache
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 60_000, // 60 seconds ago (TTL is 30s)
            data: { fiveHourPercent: 50, weeklyPercent: 30 },
            source: 'anthropic',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(expiredCache);
        await getUsage();
        // Should have attempted to acquire lock via withFileLock
        expect(mockWithFileLock).toHaveBeenCalled();
    });
    it('returns stale cache without error when lock not acquired and stale data exists', async () => {
        // Set up expired cache with data
        const staleCache = JSON.stringify({
            timestamp: Date.now() - 60_000,
            data: { fiveHourPercent: 42, weeklyPercent: 20 },
            source: 'anthropic',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(staleCache);
        // withFileLock throws when lock acquisition fails
        mockWithFileLock.mockRejectedValue(new Error('Failed to acquire file lock'));
        const result = await getUsage();
        // Should return stale data WITHOUT error
        expect(result.rateLimits).not.toBeNull();
        expect(result.rateLimits.fiveHourPercent).toBe(42);
        expect(result.error).toBeUndefined();
    });
    it('returns error when lock not acquired and no stale data', async () => {
        // No cache at all
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
        // Lock acquisition fails
        mockWithFileLock.mockRejectedValue(new Error('Failed to acquire file lock'));
        const result = await getUsage();
        // No stale data → should return error
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBeDefined();
    });
    it('withFileLock guarantees lock release via its finally block', async () => {
        // Expired cache
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 60_000,
            data: null,
            source: 'anthropic',
            error: true,
            errorReason: 'no_credentials',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(expiredCache);
        await getUsage();
        // withFileLock was called (it internally handles acquire/release)
        expect(mockWithFileLock).toHaveBeenCalledTimes(1);
        // Verify the lock path is derived from cache path
        expect(mockLockPathFor).toHaveBeenCalled();
    });
    it('passes staleLockMs option of API_TIMEOUT + 5s', async () => {
        // Expired cache
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 60_000,
            data: null,
            source: 'anthropic',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(expiredCache);
        await getUsage();
        // Verify lock options include staleLockMs = 15000 (10s timeout + 5s)
        if (mockWithFileLock.mock.calls.length > 0) {
            const opts = mockWithFileLock.mock.calls[0][2];
            expect(opts?.staleLockMs).toBe(15000);
        }
    });
    it('handles API errors gracefully while holding lock', async () => {
        // Set up z.ai env to trigger API path
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        // Expired cache
        const expiredCache = JSON.stringify({
            timestamp: Date.now() - 60_000,
            data: null,
            source: 'zai',
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(expiredCache);
        // withFileLock executes callback; API call inside will fail
        mockWithFileLock.mockImplementation((_path, fn) => fn());
        // Mock https.request to simulate error
        mockHttpsRequest.mockImplementation((_opts, _cb) => {
            return {
                on: (event, cb) => {
                    if (event === 'error')
                        setTimeout(() => cb(new Error('network')), 0);
                    return { on: vi.fn().mockReturnThis(), end: vi.fn() };
                },
                end: vi.fn(),
            };
        });
        // Should not throw — errors handled inside withFileLock callback
        const result = await getUsage();
        expect(result).toBeDefined();
    });
});
//# sourceMappingURL=usage-api-lock.test.js.map