import { describe, it, expect, afterEach } from 'vitest';
import { TIER0_WORKFLOWS } from '../alias-resolver.js';
import {
  REGISTRY_OWNER,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_VERSION,
  TIER0_ROLES,
  RISK_CLASSES,
  HARD_RISK_CLASSES,
  RETIREMENT_POLICY,
  REMOVAL_MILESTONE,
  WORKFLOW_ENTRIES,
  WORKFLOW_ROLES,
  getEntry,
  getRole,
  resolveCanonical,
  isHardRisk,
  failModeForRisk,
  isRegistryEnabled,
  registryAliasLookup,
} from '../registry.js';

describe('workflow registry — Tier-0 contract', () => {
  it('defines exactly six Tier-0 workflows: plan, deep-interview, ralplan, execute, review, verify (owner direction #3708)', () => {
    expect([...TIER0_WORKFLOWS]).toEqual(['plan', 'deep-interview', 'ralplan', 'execute', 'review', 'verify']);
    const tier0 = WORKFLOW_ENTRIES.filter((e) => e.tier === 0);
    expect(tier0.map((e) => e.name).sort()).toEqual(['deep-interview', 'execute', 'plan', 'ralplan', 'review', 'verify']);
    expect(tier0.every((e) => e.decision === 'keep' && e.kind === 'skill')).toBe(true);
  });


  it('defines exactly four Tier-0 roles: planner, executor, reviewer, verifier', () => {
    expect([...TIER0_ROLES]).toEqual(['planner', 'executor', 'reviewer', 'verifier']);
    const tier0 = WORKFLOW_ROLES.filter((r) => r.tier === 0);
    expect(tier0.map((r) => r.name).sort()).toEqual(['executor', 'planner', 'reviewer', 'verifier']);
  });

  it('keeps every specialist role internal with a Tier-0 mapping', () => {
    const specialists = WORKFLOW_ROLES.filter((r) => r.tier !== 0);
    expect(specialists.length).toBeGreaterThan(0);
    for (const s of specialists) {
      expect(s.internalOnly).toBe(true);
      expect(s.tier0Role).toBeDefined();
      expect(TIER0_ROLES).toContain(s.tier0Role);
    }
    // Spot-check the plan's explicit mappings: architect/critic/code-reviewer -> reviewer
    expect(getRole('architect')?.tier0Role).toBe('reviewer');
    expect(getRole('critic')?.tier0Role).toBe('reviewer');
    expect(getRole('code-reviewer')?.tier0Role).toBe('reviewer');
    expect(getRole('test-engineer')?.tier0Role).toBe('verifier');
    expect(getRole('qa-tester')?.tier0Role).toBe('verifier');
  });
});

describe('workflow registry — risk classes and gate policy', () => {
  it('fails closed only for the five hard risk classes', () => {
    expect(HARD_RISK_CLASSES).toEqual([
      'secrets-privacy',
      'destructive-mutation',
      'release-authority',
      'corruption-integrity',
      'security-boundary',
    ]);
    expect(failModeForRisk('advisory')).toBe('fail-open');
    for (const rc of HARD_RISK_CLASSES) {
      expect(isHardRisk(rc)).toBe(true);
      expect(failModeForRisk(rc)).toBe('fail-closed');
    }
  });

  it('assigns a valid risk class and owner to every entry', () => {
    for (const e of WORKFLOW_ENTRIES) {
      expect(RISK_CLASSES).toContain(e.riskClass);
      expect(e.owner).toBe(REGISTRY_OWNER);
    }
  });

  it('classifies the graph skill as a security boundary', () => {
    const graph = getEntry('graph', 'skill');
    expect(graph?.riskClass).toBe('security-boundary');
    expect(graph?.decision).toBe('keep');
  });
});

