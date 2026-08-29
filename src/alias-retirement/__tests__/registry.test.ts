import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALIAS_REGISTRY, assertAliasRegistryIntegrity, getAliasRecord } from '../registry.js';
import { createBuiltinSkills, getBuiltinSkill } from '../../features/builtin-skills/skills.js';

describe('alias-retirement registry', () => {
  it('contains exactly the surviving compatibility aliases after the 5.0.0 retirement', () => {
    // learner (-> skillify) and understanding-gate (-> merge-readiness) were
    // retired in 5.0.0 along with their skills and generated projections.
    const aliases = ALIAS_REGISTRY.map((r) => r.alias).sort();
    expect(aliases).toEqual(['cancel-ralph', 'psm'].sort());
  });

  it('has no integrity errors', () => {
    expect(assertAliasRegistryIntegrity()).toEqual([]);
  });

  it('getAliasRecord is case-insensitive', () => {
    expect(getAliasRecord('CANCEL-RALPH')?.canonical).toBe('cancel');
    expect(getAliasRecord('Psm')?.canonical).toBe('project-session-manager');
    expect(getAliasRecord('unknown')).toBeUndefined();
    // retired in 5.0.0
    expect(getAliasRecord('learner')).toBeUndefined();
  });

  it('maps to real canonical skills exposed by the runtime loader', () => {
    for (const rec of ALIAS_REGISTRY) {
      const canonical = getBuiltinSkill(rec.canonical);
      expect(canonical, `canonical ${rec.canonical} for alias ${rec.alias} must exist`).toBeDefined();
      expect(canonical!.aliasOf).toBeUndefined();
      // alias entry must exist as deprecatedAlias
      const alias = getBuiltinSkill(rec.alias);
      expect(alias, `alias ${rec.alias} must be resolvable via getBuiltinSkill`).toBeDefined();
      expect(alias!.aliasOf).toBe(rec.canonical);
      expect(alias!.deprecatedAlias).toBe(true);
    }
  });

  it('introduced dates/versions match the authoritative git history', () => {
    const psm = getAliasRecord('psm')!;
    expect(psm.introducedVersion).toBe('4.2.15');
    expect(psm.introducedDate).toBe('2026-02-19');
    const cancelRalph = getAliasRecord('cancel-ralph')!;
    expect(cancelRalph.introducedVersion).toBe('4.3.0');
    expect(cancelRalph.introducedDate).toBe('2026-02-21');
  });

  it('generatedArtifacts exist on disk while alias is still extended (no premature cleanup)', () => {
    // This test is the "do not falsely remove aliases" guard.
    // Files listed as deletable-only-after-eligible must still exist.
    for (const rec of ALIAS_REGISTRY) {
      for (const p of rec.generatedArtifacts) {
        const full = join(process.cwd(), p);
        expect(existsSync(full), `generated artifact ${p} for alias ${rec.alias} must still exist (issue #3711 temporal rule: no premature removal)`).toBe(true);
      }
    }
  });

  it('every generated artifact owner is a known alias', () => {
    const allAliases = new Set(ALIAS_REGISTRY.map((r) => r.alias.toLowerCase()));
    for (const rec of ALIAS_REGISTRY) {
      expect(allAliases.has(rec.alias.toLowerCase())).toBe(true);
    }
  });

  it('built-in loader exposes 37 entries (35 canonical + 2 aliases) after the 5.0.0 retirement', () => {
    // This is the baseline that retirement must not silently change without an eligibility receipt.
    // Raised 37 -> 40 canonical when execute/review/research shipped as real
    // skill directories; this is an addition, not an alias retirement.
    // Raised 32 -> 33 canonical when minimal-code-discipline shipped as a real
    // skill directory; this is an addition, not an alias retirement.
    // Raised 33 -> 35 canonical when launch/drydock shipped as real skill
    // directories; this is an addition, not an alias retirement.
    const all = createBuiltinSkills();
    expect(all).toHaveLength(37);
    const canonical = all.filter((s) => !s.aliasOf);
    const aliases = all.filter((s) => !!s.aliasOf);
    expect(canonical).toHaveLength(35);
    expect(aliases).toHaveLength(2);
    expect(aliases.map((s) => s.name).sort()).toEqual(['cancel-ralph', 'psm'].sort());
  });
});
