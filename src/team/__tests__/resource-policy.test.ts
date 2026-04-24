import { describe, expect, it } from 'vitest';
import { estimateResourceWorkerCap, resolveTeamWorkerCount } from '../resource-policy.js';
import type { LocalResourceSnapshot } from '../resource-policy.js';

const baseSnapshot: LocalResourceSnapshot = {
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 8 * 1024 ** 3,
  loadAverage1m: 2,
  platform: 'darwin',
};

describe('team resource policy', () => {
  it('does not change requested workers when adaptiveAgents and maxAgents are unset', () => {
    const decision = resolveTeamWorkerCount(6, {}, {}, baseSnapshot);

    expect(decision.effective).toBe(6);
    expect(decision.capped).toBe(false);
    expect(decision.adaptiveEnabled).toBe(false);
    expect(decision.reason).toBe('requested');
  });

  it('honors maxAgents as a static cap even without adaptiveAgents', () => {
    const decision = resolveTeamWorkerCount(6, { maxAgents: 3 }, {}, baseSnapshot);

    expect(decision.effective).toBe(3);
    expect(decision.capped).toBe(true);
    expect(decision.reason).toContain('maxAgents=3');
  });

  it('caps requested workers by local CPU and memory when adaptiveAgents is enabled', () => {
    const constrained: LocalResourceSnapshot = {
      cpuCount: 4,
      totalMemoryBytes: 8 * 1024 ** 3,
      freeMemoryBytes: 3 * 1024 ** 3,
      loadAverage1m: 1,
      platform: 'darwin',
    };

    const decision = resolveTeamWorkerCount(
      8,
      { adaptiveAgents: true, resourceProfile: 'balanced' },
      {},
      constrained,
    );

    expect(decision.effective).toBe(1);
    expect(decision.resourceCap).toBe(1);
    expect(decision.capped).toBe(true);
    expect(decision.snapshot).toEqual(constrained);
  });

  it('never increases worker count above the user request', () => {
    const roomy: LocalResourceSnapshot = {
      cpuCount: 32,
      totalMemoryBytes: 128 * 1024 ** 3,
      freeMemoryBytes: 96 * 1024 ** 3,
      loadAverage1m: 1,
      platform: 'linux',
    };

    const decision = resolveTeamWorkerCount(
      2,
      { adaptiveAgents: true, resourceProfile: 'aggressive' },
      {},
      roomy,
    );

    expect(decision.effective).toBe(2);
    expect(decision.capped).toBe(false);
  });

  it('treats high load average as resource pressure on Unix-like platforms', () => {
    const cap = estimateResourceWorkerCap({
      cpuCount: 8,
      totalMemoryBytes: 32 * 1024 ** 3,
      freeMemoryBytes: 24 * 1024 ** 3,
      loadAverage1m: 12,
      platform: 'linux',
    }, 'balanced');

    expect(cap).toBe(4);
  });

  it('lets environment overrides win over config', () => {
    const decision = resolveTeamWorkerCount(
      5,
      { maxAgents: 5, adaptiveAgents: false, resourceProfile: 'aggressive' },
      {
        OMC_TEAM_MAX_AGENTS: '2',
        OMC_TEAM_ADAPTIVE_AGENTS: '1',
        OMC_TEAM_RESOURCE_PROFILE: 'conservative',
      } as NodeJS.ProcessEnv,
      baseSnapshot,
    );

    expect(decision.maxAgents).toBe(2);
    expect(decision.adaptiveEnabled).toBe(true);
    expect(decision.resourceProfile).toBe('conservative');
    expect(decision.effective).toBe(2);
  });

  it('ignores malformed environment overrides instead of partially parsing them', () => {
    const decision = resolveTeamWorkerCount(
      5,
      { maxAgents: 4, adaptiveAgents: true, resourceProfile: 'balanced' },
      {
        OMC_TEAM_MAX_AGENTS: '2abc',
        OMC_TEAM_ADAPTIVE_AGENTS: 'maybe',
        OMC_TEAM_RESOURCE_PROFILE: 'turbo',
      } as NodeJS.ProcessEnv,
      baseSnapshot,
    );

    expect(decision.maxAgents).toBe(4);
    expect(decision.adaptiveEnabled).toBe(true);
    expect(decision.resourceProfile).toBe('balanced');
    expect(decision.effective).toBe(4);
  });
});
