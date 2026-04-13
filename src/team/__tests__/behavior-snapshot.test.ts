import { describe, it, expect } from 'vitest';
import { resolveRoleAssignment, buildResolvedRoutingSnapshot } from '../stage-router.js';
import { CANONICAL_TEAM_ROLES } from '../../shared/types.js';
import type { CanonicalTeamRole, PluginConfig, RoleAssignment } from '../../shared/types.js';

/**
 * AC-3: With empty `team.roleRouting`, snapshot must mirror pre-patch behavior:
 * - Every role resolves to provider='claude'
 * - Models match the role's tier-default (claude-only world)
 * - Agents match the canonical role→agent map
 * - Snapshot is a pure function of config (no env/IO surprises)
 */
describe('AC-3: behavior snapshot — empty config preserves pre-patch /team semantics', () => {
  const EMPTY: PluginConfig = {};

  it('every canonical role resolves to provider=claude when no routing is configured', () => {
    for (const role of CANONICAL_TEAM_ROLES) {
      const out = resolveRoleAssignment(role, EMPTY);
      expect(out.provider, `role=${role}`).toBe('claude');
    }
  });

  it('snapshot primary === fallback when no roles are externally routed', () => {
    const snap = buildResolvedRoutingSnapshot(EMPTY);
    for (const role of CANONICAL_TEAM_ROLES) {
      expect(snap[role].primary.provider).toBe('claude');
      expect(snap[role].fallback.provider).toBe('claude');
      expect(snap[role].primary.model).toBe(snap[role].fallback.model);
      expect(snap[role].primary.agent).toBe(snap[role].fallback.agent);
    }
  });

  it('snapshot is deterministic — same empty config produces equal output across calls', () => {
    const a = buildResolvedRoutingSnapshot(EMPTY);
    const b = buildResolvedRoutingSnapshot(EMPTY);
    expect(a).toEqual(b);
  });

  it('snapshot is JSON-roundtrip safe (TeamConfig persistence requirement)', () => {
    const snap = buildResolvedRoutingSnapshot(EMPTY);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('orchestrator pinned to claude even when explicitly routed elsewhere (immutable invariant)', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { orchestrator: { model: 'HIGH' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap.orchestrator.primary.provider).toBe('claude');
    expect(snap.orchestrator.fallback.provider).toBe('claude');
  });

  it('externally-routed role keeps non-routed siblings on claude (per-role isolation)', () => {
    const cfg: PluginConfig = {
      team: { roleRouting: { critic: { provider: 'codex' } } },
    };
    const snap = buildResolvedRoutingSnapshot(cfg);
    expect(snap.critic.primary.provider).toBe('codex');
    // Siblings: every other role still claude
    for (const role of CANONICAL_TEAM_ROLES) {
      if (role === 'critic') continue;
      expect(snap[role].primary.provider, `sibling role=${role}`).toBe('claude');
    }
  });

  it('snapshot output shape matches RoleAssignment contract for every role', () => {
    const snap = buildResolvedRoutingSnapshot(EMPTY);
    for (const role of CANONICAL_TEAM_ROLES) {
      const primary: RoleAssignment = snap[role].primary;
      const fallback: RoleAssignment = snap[role].fallback;
      for (const r of [primary, fallback]) {
        expect(typeof r.provider).toBe('string');
        expect(typeof r.model).toBe('string');
        expect(r.model.length).toBeGreaterThan(0);
        expect(typeof r.agent).toBe('string');
        expect(r.agent.length).toBeGreaterThan(0);
      }
    }
  });

  it('snapshot covers exactly the canonical role set (no extras, no gaps)', () => {
    const snap = buildResolvedRoutingSnapshot(EMPTY);
    const snapKeys = Object.keys(snap).sort() as CanonicalTeamRole[];
    const canonical = [...CANONICAL_TEAM_ROLES].sort();
    expect(snapKeys).toEqual(canonical);
  });
});
