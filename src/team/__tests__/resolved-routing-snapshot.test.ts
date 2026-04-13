import { describe, it, expect } from 'vitest';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';
import { CANONICAL_TEAM_ROLES } from '../../shared/types.js';
import type { PluginConfig } from '../../shared/types.js';
import { CLAUDE_FAMILY_DEFAULTS, BUILTIN_EXTERNAL_MODEL_DEFAULTS } from '../../config/models.js';

type TeamRoleRoutingConfig = NonNullable<NonNullable<PluginConfig['team']>['roleRouting']>;

describe('buildResolvedRoutingSnapshot', () => {
  it('produces an entry for every canonical role', () => {
    const snap = buildResolvedRoutingSnapshot({});
    for (const role of CANONICAL_TEAM_ROLES) {
      expect(snap[role]).toBeDefined();
      expect(snap[role].primary).toBeDefined();
      expect(snap[role].fallback).toBeDefined();
    }
    expect(Object.keys(snap)).toHaveLength(CANONICAL_TEAM_ROLES.length);
  });

  it('fallback is always a Claude worker even for codex/gemini primaries', () => {
    const cfg: PluginConfig = {
      team: {
        roleRouting: {
          critic: { provider: 'codex', model: 'gpt-5.3-codex' },
          'code-reviewer': { provider: 'gemini' },
          executor: { provider: 'claude' },
        },
      },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap.critic.primary.provider).toBe('codex');
    expect(snap.critic.fallback.provider).toBe('claude');
    expect(snap['code-reviewer'].primary.provider).toBe('gemini');
    expect(snap['code-reviewer'].fallback.provider).toBe('claude');
    expect(snap.executor.primary.provider).toBe('claude');
    expect(snap.executor.fallback.provider).toBe('claude');
  });

  it('fallback shares the agent with primary', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { critic: { provider: 'codex', agent: 'analyst' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap.critic.primary.agent).toBe('analyst');
    expect(snap.critic.fallback.agent).toBe('analyst');
  });

  it('fallback resolves Claude tier model rather than echoing external model id', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { critic: { provider: 'codex', model: 'gpt-5.3-codex' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    // primary is the explicit codex model
    expect(snap.critic.primary.model).toBe('gpt-5.3-codex');
    // fallback is claude — must NOT echo the codex id; resolves to claude tier default for critic (HIGH = opus)
    expect(snap.critic.fallback.model).toBe(CLAUDE_FAMILY_DEFAULTS.OPUS);
  });

  it('fallback respects tier when primary spec uses a tier name', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { executor: { provider: 'codex', model: 'HIGH' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    // primary on codex: tier maps to codex builtin (tiers are claude-centric)
    expect(snap.executor.primary.model).toBe(BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel);
    // fallback on claude with same tier "HIGH" → claude opus
    expect(snap.executor.fallback.model).toBe(CLAUDE_FAMILY_DEFAULTS.OPUS);
  });

  it('orchestrator primary AND fallback are both claude (provider pinned)', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { orchestrator: { model: 'HIGH' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap.orchestrator.primary.provider).toBe('claude');
    expect(snap.orchestrator.fallback.provider).toBe('claude');
    expect(snap.orchestrator.primary.agent).toBe('omc');
  });

  it('snapshot is a plain object — JSON-roundtrip-safe for TeamConfig persistence', () => {
    const cfg: PluginConfig = {
      team: {
        roleRouting: {
          critic: { provider: 'codex' },
          executor: { provider: 'claude', model: 'MEDIUM' },
        },
      },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    const roundtripped = JSON.parse(JSON.stringify(snap));
    expect(roundtripped).toEqual(snap);
  });

  it('snapshot is stable: two calls with same cfg produce equal results (immutability requirement)', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { critic: { provider: 'codex' } } },
    };
    const a = buildResolvedRoutingSnapshot(cfg);
    const b = buildResolvedRoutingSnapshot(cfg);
    expect(a).toEqual(b);
  });

  it('applies accepted alias keys when building the persisted snapshot', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { reviewer: { provider: 'gemini' } } as TeamRoleRoutingConfig },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap['code-reviewer'].primary.provider).toBe('gemini');
    expect(snap['code-reviewer'].fallback.provider).toBe('claude');
  });
});
