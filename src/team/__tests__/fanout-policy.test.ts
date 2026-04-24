import { describe, expect, it } from 'vitest';
import { normalizeMaxWorkers, resolveTeamFanout } from '../fanout-policy.js';

describe('resolveTeamFanout', () => {
  it('caps active fanout using existing team.ops.maxAgents', () => {
    expect(resolveTeamFanout(4, { maxAgents: 2 })).toEqual({
      requested: 4,
      effective: 2,
      capped: true,
    });
  });

  it('leaves fanout unchanged when maxAgents is absent', () => {
    expect(resolveTeamFanout(3, undefined)).toEqual({
      requested: 3,
      effective: 3,
      capped: false,
    });
  });
});

describe('normalizeMaxWorkers', () => {
  it('accepts positive integer max worker counts', () => {
    expect(normalizeMaxWorkers(2)).toBe(2);
  });

  it('ignores invalid persisted max worker counts', () => {
    expect(normalizeMaxWorkers(0)).toBeUndefined();
    expect(normalizeMaxWorkers(2.5)).toBeUndefined();
    expect(normalizeMaxWorkers('2')).toBeUndefined();
  });
});
