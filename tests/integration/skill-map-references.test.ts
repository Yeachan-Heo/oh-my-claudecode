import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The map is a router: it names skills so the model can call them. A map
// that names a retired skill lies. Every backticked reference in the map
// must resolve to a real surface on disk, and every routed skill must be
// a `keep` in the canonical workflow registry.

const root = process.cwd();
const mapBody = readFileSync(join(root, 'skills', 'map', 'SKILL.md'), 'utf8');
const references = [...new Set([...mapBody.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]))];

function skillDirs(): Set<string> {
  return new Set(
    readdirSync(join(root, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, 'skills', e.name, 'SKILL.md')))
      .map((e) => e.name),
  );
}

describe('skill map references', () => {
  it('references at least the main-loop skills', () => {
    for (const required of ['harbor', 'intent', 'ask-navigator', 'deep-interview', 'plan', 'launch', 'ralph', 'autopilot', 'team', 'execute', 'loft', 'review', 'verify', 'pr', 'refit']) {
      expect(references).toContain(required);
    }
  });

  it('resolves every reference to a real surface (skill, agent, or command)', () => {
    const skills = skillDirs();
    const dangling = references.filter(
      (name) => !skills.has(name) && !existsSync(join(root, 'agents', `${name}.md`)) && !existsSync(join(root, 'commands', `${name}.md`)),
    );
    expect(dangling).toEqual([]);
  });

  it('routes only to surfaces the registry marks keep', () => {
    const skills = skillDirs();
    const src = readFileSync(join(root, 'src', 'workflow', 'registry.ts'), 'utf8');
    // Routed targets may be Tier-0 workflows (plan/execute/review/verify,
    // kind: 'workflow') or regular skills (kind: 'skill'); both must be
    // decision: 'keep'. Commands are never routed by the map.
    const keepNames = new Set(
      [...src.matchAll(/entry\(\{[^}]*\}\)/g)]
        .map((m) => m[0])
        .filter((entry) => /kind:\s*'(?:skill|workflow)'/.test(entry) && /decision:\s*'keep'/.test(entry))
        .map((entry) => entry.match(/name:\s*'([a-z0-9-]+)'/)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    const routed = references.filter((name) => skills.has(name));
    expect(routed.length).toBeGreaterThan(20);
    const notKeep = routed.filter((name) => !keepNames.has(name));
    expect(notKeep).toEqual([]);
  });
});
