/**
 * Tests for z.ai/MiniMax host validation, response parsing, and getUsage routing.
 */
import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as os from 'os';
import { EventEmitter } from 'events';
import { isZaiHost, parseZaiResponse, isMinimaxHost, parseMinimaxResponse, getUsage, parseUsageResponse } from '../../hud/usage-api.js';
// Mock file-lock so withFileLock always executes the callback (tests focus on routing, not locking)
vi.mock('../../lib/file-lock.js', () => ({
    withFileLock: vi.fn((_lockPath, fn) => fn()),
    lockPathFor: vi.fn((p) => p + '.lock'),
}));
// Mock dependencies that touch filesystem / keychain / network
vi.mock('../../utils/paths.js', () => ({
    getClaudeConfigDir: () => '/tmp/test-claude',
}));
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue('{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        openSync: vi.fn().mockReturnValue(1),
        writeSync: vi.fn(),
        closeSync: vi.fn(),
        statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
        unlinkSync: vi.fn(),
    };
});
vi.mock('child_process', () => ({
    execSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
    execFileSync: vi.fn().mockImplementation(() => { throw new Error('mock: no keychain'); }),
}));
vi.mock('https', () => ({
    default: {
        request: vi.fn(),
    },
}));
describe('isZaiHost', () => {
    it('accepts exact z.ai hostname', () => {
        expect(isZaiHost('https://z.ai')).toBe(true);
        expect(isZaiHost('https://z.ai/')).toBe(true);
        expect(isZaiHost('https://z.ai/v1')).toBe(true);
    });
    it('accepts subdomains of z.ai', () => {
        expect(isZaiHost('https://api.z.ai')).toBe(true);
        expect(isZaiHost('https://api.z.ai/v1/messages')).toBe(true);
        expect(isZaiHost('https://foo.bar.z.ai')).toBe(true);
    });
    it('rejects hosts that merely contain z.ai as substring', () => {
        expect(isZaiHost('https://z.ai.evil.tld')).toBe(false);
        expect(isZaiHost('https://notz.ai')).toBe(false);
        expect(isZaiHost('https://z.ai.example.com')).toBe(false);
    });
    it('rejects unrelated hosts', () => {
        expect(isZaiHost('https://api.anthropic.com')).toBe(false);
        expect(isZaiHost('https://example.com')).toBe(false);
        expect(isZaiHost('https://localhost:8080')).toBe(false);
    });
    it('rejects invalid URLs gracefully', () => {
        expect(isZaiHost('')).toBe(false);
        expect(isZaiHost('not-a-url')).toBe(false);
        expect(isZaiHost('://missing-protocol')).toBe(false);
    });
    it('is case-insensitive', () => {
        expect(isZaiHost('https://Z.AI/v1')).toBe(true);
        expect(isZaiHost('https://API.Z.AI')).toBe(true);
    });
});
describe('parseZaiResponse', () => {
    it('returns null for empty response', () => {
        expect(parseZaiResponse({})).toBeNull();
        expect(parseZaiResponse({ data: {} })).toBeNull();
        expect(parseZaiResponse({ data: { limits: [] } })).toBeNull();
    });
    it('returns null when no known limit types exist', () => {
        const response = {
            data: {
                limits: [{ type: 'UNKNOWN_LIMIT', percentage: 50 }],
            },
        };
        expect(parseZaiResponse(response)).toBeNull();
    });
    it('parses TOKENS_LIMIT as fiveHourPercent', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: Date.now() + 3600_000 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(42);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
    });
    it('parses TIME_LIMIT as monthlyPercent', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 10 },
                    { type: 'TIME_LIMIT', percentage: 75, nextResetTime: Date.now() + 86400_000 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.monthlyPercent).toBe(75);
        expect(result.monthlyResetsAt).toBeInstanceOf(Date);
    });
    it('omits weeklyPercent when API returns a single TOKENS_LIMIT (free/basic tier)', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 50 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.weeklyPercent).toBeUndefined();
        expect(result.weeklyResetsAt).toBeUndefined();
    });
    it('clamps percentages to 0-100', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 150 },
                    { type: 'TIME_LIMIT', percentage: -10 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(100);
        expect(result.monthlyPercent).toBe(0);
    });
    it('parses monthly-only limited state (TIME_LIMIT without TOKENS_LIMIT)', () => {
        const resetTime = Date.now() + 86400_000 * 7;
        const response = {
            data: {
                limits: [
                    { type: 'TIME_LIMIT', percentage: 90, nextResetTime: resetTime },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(0); // clamped from undefined
        expect(result.monthlyPercent).toBe(90);
        expect(result.monthlyResetsAt).toBeInstanceOf(Date);
        expect(result.monthlyResetsAt.getTime()).toBe(resetTime);
        expect(result.weeklyPercent).toBeUndefined();
    });
    it('handles TIME_LIMIT without nextResetTime', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 10 },
                    { type: 'TIME_LIMIT', percentage: 50 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.monthlyPercent).toBe(50);
        expect(result.monthlyResetsAt).toBeNull();
    });
    it('parses two TOKENS_LIMIT entries as 5-hour + weekly buckets (pro tier fixture)', () => {
        // Real z.ai pro tier response payload shared by a user
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1776180480445 },
                    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 65, nextResetTime: 1776303517998 },
                    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, nextResetTime: 1778290717998 },
                ],
                level: 'pro',
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(1);
        expect(result.weeklyPercent).toBe(65);
        expect(result.monthlyPercent).toBe(1);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.fiveHourResetsAt.getTime()).toBe(1776180480445);
        expect(result.weeklyResetsAt).toBeInstanceOf(Date);
        expect(result.weeklyResetsAt.getTime()).toBe(1776303517998);
        expect(result.monthlyResetsAt).toBeInstanceOf(Date);
        expect(result.monthlyResetsAt.getTime()).toBe(1778290717998);
    });
    it('omits weekly when pro-tier response only has TOKENS_LIMIT + TIME_LIMIT (no weekly bucket)', () => {
        // Real z.ai response: pro tier user whose plan does NOT include a weekly
        // TOKENS_LIMIT bucket. The HUD must hide the `wk:` segment in this case.
        const response = {
            data: {
                limits: [
                    {
                        type: 'TIME_LIMIT',
                        unit: 5,
                        number: 1,
                        usage: 1000,
                        currentValue: 1000,
                        remaining: 0,
                        percentage: 100,
                        nextResetTime: 1777391696996,
                    },
                    {
                        type: 'TOKENS_LIMIT',
                        unit: 3,
                        number: 5,
                        percentage: 1,
                        nextResetTime: 1776190484314,
                    },
                ],
                level: 'pro',
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(1);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.fiveHourResetsAt.getTime()).toBe(1776190484314);
        expect(result.monthlyPercent).toBe(100);
        expect(result.monthlyResetsAt).toBeInstanceOf(Date);
        expect(result.monthlyResetsAt.getTime()).toBe(1777391696996);
        // Critical: weekly fields must remain undefined so HUD hides `wk:` segment
        expect(result.weeklyPercent).toBeUndefined();
        expect(result.weeklyResetsAt).toBeUndefined();
    });
    it('classifies by unit code even when weekly.nextResetTime < 5h.nextResetTime', () => {
        // Edge case: in the final hours before a weekly reset, the weekly
        // bucket's nextResetTime can be sooner than the 5-hour bucket's. Under a
        // naive nextResetTime sort this would swap slots. unit-based
        // classification keeps them correct.
        const now = Date.now();
        const response = {
            data: {
                limits: [
                    // 5-hour window: resets in ~5 hours
                    { type: 'TOKENS_LIMIT', unit: 3, percentage: 40, nextResetTime: now + 5 * 3600_000 },
                    // Weekly window: resets in ~30 minutes (near end of week)
                    { type: 'TOKENS_LIMIT', unit: 6, percentage: 92, nextResetTime: now + 30 * 60_000 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        // Must map by unit, not by reset time
        expect(result.fiveHourPercent).toBe(40);
        expect(result.weeklyPercent).toBe(92);
        expect(result.fiveHourResetsAt.getTime()).toBe(now + 5 * 3600_000);
        expect(result.weeklyResetsAt.getTime()).toBe(now + 30 * 60_000);
    });
    it('is robust to TOKENS_LIMIT array order (weekly first, 5-hour second)', () => {
        const response = {
            data: {
                limits: [
                    // Deliberately reversed from the canonical order
                    { type: 'TOKENS_LIMIT', percentage: 65, nextResetTime: 1776303517998 },
                    { type: 'TOKENS_LIMIT', percentage: 1, nextResetTime: 1776180480445 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(1);
        expect(result.weeklyPercent).toBe(65);
    });
    it('pushes TOKENS_LIMIT with missing nextResetTime into the weekly slot', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: 1776180480445 },
                    { type: 'TOKENS_LIMIT', percentage: 80 }, // no nextResetTime
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(20);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.weeklyPercent).toBe(80);
        expect(result.weeklyResetsAt).toBeNull();
    });
    it('treats nextResetTime === 0 the same as missing for sort purposes', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 0 },
                    { type: 'TOKENS_LIMIT', percentage: 70, nextResetTime: 1776180480445 },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(70);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.weeklyPercent).toBe(30);
        expect(result.weeklyResetsAt).toBeNull();
    });
    it('uses only the first two TOKENS_LIMIT entries (by reset time) when 3+ exist', () => {
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1776180480445 }, // earliest -> 5h
                    { type: 'TOKENS_LIMIT', percentage: 65, nextResetTime: 1776303517998 }, // middle -> weekly
                    { type: 'TOKENS_LIMIT', percentage: 90, nextResetTime: 1778290717998 }, // latest -> ignored
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(10);
        expect(result.weeklyPercent).toBe(65);
    });
    it('tie-breaks equal nextResetTime by smaller percentage -> 5-hour slot', () => {
        const sameReset = 1776180480445;
        const response = {
            data: {
                limits: [
                    { type: 'TOKENS_LIMIT', percentage: 80, nextResetTime: sameReset },
                    { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: sameReset },
                ],
            },
        };
        const result = parseZaiResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(20);
        expect(result.weeklyPercent).toBe(80);
    });
});
describe('getUsage routing', () => {
    const originalEnv = { ...process.env };
    const originalPlatform = process.platform;
    let httpsModule;
    const expectedServiceName = (configDir) => `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
    beforeAll(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    });
    afterAll(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.readFileSync).mockReturnValue('{}');
        vi.mocked(childProcess.execSync).mockImplementation(() => { throw new Error('mock: no keychain'); });
        vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw new Error('mock: no keychain'); });
        // Reset env
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        // Get the mocked https module for assertions
        httpsModule = await import('https');
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });
    it('returns no_credentials error when no credentials and no z.ai env', async () => {
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('no_credentials');
        // No network call should be made without credentials
        expect(httpsModule.default.request).not.toHaveBeenCalled();
    });
    it('uses the raw ~-prefixed CLAUDE_CONFIG_DIR value for Keychain service lookup', async () => {
        process.env.CLAUDE_CONFIG_DIR = '~/.claude-personal';
        const oneHourFromNow = Date.now() + 60 * 60 * 1000;
        const execFileMock = vi.mocked(childProcess.execFileSync);
        const username = os.userInfo().username;
        const expectedService = expectedServiceName(process.env.CLAUDE_CONFIG_DIR);
        execFileMock.mockImplementation((_file, args) => {
            const argsArr = args;
            expect(argsArr).toContain('find-generic-password');
            expect(argsArr).toContain('-s');
            expect(argsArr).toContain(expectedService);
            if (argsArr.includes('-a') && argsArr.includes(username)) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'raw-token',
                        refreshToken: 'raw-refresh',
                        expiresAt: oneHourFromNow,
                    },
                });
            }
            throw new Error(`unexpected keychain lookup: ${JSON.stringify(argsArr)}`);
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 15 },
                    seven_day: { utilization: 35 },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 15,
                weeklyPercent: 35,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
        });
        expect(execFileMock).toHaveBeenCalledOnce();
    });
    it('uses a different Keychain service when CLAUDE_CONFIG_DIR is already expanded', async () => {
        process.env.CLAUDE_CONFIG_DIR = '/Users/test/.claude-personal';
        const oneHourFromNow = Date.now() + 60 * 60 * 1000;
        const execFileMock = vi.mocked(childProcess.execFileSync);
        const username = os.userInfo().username;
        const expectedService = expectedServiceName(process.env.CLAUDE_CONFIG_DIR);
        execFileMock.mockImplementation((_file, args) => {
            const argsArr = args;
            expect(argsArr).toContain('find-generic-password');
            expect(argsArr).toContain('-s');
            expect(argsArr).toContain(expectedService);
            if (argsArr.includes('-a') && argsArr.includes(username)) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'expanded-token',
                        refreshToken: 'expanded-refresh',
                        expiresAt: oneHourFromNow,
                    },
                });
            }
            throw new Error(`unexpected keychain lookup: ${JSON.stringify(argsArr)}`);
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 11 },
                    seven_day: { utilization: 22 },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 11,
                weeklyPercent: 22,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
        });
        expect(execFileMock).toHaveBeenCalledOnce();
    });
    it('prefers the username-scoped keychain entry when the legacy service-only entry is expired', async () => {
        const oneHourFromNow = Date.now() + 60 * 60 * 1000;
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const execFileMock = vi.mocked(childProcess.execFileSync);
        const username = os.userInfo().username;
        execFileMock.mockImplementation((_file, args) => {
            const argsArr = args;
            if (argsArr && argsArr.includes('-a') && argsArr.includes(username)) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'fresh-token',
                        refreshToken: 'fresh-refresh',
                        expiresAt: oneHourFromNow,
                    },
                });
            }
            if (argsArr && argsArr.includes('find-generic-password') && !argsArr.includes('-a')) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'stale-token',
                        refreshToken: 'stale-refresh',
                        expiresAt: oneHourAgo,
                    },
                });
            }
            throw new Error(`unexpected keychain lookup: ${JSON.stringify(argsArr)}`);
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 25 },
                    seven_day: { utilization: 50 },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 25,
                weeklyPercent: 50,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
        });
        // Verify username-scoped call was made (first call includes -a <username>)
        const calls = execFileMock.mock.calls;
        const userScopedCall = calls.find(c => Array.isArray(c[1]) && c[1].includes('-a') && c[1].includes(username));
        expect(userScopedCall).toBeTruthy();
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        expect(httpsModule.default.request.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh-token');
    });
    it('falls back to the legacy service-only keychain entry when the username-scoped entry is expired', async () => {
        const oneHourFromNow = Date.now() + 60 * 60 * 1000;
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const execFileMock = vi.mocked(childProcess.execFileSync);
        const username = os.userInfo().username;
        execFileMock.mockImplementation((_file, args) => {
            const argsArr = args;
            if (argsArr && argsArr.includes('-a') && argsArr.includes(username)) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'expired-user-token',
                        refreshToken: 'expired-user-refresh',
                        expiresAt: oneHourAgo,
                    },
                });
            }
            if (argsArr && argsArr.includes('find-generic-password') && !argsArr.includes('-a')) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'fresh-legacy-token',
                        refreshToken: 'fresh-legacy-refresh',
                        expiresAt: oneHourFromNow,
                    },
                });
            }
            throw new Error(`unexpected keychain lookup: ${JSON.stringify(argsArr)}`);
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 10 },
                    seven_day: { utilization: 20 },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 10,
                weeklyPercent: 20,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
        });
        expect(execFileMock).toHaveBeenCalledTimes(2);
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        expect(httpsModule.default.request.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh-legacy-token');
    });
    it('preserves model-specific rate limits when generic subscription windows are nullish', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 36, resets_at: '2026-04-24T13:00:00Z' },
            seven_day: null,
            seven_day_sonnet: { utilization: 8, resets_at: '2026-04-25T13:00:00Z' },
        });
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(36);
        expect(result.weeklyPercent).toBeUndefined();
        expect(result.sonnetWeeklyPercent).toBe(8);
        expect(result.sonnetWeeklyResetsAt).toBeInstanceOf(Date);
    });
    it('passes OAuth subscription metadata so Max used_credits overage stays extra usage', async () => {
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        mockedExistsSync.mockImplementation((path) => String(path).endsWith('.credentials.json'));
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path).endsWith('.credentials.json')) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'valid-token',
                        refreshToken: 'refresh-token',
                        expiresAt: Date.now() + 60_000,
                        subscriptionType: 'max',
                        rateLimitTier: 'default_claude_max_20x',
                    },
                });
            }
            return '{}';
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 3 },
                    seven_day: { utilization: 16 },
                    seven_day_sonnet: { utilization: 0 },
                    extra_usage: {
                        is_enabled: true,
                        used_credits: 2726,
                        monthly_limit: 5000,
                        currency: 'USD',
                    },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result.error).toBeUndefined();
        expect(result.rateLimits).toMatchObject({
            fiveHourPercent: 3,
            weeklyPercent: 16,
            sonnetWeeklyPercent: 0,
            extraUsageSpentUsd: 27.26,
            extraUsageLimitUsd: 50,
            extraUsagePercent: 54.52,
        });
        expect(result.rateLimits.enterpriseSpentUsd).toBeUndefined();
        expect(result.rateLimits.enterpriseLimitUsd).toBeUndefined();
    });
    it('returns getUsage rateLimits when OAuth credentials lack subscription metadata', async () => {
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        mockedExistsSync.mockImplementation((path) => String(path).endsWith('.credentials.json'));
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path).endsWith('.credentials.json')) {
                return JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'valid-token',
                        refreshToken: 'refresh-token',
                        expiresAt: Date.now() + 60_000,
                        subscriptionType: null,
                        rateLimitTier: null,
                    },
                });
            }
            return '{}';
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    five_hour: { utilization: 36, resets_at: '2026-04-24T13:00:00Z' },
                    seven_day: { utilization: 32, resets_at: '2026-04-25T13:00:00Z' },
                    seven_day_sonnet: { utilization: 8, resets_at: '2026-04-25T13:00:00Z' },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result.error).toBeUndefined();
        expect(result.rateLimits).toMatchObject({
            fiveHourPercent: 36,
            weeklyPercent: 32,
            sonnetWeeklyPercent: 8,
        });
        expect(result.rateLimits.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.rateLimits.weeklyResetsAt).toBeInstanceOf(Date);
        expect(result.rateLimits.sonnetWeeklyResetsAt).toBeInstanceOf(Date);
    });
    it('routes to z.ai when ANTHROPIC_BASE_URL is z.ai host', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        // https.request mock not wired, so fetchUsageFromZai resolves to null (network error)
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('network');
        // Verify z.ai quota endpoint was called
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        const callArgs = httpsModule.default.request.mock.calls[0][0];
        expect(callArgs.hostname).toBe('api.z.ai');
        expect(callArgs.path).toBe('/api/monitor/usage/quota/limit');
    });
    it('does NOT route to z.ai for look-alike hosts', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://z.ai.evil.tld/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('no_credentials');
        // Should NOT call https.request with z.ai endpoint.
        // Falls through to OAuth path which has no credentials (mocked),
        // so no network call should be made at all.
        expect(httpsModule.default.request).not.toHaveBeenCalled();
    });
    it('returns error when API call fails', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        // Mock failed API response (network error)
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('network');
    });
    it('reuses successful cached usage data for 90 seconds to avoid excessive polling', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        mockedExistsSync.mockImplementation((path) => String(path).endsWith('.usage-cache-anthropic.json'));
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path).endsWith('.usage-cache-anthropic.json')) {
                return JSON.stringify({
                    timestamp: Date.now() - 60_000,
                    source: 'anthropic',
                    data: {
                        fiveHourPercent: 42,
                        weeklyPercent: 17,
                        fiveHourResetsAt: null,
                        weeklyResetsAt: null,
                    },
                });
            }
            return '{}';
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 42,
                weeklyPercent: 17,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
            error: undefined,
        });
        expect(httpsModule.default.request).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
    it('respects configured usageApiPollIntervalMs for successful cache reuse', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        mockedExistsSync.mockImplementation((path) => {
            const file = String(path);
            return file.endsWith('settings.json') || file.endsWith('.usage-cache-anthropic.json');
        });
        mockedReadFileSync.mockImplementation((path) => {
            const file = String(path);
            if (file.endsWith('settings.json')) {
                return JSON.stringify({
                    omcHud: {
                        usageApiPollIntervalMs: 180_000,
                    },
                });
            }
            if (file.endsWith('.usage-cache-anthropic.json')) {
                return JSON.stringify({
                    timestamp: Date.now() - 120_000,
                    source: 'anthropic',
                    data: {
                        fiveHourPercent: 42,
                        weeklyPercent: 17,
                        fiveHourResetsAt: null,
                        weeklyResetsAt: null,
                    },
                });
            }
            return '{}';
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: {
                fiveHourPercent: 42,
                weeklyPercent: 17,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
            error: undefined,
        });
        expect(httpsModule.default.request).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
    it('returns rate_limited and persists exponential backoff metadata even without stale data', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
        mockedExistsSync.mockImplementation((path) => String(path).endsWith('settings.json'));
        mockedReadFileSync.mockImplementation((path) => {
            const file = String(path);
            if (file.endsWith('settings.json')) {
                return JSON.stringify({
                    omcHud: {
                        usageApiPollIntervalMs: 60_000,
                    },
                });
            }
            return '{}';
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 429;
                callback(res);
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result).toEqual({
            rateLimits: null,
            error: 'rate_limited',
        });
        expect(mockedWriteFileSync).toHaveBeenCalled();
        const writtenCache = JSON.parse(String(mockedWriteFileSync.mock.calls.at(-1)?.[1] ?? '{}'));
        expect(writtenCache.rateLimited).toBe(true);
        expect(writtenCache.rateLimitedCount).toBe(1);
        expect(writtenCache.error).toBe(false);
        expect(writtenCache.errorReason).toBe('rate_limited');
        expect(writtenCache.rateLimitedUntil - writtenCache.timestamp).toBe(60_000);
        vi.useRealTimers();
    });
    it('increases 429 backoff exponentially up to the configured ceiling', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
        mockedExistsSync.mockImplementation((path) => {
            const file = String(path);
            return file.endsWith('settings.json') || file.endsWith('.usage-cache-zai.json');
        });
        mockedReadFileSync.mockImplementation((path) => {
            const file = String(path);
            if (file.endsWith('settings.json')) {
                return JSON.stringify({
                    omcHud: {
                        usageApiPollIntervalMs: 60_000,
                    },
                });
            }
            if (file.endsWith('.usage-cache-zai.json')) {
                return JSON.stringify({
                    timestamp: Date.now() - 300_000,
                    rateLimitedUntil: Date.now() - 1,
                    rateLimited: true,
                    rateLimitedCount: 4,
                    source: 'zai',
                    data: null,
                });
            }
            return '{}';
        });
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 429;
                callback(res);
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result.error).toBe('rate_limited');
        const writtenCache = JSON.parse(String(mockedWriteFileSync.mock.calls.at(-1)?.[1] ?? '{}'));
        expect(writtenCache.rateLimitedCount).toBe(5);
        expect(writtenCache.rateLimitedUntil - writtenCache.timestamp).toBe(300_000);
        vi.useRealTimers();
    });
    it('reuses transient network failure cache to avoid immediate retry hammering without stale data', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
        process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
        const mockedExistsSync = vi.mocked(fs.existsSync);
        const mockedReadFileSync = vi.mocked(fs.readFileSync);
        mockedExistsSync.mockImplementation((path) => {
            const file = String(path);
            return file.endsWith('settings.json') || file.endsWith('.usage-cache-zai.json');
        });
        mockedReadFileSync.mockImplementation((path) => {
            const file = String(path);
            if (file.endsWith('settings.json')) {
                return JSON.stringify({
                    omcHud: {
                        usageApiPollIntervalMs: 60_000,
                    },
                });
            }
            if (file.endsWith('.usage-cache-zai.json')) {
                return JSON.stringify({
                    timestamp: Date.now() - 90_000,
                    source: 'zai',
                    data: null,
                    error: true,
                    errorReason: 'network',
                });
            }
            return '{}';
        });
        const result = await getUsage();
        expect(result).toEqual({ rateLimits: null, error: 'network' });
        expect(httpsModule.default.request).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
describe('isMinimaxHost', () => {
    it('accepts exact minimax.io hostname', () => {
        expect(isMinimaxHost('https://minimax.io')).toBe(true);
        expect(isMinimaxHost('https://minimax.io/')).toBe(true);
        expect(isMinimaxHost('https://minimax.io/v1')).toBe(true);
    });
    it('accepts subdomains of minimax.io', () => {
        expect(isMinimaxHost('https://api.minimax.io')).toBe(true);
        expect(isMinimaxHost('https://api.minimax.io/anthropic')).toBe(true);
        expect(isMinimaxHost('https://foo.bar.minimax.io')).toBe(true);
    });
    it('accepts minimaxi.com (China endpoint)', () => {
        expect(isMinimaxHost('https://minimaxi.com')).toBe(true);
        expect(isMinimaxHost('https://api.minimaxi.com')).toBe(true);
        expect(isMinimaxHost('https://api.minimaxi.com/anthropic')).toBe(true);
    });
    it('accepts minimax.com (China alternative)', () => {
        expect(isMinimaxHost('https://minimax.com')).toBe(true);
        expect(isMinimaxHost('https://api.minimax.com')).toBe(true);
        expect(isMinimaxHost('https://api.minimax.com/anthropic')).toBe(true);
    });
    it('rejects hosts that merely contain minimax as substring', () => {
        expect(isMinimaxHost('https://minimax.io.evil.tld')).toBe(false);
        expect(isMinimaxHost('https://notminimax.io')).toBe(false);
        expect(isMinimaxHost('https://minimax.io.example.com')).toBe(false);
        expect(isMinimaxHost('https://minimaxi.com.evil.tld')).toBe(false);
    });
    it('rejects unrelated hosts', () => {
        expect(isMinimaxHost('https://api.anthropic.com')).toBe(false);
        expect(isMinimaxHost('https://z.ai')).toBe(false);
        expect(isMinimaxHost('https://localhost:8080')).toBe(false);
    });
    it('rejects invalid URLs gracefully', () => {
        expect(isMinimaxHost('')).toBe(false);
        expect(isMinimaxHost('not-a-url')).toBe(false);
        expect(isMinimaxHost('://missing-protocol')).toBe(false);
    });
    it('is case-insensitive', () => {
        expect(isMinimaxHost('https://MINIMAX.IO/v1')).toBe(true);
        expect(isMinimaxHost('https://API.MINIMAX.IO')).toBe(true);
    });
});
describe('parseMinimaxResponse', () => {
    it('returns null for empty response', () => {
        expect(parseMinimaxResponse({})).toBeNull();
        expect(parseMinimaxResponse({ model_remains: [] })).toBeNull();
    });
    it('returns null when base_resp.status_code is non-zero', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'MiniMax-M1',
                    current_interval_total_count: 1500,
                    current_interval_usage_count: 750,
                    start_time: Date.now(),
                    end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 15000,
                    current_weekly_usage_count: 7500,
                    weekly_start_time: Date.now(),
                    weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
            base_resp: { status_code: 1001, status_msg: 'error' },
        };
        expect(parseMinimaxResponse(response)).toBeNull();
    });
    it('returns null when no MiniMax-M* model exists', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'speech-hd',
                    current_interval_total_count: 100,
                    current_interval_usage_count: 50,
                    start_time: Date.now(),
                    end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 700,
                    current_weekly_usage_count: 350,
                    weekly_start_time: Date.now(),
                    weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
        };
        expect(parseMinimaxResponse(response)).toBeNull();
    });
    it('parses MiniMax-M* remaining counts as used fiveHourPercent and weeklyPercent', () => {
        const endTime = Date.now() + 3600_000;
        const weeklyEndTime = Date.now() + 86400_000 * 3;
        const response = {
            model_remains: [
                {
                    model_name: 'MiniMax-M2.7',
                    current_interval_total_count: 1500,
                    current_interval_usage_count: 84,
                    start_time: Date.now(),
                    end_time: endTime,
                    remains_time: 3600_000,
                    current_weekly_total_count: 15000,
                    current_weekly_usage_count: 3,
                    weekly_start_time: Date.now(),
                    weekly_end_time: weeklyEndTime,
                    weekly_remains_time: 86400_000 * 3,
                },
            ],
        };
        const result = parseMinimaxResponse(response);
        expect(result).not.toBeNull();
        // Remaining 84 of 1500 means 1416 used => 94.4%
        expect(result.fiveHourPercent).toBeCloseTo(94.4, 1);
        // Remaining 3 of 15000 means 14997 used => 99.98%
        expect(result.weeklyPercent).toBeCloseTo(99.98, 1);
        expect(result.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.fiveHourResetsAt.getTime()).toBe(endTime);
        expect(result.weeklyResetsAt).toBeInstanceOf(Date);
        expect(result.weeklyResetsAt.getTime()).toBe(weeklyEndTime);
    });
    it('shows low usage when most MiniMax quota remains', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'MiniMax-M1',
                    current_interval_total_count: 1500,
                    current_interval_usage_count: 1495,
                    start_time: Date.now(),
                    end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 15000,
                    current_weekly_usage_count: 14530,
                    weekly_start_time: Date.now(),
                    weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
        };
        const result = parseMinimaxResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBeCloseTo((5 / 1500) * 100, 3);
        expect(result.weeklyPercent).toBeCloseTo((470 / 15000) * 100, 3);
    });
    it('handles division by zero when total_count is 0', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'MiniMax-M1',
                    current_interval_total_count: 0,
                    current_interval_usage_count: 0,
                    start_time: Date.now(),
                    end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 0,
                    current_weekly_usage_count: 0,
                    weekly_start_time: Date.now(),
                    weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
        };
        const result = parseMinimaxResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(0);
        expect(result.weeklyPercent).toBe(0);
    });
    it('uses first MiniMax-M* model when multiple exist', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'speech-hd',
                    current_interval_total_count: 100,
                    current_interval_usage_count: 0,
                    start_time: Date.now(), end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 700, current_weekly_usage_count: 0,
                    weekly_start_time: Date.now(), weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
                {
                    model_name: 'MiniMax-M2.7',
                    current_interval_total_count: 1500,
                    current_interval_usage_count: 750,
                    start_time: Date.now(), end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 15000, current_weekly_usage_count: 7500,
                    weekly_start_time: Date.now(), weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
                {
                    model_name: 'MiniMax-M1',
                    current_interval_total_count: 1000,
                    current_interval_usage_count: 800,
                    start_time: Date.now(), end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 10000, current_weekly_usage_count: 8000,
                    weekly_start_time: Date.now(), weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
        };
        const result = parseMinimaxResponse(response);
        expect(result).not.toBeNull();
        // Should use MiniMax-M2.7 (first MiniMax-M* match): 750 used out of 1500 => 50%
        expect(result.fiveHourPercent).toBe(50);
        expect(result.weeklyPercent).toBe(50);
    });
    it('succeeds when base_resp.status_code is 0', () => {
        const response = {
            model_remains: [
                {
                    model_name: 'MiniMax-M1',
                    current_interval_total_count: 100,
                    current_interval_usage_count: 50,
                    start_time: Date.now(), end_time: Date.now() + 3600_000,
                    remains_time: 3600_000,
                    current_weekly_total_count: 700, current_weekly_usage_count: 350,
                    weekly_start_time: Date.now(), weekly_end_time: Date.now() + 86400_000,
                    weekly_remains_time: 86400_000,
                },
            ],
            base_resp: { status_code: 0, status_msg: 'success' },
        };
        const result = parseMinimaxResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(50);
    });
});
describe('getUsage routing - minimax', () => {
    const originalEnv = { ...process.env };
    let httpsModule;
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.readFileSync).mockReturnValue('{}');
        vi.mocked(childProcess.execSync).mockImplementation(() => { throw new Error('mock: no keychain'); });
        vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw new Error('mock: no keychain'); });
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        delete process.env.MINIMAX_API_KEY;
        httpsModule = await import('https');
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });
    it('routes to minimax when ANTHROPIC_BASE_URL is minimax host with MINIMAX_API_KEY', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.MINIMAX_API_KEY = 'test-minimax-key';
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('network');
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        const callArgs = httpsModule.default.request.mock.calls[0][0];
        expect(callArgs.hostname).toBe('api.minimax.io');
        expect(callArgs.path).toBe('/v1/api/openplatform/coding_plan/remains');
        expect(callArgs.headers.Authorization).toBe('Bearer test-minimax-key');
    });
    it('falls back to ANTHROPIC_AUTH_TOKEN when MINIMAX_API_KEY is not set', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token';
        const result = await getUsage();
        expect(result.error).toBe('network');
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        const callArgs = httpsModule.default.request.mock.calls[0][0];
        expect(callArgs.hostname).toBe('api.minimax.io');
        expect(callArgs.headers.Authorization).toBe('Bearer test-auth-token');
    });
    it('returns no_credentials when minimax host detected but no API key', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        // Neither MINIMAX_API_KEY nor ANTHROPIC_AUTH_TOKEN set
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('no_credentials');
        expect(httpsModule.default.request).not.toHaveBeenCalled();
    });
    it('does NOT route to minimax for look-alike hosts', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://minimax.io.evil.tld/v1';
        process.env.MINIMAX_API_KEY = 'test-key';
        const result = await getUsage();
        expect(result.rateLimits).toBeNull();
        expect(result.error).toBe('no_credentials');
        expect(httpsModule.default.request).not.toHaveBeenCalled();
    });
    it('returns parsed rate limits on successful API response (E2E happy path)', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.MINIMAX_API_KEY = 'test-key';
        const endTime = Date.now() + 3600_000;
        const weeklyEndTime = Date.now() + 86400_000 * 3;
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    model_remains: [
                        {
                            model_name: 'MiniMax-M2.7',
                            current_interval_total_count: 1500,
                            current_interval_usage_count: 750,
                            start_time: Date.now(),
                            end_time: endTime,
                            remains_time: 3600_000,
                            current_weekly_total_count: 15000,
                            current_weekly_usage_count: 12000,
                            weekly_start_time: Date.now(),
                            weekly_end_time: weeklyEndTime,
                            weekly_remains_time: 86400_000 * 3,
                        },
                    ],
                    base_resp: { status_code: 0, status_msg: 'success' },
                }));
                res.emit('end');
            };
            return req;
        });
        const result = await getUsage();
        expect(result.rateLimits).not.toBeNull();
        expect(result.rateLimits.fiveHourPercent).toBe(50); // (1500 - 750) / 1500
        expect(result.rateLimits.weeklyPercent).toBe(20); // (15000 - 12000) / 15000
        expect(result.rateLimits.fiveHourResetsAt).toBeInstanceOf(Date);
        expect(result.rateLimits.fiveHourResetsAt.getTime()).toBe(endTime);
        expect(result.rateLimits.weeklyResetsAt).toBeInstanceOf(Date);
        expect(result.rateLimits.weeklyResetsAt.getTime()).toBe(weeklyEndTime);
        expect(result.error).toBeUndefined();
    });
    it('prefers MINIMAX_API_KEY over ANTHROPIC_AUTH_TOKEN', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.MINIMAX_API_KEY = 'preferred-key';
        process.env.ANTHROPIC_AUTH_TOKEN = 'fallback-key';
        await getUsage();
        expect(httpsModule.default.request).toHaveBeenCalledTimes(1);
        const callArgs = httpsModule.default.request.mock.calls[0][0];
        expect(callArgs.headers.Authorization).toBe('Bearer preferred-key');
    });
    it('writes cache with source minimax', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.MINIMAX_API_KEY = 'test-key';
        httpsModule.default.request.mockImplementationOnce((_options, callback) => {
            const req = new EventEmitter();
            req.destroy = vi.fn();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', JSON.stringify({
                    model_remains: [
                        {
                            model_name: 'MiniMax-M1',
                            current_interval_total_count: 100,
                            current_interval_usage_count: 50,
                            start_time: Date.now(), end_time: Date.now() + 3600_000,
                            remains_time: 3600_000,
                            current_weekly_total_count: 700, current_weekly_usage_count: 350,
                            weekly_start_time: Date.now(), weekly_end_time: Date.now() + 86400_000,
                            weekly_remains_time: 86400_000,
                        },
                    ],
                    base_resp: { status_code: 0, status_msg: 'success' },
                }));
                res.emit('end');
            };
            return req;
        });
        await getUsage();
        const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).includes('.usage-cache-minimax.json'));
        expect(writeCall).toBeTruthy();
        const written = JSON.parse(String(writeCall[1]));
        expect(written.source).toBe('minimax');
        expect(written.data.fiveHourPercent).toBe(50);
    });
});
//# sourceMappingURL=usage-api.test.js.map