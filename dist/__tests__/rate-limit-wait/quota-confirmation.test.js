import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const boundary = vi.hoisted(() => ({
    check: vi.fn(),
    resume: vi.fn(() => true),
    scan: vi.fn(),
    revalidate: vi.fn(),
}));
vi.mock('../../features/rate-limit-wait/rate-limit-monitor.js', async (importOriginal) => ({
    ...await importOriginal(),
    checkRateLimitStatus: boundary.check,
}));
vi.mock('../../features/rate-limit-wait/tmux-detector.js', async (importOriginal) => ({
    ...await importOriginal(),
    isTmuxAvailable: () => true,
    scanForBlockedPanes: boundary.scan,
    revalidateBlockedPanes: boundary.revalidate,
    sendResumeSequence: boundary.resume,
}));
import { pollLoop } from '../../features/rate-limit-wait/daemon.js';
import { getUsageProfileHash, shouldResumeBlockedPanesOnStatusChange } from '../../features/rate-limit-wait/daemon-state.js';
function currentUsageProfileHash() {
    return getUsageProfileHash();
}
function status(limited, degraded = false) {
    return {
        fiveHourLimited: limited, weeklyLimited: false, monthlyLimited: false, isLimited: limited,
        fiveHourResetsAt: null, weeklyResetsAt: null, monthlyResetsAt: null,
        nextResetAt: null, timeUntilResetMs: null, lastCheckedAt: new Date(),
        ...(degraded ? { apiErrorReason: 'rate_limited', usingStaleData: true } : {}),
    };
}
function staleNetworkStatus(limited) {
    return { ...status(limited), apiErrorReason: 'network', usingStaleData: true };
}
function blockedPane(overrides = {}) {
    return {
        id: '%test', session: 'isolated', windowIndex: 0, windowName: 'test', paneIndex: 0,
        isActive: false, firstDetectedAt: new Date(),
        analysis: { hasClaudeCode: true, hasRateLimitMessage: true, isBlocked: true, confidence: 1 },
        resumeAttempted: false,
        ...overrides,
    };
}
describe('confirmed quota transitions in the actual daemon polling loop', () => {
    let root;
    let config;
    let listeners;
    let originalConfigDir;
    let originalOAuthToken;
    let originalBaseUrl;
    let originalAuthToken;
    let originalAnthropicApiKey;
    let originalMinimaxApiKey;
    let originalKimiApiKey;
    beforeEach(() => {
        vi.useFakeTimers();
        boundary.check.mockReset();
        boundary.resume.mockClear();
        boundary.scan.mockReset();
        boundary.scan.mockReturnValue([blockedPane()]);
        boundary.revalidate.mockReset();
        boundary.revalidate.mockReturnValue([blockedPane()]);
        originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
        originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
        originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
        originalMinimaxApiKey = process.env.MINIMAX_API_KEY;
        originalKimiApiKey = process.env.KIMI_API_KEY;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.MINIMAX_API_KEY;
        delete process.env.KIMI_API_KEY;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-profile-token';
        root = mkdtempSync(join(tmpdir(), 'omc-quota-confirmation-'));
        config = { pollIntervalMs: 1000, paneLinesToCapture: 15, verbose: false,
            stateFilePath: join(root, 'state.json'), pidFilePath: join(root, 'pid'), logFilePath: join(root, 'log') };
        const events = ['SIGINT', 'SIGTERM', 'exit'];
        listeners = new Map(events.map(event => [event,
            event === 'exit' ? process.listeners('exit') : process.listeners(event),
        ]));
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        if (originalConfigDir === undefined)
            delete process.env.CLAUDE_CONFIG_DIR;
        else
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        if (originalOAuthToken === undefined)
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else
            process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        if (originalBaseUrl === undefined)
            delete process.env.ANTHROPIC_BASE_URL;
        else
            process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
        if (originalAuthToken === undefined)
            delete process.env.ANTHROPIC_AUTH_TOKEN;
        else
            process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
        if (originalAnthropicApiKey === undefined)
            delete process.env.ANTHROPIC_API_KEY;
        else
            process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
        if (originalMinimaxApiKey === undefined)
            delete process.env.MINIMAX_API_KEY;
        else
            process.env.MINIMAX_API_KEY = originalMinimaxApiKey;
        if (originalKimiApiKey === undefined)
            delete process.env.KIMI_API_KEY;
        else
            process.env.KIMI_API_KEY = originalKimiApiKey;
        for (const [event, original] of listeners) {
            for (const listener of (event === 'exit' ? process.listeners('exit') : process.listeners(event))) {
                if (!original.includes(listener))
                    process.removeListener(event, listener);
            }
        }
        rmSync(root, { recursive: true, force: true });
    });
    function seed(previous, flag) {
        const state = { isRunning: true, pid: null, startedAt: new Date(), lastPollAt: null,
            rateLimitStatus: previous, blockedPanes: [{ id: '%test', session: 'isolated', windowIndex: 0,
                    windowName: 'test', paneIndex: 0, isActive: false, firstDetectedAt: new Date(),
                    analysis: { hasClaudeCode: true, hasRateLimitMessage: true, isBlocked: true, confidence: 1 },
                    resumeAttempted: false }], resumedPaneIds: [], totalResumeAttempts: 0,
            successfulResumes: 0, errorCount: 0,
            usageProfileHash: currentUsageProfileHash(),
            ...(flag === undefined ? {} : { lastConfirmedLimited: flag }) };
        writeFileSync(config.stateFilePath, JSON.stringify(state));
    }
    function observed() {
        return JSON.parse(readFileSync(config.stateFilePath, 'utf8'));
    }
    function setStoredOAuthCredentials(accountId, accessToken, refreshToken) {
        const profileDir = join(root, 'claude-profile');
        mkdirSync(profileDir, { recursive: true });
        process.env.CLAUDE_CONFIG_DIR = profileDir;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        writeFileSync(join(profileDir, '.credentials.json'), JSON.stringify({
            claudeAiOauth: {
                accessToken,
                refreshToken,
                expiresAt: Date.now() + 60_000,
                oauthAccount: { uuid: accountId, emailAddress: `${accountId}@example.test` },
            },
        }));
    }
    async function start(sample) {
        boundary.check.mockResolvedValue(sample);
        // Run bounded iterations; cleanup cancels the loop's pending fake timer.
        void pollLoop(config);
        await vi.advanceTimersByTimeAsync(0);
    }
    async function next(sample) {
        boundary.check.mockResolvedValue(sample);
        await vi.advanceTimersByTimeAsync(1000);
    }
    it('requires a non-null confirmed all-clear at the public transition boundary', () => {
        expect(shouldResumeBlockedPanesOnStatusChange(status(true), null)).toBe(false);
        expect(shouldResumeBlockedPanesOnStatusChange(status(true), status(false, true))).toBe(false);
        expect(shouldResumeBlockedPanesOnStatusChange(status(true), status(false))).toBe(true);
    });
    it('preserves limited history through unavailable and degraded samples, including restart', async () => {
        seed(status(true));
        await start(null);
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().rateLimitStatus).toBeNull();
        expect(observed().lastConfirmedLimited).toBe(true);
        await next(status(false, true));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().rateLimitStatus?.apiErrorReason).toBe('rate_limited');
        expect(observed().lastConfirmedLimited).toBe(true);
        // Simulate restart using the actual persisted state; the old loop stays suspended.
        vi.clearAllTimers();
        await start(null);
        expect(boundary.resume).not.toHaveBeenCalled();
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
        expect(observed().successfulResumes).toBe(1);
        expect(observed().lastConfirmedLimited).toBe(false);
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledTimes(1);
    });
    it('preserves confirmed limited history through a degraded sample without an unavailable poll', async () => {
        seed(status(true));
        await start(status(false, true));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().rateLimitStatus?.apiErrorReason).toBe('rate_limited');
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('retains restored pane candidates through a limited poll with no new pane output', async () => {
        seed(status(true));
        boundary.scan.mockReturnValueOnce([]);
        await start(status(true));
        expect(observed().blockedPanes).toMatchObject([{ id: '%test' }]);
        expect(boundary.resume).not.toHaveBeenCalled();
        await next(status(false));
        expect(boundary.revalidate).toHaveBeenCalledOnce();
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('does not resume on stale cached clear after a network failure', async () => {
        seed(status(true));
        await start(staleNetworkStatus(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(true);
        expect(observed().rateLimitStatus?.usingStaleData).toBe(true);
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('does not resume a restored pane after its saved location has changed', async () => {
        seed(status(true));
        await start(null);
        boundary.revalidate.mockReturnValue([blockedPane({ session: 'reused-session' })]);
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().successfulResumes).toBe(0);
    });
    it('resumes a live pane after its window is renamed', async () => {
        seed(status(true));
        await start(null);
        boundary.revalidate.mockReturnValue([blockedPane({ windowName: 'renamed' })]);
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('retains panes after inconclusive revalidation and retries on the next clear poll', async () => {
        seed(status(true));
        await start(null);
        boundary.revalidate.mockReturnValueOnce(null).mockReturnValue([blockedPane()]);
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().blockedPanes).toHaveLength(1);
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
        expect(observed().blockedPanes).toEqual([]);
    });
    it('does not carry quota state across Claude config profiles', async () => {
        seed(status(true));
        process.env.CLAUDE_CONFIG_DIR = `${process.env.CLAUDE_CONFIG_DIR ?? ''}-other-profile`;
        await start(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(false);
        expect(observed().blockedPanes).toEqual([]);
        expect(observed().usageProfileHash).toBe(currentUsageProfileHash());
    });
    it('resets pane cursors when discarding legacy unscoped state', async () => {
        seed(status(true));
        const legacyState = observed();
        delete legacyState.usageProfileHash;
        writeFileSync(config.stateFilePath, JSON.stringify(legacyState));
        writeFileSync(join(root, 'pane-tail-positions.json'), JSON.stringify({ '%test': 100 }));
        await start(status(true));
        expect(JSON.parse(readFileSync(join(root, 'pane-tail-positions.json'), 'utf8'))).toEqual({});
        expect(boundary.scan).toHaveBeenCalledWith(15, root);
        expect(observed().blockedPanes).toHaveLength(1);
    });
    it('does not carry quota state across direct OAuth credential changes', async () => {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'profile-a-token';
        seed(status(true));
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'profile-b-token';
        await start(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(false);
        expect(observed().blockedPanes).toEqual([]);
        expect(observed().usageProfileHash).toBe(currentUsageProfileHash());
    });
    it('discards saved quota state when the stored OAuth account changes during polling', async () => {
        setStoredOAuthCredentials('account-a', 'access-a', 'refresh-a');
        seed(status(true));
        await start(null);
        expect(observed().lastConfirmedLimited).toBe(true);
        setStoredOAuthCredentials('account-b', 'access-b', 'refresh-b');
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(false);
        expect(observed().blockedPanes).toEqual([]);
        expect(observed().usageProfileHash).toBe(currentUsageProfileHash());
    });
    it('discards an all-clear fetched while the stored OAuth account changes', async () => {
        setStoredOAuthCredentials('account-a', 'access-a', 'refresh-a');
        seed(status(true));
        boundary.check.mockImplementationOnce(async () => {
            setStoredOAuthCredentials('account-b', 'access-b', 'refresh-b');
            return status(false);
        });
        void pollLoop(config);
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(boundary.revalidate).not.toHaveBeenCalled();
        expect(observed().rateLimitStatus).toBeNull();
        expect(observed().lastConfirmedLimited).toBe(false);
        expect(observed().blockedPanes).toEqual([]);
        expect(observed().usageProfileHash).toBe(currentUsageProfileHash());
    });
    it('preserves quota state when stored OAuth tokens rotate for the same account', async () => {
        setStoredOAuthCredentials('account-a', 'access-a', 'refresh-a');
        seed(status(true));
        await start(null);
        setStoredOAuthCredentials('account-a', 'access-a-rotated', 'refresh-a-rotated');
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('preserves recovery state while the stored credential identity is unavailable', async () => {
        setStoredOAuthCredentials('account-a', 'access-a', 'refresh-a');
        seed(status(true));
        const savedProfileHash = observed().usageProfileHash;
        rmSync(join(root, 'claude-profile', '.credentials.json'), { force: true });
        await start(status(false));
        expect(boundary.check).not.toHaveBeenCalled();
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(true);
        expect(observed().blockedPanes).toHaveLength(1);
        expect(observed().usageProfileHash).toBe(savedProfileHash);
        setStoredOAuthCredentials('account-a', 'access-a', 'refresh-a');
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('skips polls when Keychain is unavailable despite alternate file credentials', async () => {
        seed(status(true));
        const savedProfileHash = observed().usageProfileHash;
        const profileDir = join(root, 'claude-profile');
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, '.credentials.json'), JSON.stringify({
            claudeAiOauth: {
                accessToken: 'account-b-access',
                refreshToken: 'account-b-refresh',
                oauthAccount: { uuid: 'account-b' },
            },
        }));
        writeFileSync(join(profileDir, '.claude.json'), JSON.stringify({
            oauthAccount: { accountUuid: 'account-a' },
        }));
        process.env.CLAUDE_CONFIG_DIR = profileDir;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        try {
            await start(status(false));
        }
        finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        }
        expect(boundary.check).not.toHaveBeenCalled();
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(true);
        expect(observed().blockedPanes).toHaveLength(1);
        expect(observed().usageProfileHash).toBe(savedProfileHash);
    });
    it('discards quota state when the selected provider credential changes', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
        process.env.MINIMAX_API_KEY = 'provider-account-a';
        seed(status(true));
        await start(null);
        process.env.MINIMAX_API_KEY = 'provider-account-b';
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(false);
        expect(observed().blockedPanes).toEqual([]);
    });
    it('recovers through an initially stale limited sample', async () => {
        seed(null, false);
        await start(status(true, true));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().lastConfirmedLimited).toBe(true);
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('recovers legacy persisted stale limited status without the new flag', async () => {
        seed(status(true, true));
        await start(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
    it('does not trust a nonboolean flag when the last observation is unconfirmed', async () => {
        seed(status(false, true), 'true');
        await start(null);
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
    });
    it.each([null, status(false)])('does not resume without confirmed prior exhaustion: %j', async (previous) => {
        seed(previous);
        await start(null);
        await next(status(false));
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(observed().successfulResumes).toBe(0);
    });
    it('ignores nonboolean persisted flags and recovers legacy confirmed limited status', async () => {
        seed(status(true), 'false');
        await start(null);
        expect(boundary.resume).not.toHaveBeenCalled();
        await next(status(false));
        expect(boundary.resume).toHaveBeenCalledExactlyOnceWith('%test');
    });
});
//# sourceMappingURL=quota-confirmation.test.js.map