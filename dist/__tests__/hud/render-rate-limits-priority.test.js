/**
 * Tests for render.ts rate limits display priority.
 *
 * When both error and rateLimits data exist (e.g., 429 with stale data),
 * data should be displayed instead of error indicator.
 */
import { describe, it, expect, vi } from 'vitest';
// Mock git-related modules to avoid filesystem access during render
vi.mock('../../hud/elements/git.js', () => ({
    renderGitRepo: () => null,
    renderGitBranch: () => null,
}));
vi.mock('../../hud/elements/cwd.js', () => ({
    renderCwd: () => null,
}));
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';
function makeContext(overrides = {}) {
    return {
        contextPercent: 50,
        modelName: 'opus',
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: '/tmp/test',
        lastSkill: null,
        rateLimitsResult: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: null,
        omcVersion: '4.7.0',
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        promptTime: null,
        apiKeySource: null,
        profileName: null,
        sessionSummary: null,
        ...overrides,
    };
}
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
function makeConfig(overrides = {}) {
    return {
        ...DEFAULT_HUD_CONFIG,
        elements: {
            ...DEFAULT_HUD_CONFIG.elements,
            rateLimits: true,
            omcLabel: false,
            contextBar: false,
            agents: false,
            backgroundTasks: false,
            todos: false,
            activeSkills: false,
            lastSkill: false,
            sessionHealth: false,
            promptTime: false,
            showCallCounts: false,
        },
        ...overrides,
    };
}
describe('render: rate limits display priority', () => {
    it('shows data when error=rate_limited but rateLimits data exists', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: { fiveHourPercent: 45, weeklyPercent: 20 },
                error: 'rate_limited',
            },
        });
        const output = await render(context, makeConfig());
        // Should show percentage data, NOT [API 429]
        expect(output).toContain('45%');
        expect(output).not.toContain('[API 429]');
    });
    it('renders 5h/wk/sn rate limits when subscription info is unavailable', async () => {
        const context = makeContext({
            subscriptionType: null,
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 36,
                    weeklyPercent: 32,
                    sonnetWeeklyPercent: 8,
                },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('5h:');
        expect(output).toContain('36%');
        expect(output).toContain('wk:');
        expect(output).toContain('32%');
        expect(output).toContain('sn:');
        expect(output).toContain('8%');
    });
    it('renders exact Max 20x cache-shaped rate limits when legacy enterprise spend fields are present', async () => {
        const context = makeContext({
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 4,
                    weeklyPercent: 6,
                    enterpriseSpentUsd: 200.5,
                    enterpriseLimitUsd: 200,
                    enterpriseUtilization: 100,
                },
            },
        });
        const output = await render(context, makeConfig());
        const plain = stripAnsi(output);
        expect(plain.trim()).not.toBe('');
        expect(plain).toContain('5h:');
        expect(plain).toContain('4%');
        expect(plain).toContain('wk:');
        expect(plain).toContain('6%');
        expect(plain).not.toContain('spent:');
    });
    it('renders Max 20x 5h/wk/sn limits when enterprise spent exists but enterprise limit is null', async () => {
        const context = makeContext({
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 36,
                    weeklyPercent: 32,
                    sonnetWeeklyPercent: 8,
                    enterpriseSpentUsd: 12.34,
                    enterpriseLimitUsd: null,
                    enterpriseCurrency: 'USD',
                },
            },
        });
        const output = await render(context, makeConfig());
        const plain = stripAnsi(output);
        expect(plain.trim()).not.toBe('');
        expect(plain).toContain('5h:');
        expect(plain).toContain('36%');
        expect(plain).toContain('wk:');
        expect(plain).toContain('32%');
        expect(plain).toContain('sn:');
        expect(plain).toContain('8%');
        expect(plain).not.toContain('spent:');
    });
    it.each([
        ['zero', 0],
        ['negative', -1],
        ['null', null],
        ['undefined', undefined],
    ])('renders normal rate limits for Max-like responses with %s enterprise limit', async (_caseName, enterpriseLimitUsd) => {
        const context = makeContext({
            subscriptionType: 'max',
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 36,
                    weeklyPercent: 32,
                    sonnetWeeklyPercent: 8,
                    enterpriseSpentUsd: 12.34,
                    enterpriseLimitUsd,
                    enterpriseCurrency: 'USD',
                },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('5h:');
        expect(output).toContain('36%');
        expect(output).toContain('wk:');
        expect(output).toContain('32%');
        expect(output).toContain('sn:');
        expect(output).toContain('8%');
        expect(output).not.toContain('spent:');
    });
    it.each(['pro', 'max'])('renders normal 5h/wk limits for non-enterprise %s when enterprise spend is nonzero', async (subscriptionType) => {
        const context = makeContext({
            subscriptionType,
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 36,
                    weeklyPercent: 32,
                    enterpriseSpentUsd: 12.34,
                    enterpriseLimitUsd: 50,
                    enterpriseCurrency: 'USD',
                },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('5h:');
        expect(output).toContain('36%');
        expect(output).toContain('wk:');
        expect(output).toContain('32%');
        expect(output).not.toContain('spent:');
    });
    it.each(['pro', 'max'])('renders normal 5h/wk limits for non-enterprise %s when enterprise spend is zero', async (subscriptionType) => {
        const context = makeContext({
            subscriptionType,
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 10,
                    weeklyPercent: 2,
                    enterpriseSpentUsd: 0,
                    enterpriseLimitUsd: 50,
                    enterpriseCurrency: 'USD',
                },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('5h:');
        expect(output).toContain('10%');
        expect(output).toContain('wk:');
        expect(output).toContain('2%');
        expect(output).not.toContain('spent:');
    });
    it('renders enterprise cost only for actual enterprise with the same billing fields', async () => {
        const context = makeContext({
            subscriptionType: 'enterprise',
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 4,
                    weeklyPercent: 6,
                    enterpriseSpentUsd: 200.5,
                    enterpriseLimitUsd: 200,
                    enterpriseUtilization: 100,
                },
            },
        });
        const output = await render(context, makeConfig());
        const plain = stripAnsi(output);
        expect(plain).toContain('spent:');
        expect(plain).toContain('$200.50/$200.00');
        expect(plain).toContain('(100%)');
        expect(plain).not.toContain('5h:');
        expect(plain).not.toContain('wk:');
    });
    it('uses enterprise cost instead of double-rendering 5h/wk for actual enterprise zero spend', async () => {
        const context = makeContext({
            subscriptionType: 'enterprise',
            rateLimitTier: null,
            rateLimitsResult: {
                rateLimits: {
                    fiveHourPercent: 10,
                    weeklyPercent: 2,
                    enterpriseSpentUsd: 0,
                    enterpriseLimitUsd: 50,
                    enterpriseCurrency: 'USD',
                },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('spent:');
        expect(output).toContain('$0.00/$50.00');
        expect(output).not.toContain('5h:');
        expect(output).not.toContain('wk:');
    });
    it('shows [API 429] when error=rate_limited and rateLimits is null', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: null,
                error: 'rate_limited',
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('[API 429]');
    });
    it('shows [API err] when error=network and rateLimits is null', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: null,
                error: 'network',
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('[API err]');
    });
    it('shows stale cached data instead of [API err] when transient failures still have usage data', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: { fiveHourPercent: 61, weeklyPercent: 22 },
                error: 'network',
                stale: true,
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('61%');
        expect(output).toContain('*');
        expect(output).not.toContain('[API err]');
    });
    it('shows [API auth] when error=auth and rateLimits is null', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: null,
                error: 'auth',
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('[API auth]');
    });
    it('shows data normally when no error', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: { fiveHourPercent: 30, weeklyPercent: 10 },
            },
        });
        const output = await render(context, makeConfig());
        expect(output).toContain('30%');
        expect(output).not.toContain('[API');
    });
    it('shows nothing when error=no_credentials', async () => {
        const context = makeContext({
            rateLimitsResult: {
                rateLimits: null,
                error: 'no_credentials',
            },
        });
        const output = await render(context, makeConfig());
        expect(output).not.toContain('[API');
        expect(output).not.toContain('%');
    });
});
//# sourceMappingURL=render-rate-limits-priority.test.js.map