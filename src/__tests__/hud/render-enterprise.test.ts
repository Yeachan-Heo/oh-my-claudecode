/**
 * Tests for enterprise cost rendering in render.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG, type HudRenderContext, type HudConfig } from '../../hud/types.js';

// Mock git elements
vi.mock('../../hud/elements/git.js', () => ({
  renderGitRepo: vi.fn(() => null),
  renderGitBranch: vi.fn(() => null),
  renderGitStatus: vi.fn(() => null),
}));

vi.mock('../../hud/elements/cwd.js', () => ({
  renderCwd: vi.fn(() => null),
}));

// Strip ANSI codes for readable assertions
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function createContext(overrides: Partial<HudRenderContext> = {}): HudRenderContext {
  return {
    contextPercent: 30,
    modelName: 'claude-sonnet-4-5',
    ralph: null,
    ultrawork: null,
    prd: null,
    autopilot: null,
    activeAgents: [],
    todos: [],
    backgroundTasks: [],
    cwd: '/home/user/project',
    lastSkill: null,
    rateLimitsResult: null,
    customBuckets: null,
    pendingPermission: null,
    thinkingState: null,
    sessionHealth: null,
    omcVersion: null,
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

function createConfig(overrides: Partial<HudConfig['elements']> = {}): HudConfig {
  return {
    ...DEFAULT_HUD_CONFIG,
    elements: {
      ...DEFAULT_HUD_CONFIG.elements,
      omcLabel: false,
      rateLimits: false,
      ralph: false,
      autopilot: false,
      prdStory: false,
      activeSkills: false,
      contextBar: false,
      agents: false,
      backgroundTasks: false,
      todos: false,
      promptTime: false,
      sessionHealth: false,
      showCallCounts: false,
      thinking: false,
      ...overrides,
    },
  };
}

describe('render - enterprise cost branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders spent:$ when subscriptionType is enterprise and enterpriseSpentUsd is set', async () => {
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          enterpriseSpentUsd: 3323.93,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
        stale: false,
      },
    });
    const config = createConfig({ showEnterpriseCost: true });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).toContain('spent:$3,323.93');
  });

  it('does NOT render tok: when enterprise cost renders successfully', async () => {
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          enterpriseSpentUsd: 100,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
      },
      lastRequestTokenUsage: { inputTokens: 1200, outputTokens: 340 },
    });
    const config = createConfig({ showTokens: true, showEnterpriseCost: true });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).not.toContain('tok:');
    expect(plain).toContain('spent:');
  });

  it('detects enterprise via rateLimitTier containing claude_zero', async () => {
    const context = createContext({
      rateLimitTier: 'default_claude_zero',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          enterpriseSpentUsd: 50,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
      },
    });
    const config = createConfig({ showEnterpriseCost: true });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).toContain('spent:$50.00');
  });

  it('falls back to token rendering when enterprise but no cost data (API error)', async () => {
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: null,
        error: 'network',
      },
      lastRequestTokenUsage: { inputTokens: 1200, outputTokens: 340 },
    });
    const config = createConfig({ showTokens: true, showEnterpriseCost: true });
    const output = await render(context, config);
    const plain = strip(output);
    // No cost data available → fall back to tokens
    expect(plain).toContain('tok:');
  });

  it('does not render enterprise cost when showEnterpriseCost is false', async () => {
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          enterpriseSpentUsd: 100,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
      },
    });
    const config = createConfig({ showEnterpriseCost: false });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).not.toContain('spent:');
  });

  it('does not render enterprise cost when enterpriseMode is forced false', async () => {
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          enterpriseSpentUsd: 100,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
      },
    });
    const config = createConfig({ enterpriseMode: false });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).not.toContain('spent:');
  });

  it('suppresses 5h/wk rate-limit display when enterprise cost data is present', async () => {
    // Regression: enterprise API returns five_hour: null, so clamp(null) produced
    // fiveHourPercent: 0 which rendered a misleading "5h:0% wk:0%" alongside the cost.
    const context = createContext({
      subscriptionType: 'enterprise',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 0,
          weeklyPercent: 0,
          enterpriseSpentUsd: 3323.93,
          enterpriseLimitUsd: null,
          enterpriseCurrency: 'USD',
        },
      },
    });
    const config = createConfig({
      rateLimits: true,
      showEnterpriseCost: true,
    });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).toContain('spent:$3,323.93');
    expect(plain).not.toMatch(/5h:\s*0%/);
    expect(plain).not.toMatch(/wk:\s*0%/);
  });

  it('still renders 5h/wk for non-enterprise users (no regression on Pro/Max)', async () => {
    const context = createContext({
      subscriptionType: 'pro',
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 45,
          weeklyPercent: 12,
        },
      },
    });
    const config = createConfig({ rateLimits: true });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).toMatch(/5h:\s*45%/);
  });

  it('renders token usage for non-enterprise user even with showEnterpriseCost: true', async () => {
    const context = createContext({
      subscriptionType: 'pro',
      lastRequestTokenUsage: { inputTokens: 1200, outputTokens: 340 },
    });
    const config = createConfig({ showTokens: true, showEnterpriseCost: true });
    const output = await render(context, config);
    const plain = strip(output);
    expect(plain).toContain('tok:');
    expect(plain).not.toContain('spent:');
  });
});
