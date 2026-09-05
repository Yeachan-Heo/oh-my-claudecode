import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  sha256Hex,
  buildRegistryProjection,
  computeRegistryDigest,
  enumerateInstalledSurfaces,
  checkProjectionDrift,
} from '../projections.js';
import { WORKFLOW_ENTRIES, type WorkflowEntry } from '../registry.js';

describe('registry projections — canonical JSON and digest', () => {
  it('serializes objects with sorted keys deterministically', () => {
    const a = canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });

  it('produces a stable 64-hex digest across builds', () => {
    const d1 = computeRegistryDigest();
    const d2 = buildRegistryProjection().digest;
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(d1).toBe(sha256Hex(canonicalJson(buildRegistryProjection().entries)));
  });

  it('changes the digest when entries change', () => {
    const mutated: WorkflowEntry[] = [
      ...WORKFLOW_ENTRIES,
      { name: 'zz-extra', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: 'test' },
    ];
    expect(computeRegistryDigest(mutated)).not.toBe(computeRegistryDigest());
  });

  it('sorts projection entries by kind then name', () => {
    const { entries } = buildRegistryProjection();
    const keys = entries.map((e) => `${e.kind}:${e.name}`);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('registry projections — drift check against installed surfaces', () => {
  it('matches the repository skills/ and commands/ surface exactly', () => {
    const installed = enumerateInstalledSurfaces(process.cwd());
    // 41 + execute/review/research + graph + minimal-code-discipline + launch/drydock + ask-navigator + loft + harbor, which ship as real skill directories.
    expect(installed.skills.length).toBe(38);
    expect(installed.commands.length).toBe(21);
    const drift = checkProjectionDrift(installed);
    expect(drift.unregistered).toEqual([]);
    expect(drift.missing).toEqual([]);
    expect(drift.ok).toBe(true);
  });

  it('flags an installed surface missing from the registry', () => {
    const installed = enumerateInstalledSurfaces(process.cwd());
    const drift = checkProjectionDrift({
      skills: [...installed.skills, 'unregistered-new-skill'],
      commands: installed.commands,
    });
    expect(drift.ok).toBe(false);
    expect(drift.unregistered).toEqual(['skill:unregistered-new-skill']);
  });

  it('flags a registered entry whose installed file disappeared', () => {
    const installed = enumerateInstalledSurfaces(process.cwd());
    const drift = checkProjectionDrift({
      skills: installed.skills.filter((n) => n !== 'autopilot'),
      commands: installed.commands,
    });
    expect(drift.ok).toBe(false);
    expect(drift.missing).toContain('skill:autopilot');
  });

  it('exempts declaredOnly entries from the installed-file requirement', () => {
    const installed = enumerateInstalledSurfaces(process.cwd());
    // execute/review/research now ship as real skill directories; the remaining
    // declaredOnly entries (omc-release/ultrapilot/swarm/pipeline) have no files.
    for (const name of ['omc-release', 'ultrapilot', 'swarm', 'pipeline']) {
      expect(installed.skills).not.toContain(name);
    }
    for (const name of ['execute', 'review', 'research']) {
      expect(installed.skills).toContain(name);
    }
    expect(checkProjectionDrift(installed).ok).toBe(true);
  });
});
