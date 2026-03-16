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
import type { HudRenderContext, HudConfig } from '../../hud/types.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';

function makeContext(overrides: Partial<HudRenderContext> = {}): HudRenderContext {
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

function makeConfig(overrides: Partial<HudConfig> = {}): HudConfig {
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