describe('workflow registry — aliases and classification', () => {
  it('classifies all 38 installed skills and 21 installed commands exactly once', () => {
    const skills = WORKFLOW_ENTRIES.filter((e) => e.kind === 'skill' && !e.declaredOnly);
    const commands = WORKFLOW_ENTRIES.filter((e) => e.kind === 'command' && !e.declaredOnly);
    // execute/review/research and graph ship as real skill directories.
    expect(skills).toHaveLength(38);
    expect(commands).toHaveLength(21);
    const keys = WORKFLOW_ENTRIES.map((e) => `${e.kind}:${e.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves every merge/alias entry to a keep target without broken chains', () => {
    const aliases = WORKFLOW_ENTRIES.filter((e) => e.decision === 'merge' || e.decision === 'alias-deprecate');
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) {
      const canonical = resolveCanonical(a.name, a.kind);
      expect(canonical, `${a.kind}:${a.name}`).toBeDefined();
      expect(canonical!.decision).toBe('keep');
    }
  });

  it('drops legacy execution modes retired in 5.0.0', () => {
    // Retired outright under the major-version carve-out — no registry entry,
    // so they no longer resolve to a canonical target at all.
    for (const name of ['pipeline', 'ultrawork', 'swarm', 'ultrapilot']) {
      expect(getEntry(name, 'skill')).toBeUndefined();
      expect(resolveCanonical(name, 'skill')).toBeUndefined();
    }
    // autopilot survives as a directly-invocable workflow (owner direction).
    expect(getEntry('autopilot', 'skill')?.decision).toBe('keep');
    expect(resolveCanonical('autopilot', 'skill')?.name).toBe('autopilot');
    // team remains an internal lane.
    expect(getEntry('team', 'skill')?.internalOnly).toBe(true);
  });

  it('routes planning and verification modes into plan/verify (deep-interview/ralplan are now Tier-0 #3708)', () => {
    // Owner keeps deep-interview and ralplan distinct and independent Tier-0
    expect(getEntry('deep-interview', 'skill')?.decision).toBe('keep');
    expect(getEntry('deep-interview', 'skill')?.tier).toBe(0);
    expect(getEntry('ralplan', 'skill')?.decision).toBe('keep');
    expect(getEntry('ralplan', 'skill')?.tier).toBe(0);
    expect(resolveCanonical('deep-interview', 'skill')?.name).toBe('deep-interview');
    expect(resolveCanonical('ralplan', 'skill')?.name).toBe('ralplan');
    // ultraqa and merge-readiness were retired in 5.0.0; verify/review are canonical.
    expect(getEntry('ultraqa', 'skill')).toBeUndefined();
    expect(getEntry('merge-readiness', 'skill')).toBeUndefined();
    expect(resolveCanonical('verify', 'skill')?.name).toBe('verify');
    expect(resolveCanonical('review', 'skill')?.name).toBe('review');
  });


  it('attaches a removal milestone to every removable alias', () => {
    for (const e of WORKFLOW_ENTRIES) {
      if (e.decision === 'merge' || e.decision === 'alias-deprecate' || e.decision === 'delete') {
        expect(e.removalMilestone, `${e.kind}:${e.name}`).toBeDefined();
      }
    }
  });
});

describe('workflow registry — release maintainer boundary', () => {
  it('keeps release maintainer-only with release-authority risk on both surfaces', () => {
    for (const kind of ['skill', 'command'] as const) {
      const release = getEntry('release', kind);
      expect(release).toBeDefined();
      expect(release!.maintainerOnly).toBe(true);
      expect(release!.riskClass).toBe('release-authority');
      expect(failModeForRisk(release!.riskClass)).toBe('fail-closed');
      expect(release!.decision).toBe('alias-deprecate');
      expect(resolveCanonical('release', kind)?.name).toBe('omc-release');
    }
    const target = getEntry('omc-release', 'skill');
    expect(target?.maintainerOnly).toBe(true);
    expect(target?.tier).toBeUndefined();
  });
});

describe('workflow registry — retirement policy', () => {
  it('encodes the owner retirement evidence thresholds', () => {
    expect(RETIREMENT_POLICY).toEqual({
      minMinorReleases: 2,
      minDays: 90,
      minCanonicalShare: 0.95,
      requiredConsecutiveReleases: 2,
      requiresZeroCriticalIntegrations: true,
      schemaVersion: 1,
    });
    expect(REMOVAL_MILESTONE).toContain('90 days');
    expect(REMOVAL_MILESTONE).toContain('95%');
  });
  it('re-exports the canonical RETIREMENT_POLICY from alias-retirement/policy.ts (single source of truth)', async () => {
    const { RETIREMENT_POLICY: canonicalPolicy } = await import('../../alias-retirement/policy.js');
    expect(RETIREMENT_POLICY).toBe(canonicalPolicy);
  });
});

describe('workflow registry — feature flag and resolver adapter seam', () => {
  afterEach(() => {
    delete process.env.OMC_WORKFLOW_REGISTRY;
  });

  it('is enabled by default and disabled via OMC_WORKFLOW_REGISTRY=0 (rollback)', () => {
    expect(isRegistryEnabled()).toBe(true);
    process.env.OMC_WORKFLOW_REGISTRY = '0';
    expect(isRegistryEnabled()).toBe(false);
    process.env.OMC_WORKFLOW_REGISTRY = 'false';
    expect(isRegistryEnabled()).toBe(false);
    process.env.OMC_WORKFLOW_REGISTRY = '1';
    expect(isRegistryEnabled()).toBe(true);
  });

  it('serves workflow aliases through the #3706 AliasRegistryLookup seam', () => {
    // After the 5.0.0 retirement the only registry-served workflow alias is
    // the maintainer-only release boundary; everything else was removed or kept.
    const e = registryAliasLookup('release');
    expect(e).toBeDefined();
    expect(e!.canonical).toBe('omc-release');
    expect(e!.isWorkflowAlias).toBe(true);
    expect(e!.owner).toBe(REGISTRY_OWNER);
  });

  it('maps release to maintainer-only omc-release without a Tier-0 role', () => {
    const e = registryAliasLookup('release');
    expect(e).toBeDefined();
    expect(e!.canonical).toBe('omc-release');
    expect(e!.tier0).toBeUndefined();
  });

  it('no longer serves the internal-lane aliases retired in 5.0.0', () => {
    for (const name of ['ultrawork', 'sciomc', 'deep-dive', 'ccg']) {
      expect(registryAliasLookup(name)).toBeUndefined();
    }
  });

  it('returns undefined for canonical names, unknown names, and when disabled', () => {
    expect(registryAliasLookup('plan')).toBeUndefined();
    expect(registryAliasLookup('execute')).toBeUndefined();
    expect(registryAliasLookup('not-a-thing')).toBeUndefined();
    // utility-to-utility aliases stay with the resolver's own merged table
    expect(registryAliasLookup('learner')).toBeUndefined();
    process.env.OMC_WORKFLOW_REGISTRY = '0';
    expect(registryAliasLookup('autopilot')).toBeUndefined();
  });
});

describe('workflow registry — versioning', () => {
  it('exposes schema and registry versions for projections', () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(1);
    expect(REGISTRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
