import { describe, expect, it, vi } from 'vitest';
import { compareVersions } from '../features/auto-update.js';
import { render } from '../hud/render.js';
import { DEFAULT_HUD_CONFIG } from '../hud/types.js';
import type { HudRenderContext, HudConfig } from '../hud/types.js';

vi.mock('../lib/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/version.js')>()),
  isRuntimePackageLocal: () => true,
}));

function createMinimalContext(overrides: Partial<HudRenderContext> = {}): HudRenderContext {
  return {
    contextPercent: 30,
    modelName: 'claude-sonnet-4.6',
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

function createMinimalConfig(overrides: Partial<HudConfig['elements']> = {}): HudConfig {
  return {
    ...DEFAULT_HUD_CONFIG,
    elements: {
      ...DEFAULT_HUD_CONFIG.elements,
      omcLabel: true,
      rateLimits: false,
      ralph: false,
      autopilot: false,
      prdStory: false,
      activeSkills: false,
      lastSkill: false,
      contextBar: false,
      agents: false,
      backgroundTasks: false,
      todos: false,
      permissionStatus: false,
      thinking: false,
      sessionHealth: false,
      ...overrides,
    },
  };
}

describe('issue #3867 4.15.7L update display', () => {
  it('treats 4.15.7 as older than the supported 5.0.0 channel', () => {
    expect(compareVersions('4.15.7', '5.0.0')).toBeLessThan(0);
    expect(compareVersions('5.0.0', '4.15.7')).toBeGreaterThan(0);
  });

  it('still ranks a leaked HUD L suffix below 5.0.0', () => {
    expect(compareVersions('4.15.7L', '5.0.0')).toBeLessThan(0);
    expect(compareVersions('4.15.7L', '4.15.7')).toBe(0);
  });

  it('renders HUD L as display-only while still showing a 5.0.0 update arrow', async () => {
    const ctx = createMinimalContext({
      omcVersion: '4.15.7',
      updateAvailable: '5.0.0',
    });
    const output = await render(ctx, createMinimalConfig());
    expect(output).toContain('[OMC#4.15.7L]');
    expect(output).toContain('-> 5.0.0');
    expect(output).toContain('omc update');
  });

  it('does not invent an L-suffixed package version in the update arrow', async () => {
    const ctx = createMinimalContext({
      omcVersion: '4.15.7',
      updateAvailable: '5.0.0',
    });
    const output = await render(ctx, createMinimalConfig());
    expect(output).not.toContain('-> 5.0.0L');
    expect(output).not.toContain('#4.15.7L ->');
  });
});
