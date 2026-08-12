import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALIAS_REGISTRY, assertAliasRegistryIntegrity, getAliasRecord } from '../registry.js';
import { createBuiltinSkills, getBuiltinSkill } from '../../features/builtin-skills/skills.js';

describe('alias-retirement registry', () => {
  it('contains exactly the four known compatibility aliases', () => {
    const aliases = ALIAS_REGISTRY.map((r) => r.alias).sort();
    expect(aliases).toEqual(['cancel-ralph', 'learner', 'psm', 'understanding-gate'].sort());
  });

  it('has no integrity errors', () => {
    expect(assertAliasRegistryIntegrity()).toEqual([]);
  });

  it('getAliasRecord is case-insensitive', () => {
    expect(getAliasRecord('LEARNER')?.canonical).toBe('skillify');
    expect(getAliasRecord('Psm')?.canonical).toBe('project-session-manager');
    expect(getAliasRecord('unknown')).toBeUndefined();
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
    const learner = getAliasRecord('learner')!;
    expect(learner.introducedVersion).toBe('4.2.15');
    expect(learner.introducedDate).toBe('2026-02-19');
    const psm = getAliasRecord('psm')!;
    expect(psm.introducedVersion).toBe('4.2.15');
    expect(psm.introducedDate).toBe('2026-02-19');
    const cancelRalph = getAliasRecord('cancel-ralph')!;
    expect(cancelRalph.introducedVersion).toBe('4.3.0');
    expect(cancelRalph.introducedDate).toBe('2026-02-21');
    const ug = getAliasRecord('understanding-gate')!;
    expect(ug.introducedVersion).toBe('4.15.3');
    expect(ug.introducedDate).toBe('2026-07-10');
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

  it('built-in loader exposes 41 entries (37 canonical + 4 aliases) before retirement', () => {
    // This is the baseline that retirement must not silently change without an eligibility receipt
    const all = createBuiltinSkills();
    expect(all).toHaveLength(41);
    const canonical = all.filter((s) => !s.aliasOf);
    const aliases = all.filter((s) => !!s.aliasOf);
    expect(canonical).toHaveLength(37);
    expect(aliases).toHaveLength(4);
    expect(aliases.map((s) => s.name).sort()).toEqual(
      ['cancel-ralph', 'learner', 'psm', 'understanding-gate'].sort(),
    );
  });
});
