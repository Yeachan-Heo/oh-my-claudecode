/**
 * Doc-lint: the project-playbook extension checker validates extends targets
 * and anchors, passes clean fixtures, and exits 0 with no playbooks present.
 *
 * Mechanism credit: pstack's check-playbooks pattern (see
 * scripts/check-omc-playbooks.mjs header).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dirname, '../..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-omc-playbooks.mjs');

interface Fixture {
  readonly name: string;
}

function buildProject(): { root: string; skillsRoot: string } & Fixture {
  const root = mkdtempSync(join(tmpdir(), 'omc-playbooks-'));
  const skillsRoot = join(root, 'skills');
  mkdirSync(join(skillsRoot, 'tdd', ''), { recursive: true });
  writeFileSync(
    join(skillsRoot, 'tdd', 'SKILL.md'),
    '---\nname: tdd\n---\n\n# TDD\n\nWrite the failing test first. Watch it fail for the intended reason.\n',
  );
  mkdirSync(join(root, '.omc', 'playbooks'), { recursive: true });
  return { root, skillsRoot, name: 'omc-playbooks-checker' };
}

function writePlaybook(root: string, file: string, body: string): void {
  writeFileSync(join(root, '.omc', 'playbooks', file), body);
}

function runChecker(root: string, skillsRoot: string) {
  return spawnSync('node', [CHECKER, root, '--skills-root', skillsRoot], { encoding: 'utf8' });
}

describe('check-omc-playbooks', () => {
  it('exits 0 with no .omc/playbooks directory', () => {
    const { root, skillsRoot } = buildProject();
    rmSync(join(root, '.omc', 'playbooks'), { recursive: true, force: true });
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a playbook whose anchors quote the bundled skill', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(
      root,
      'strict-tdd.md',
      [
        '---',
        'extends: tdd',
        'when: The repo requires the failing-test evidence as a CI artifact.',
        '---',
        '',
        '**After** "Write the failing test first." also commit the failing run output.',
        '',
        '**In** "Watch it fail for the intended reason." require the assertion text in the quote.',
      ].join('\n'),
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('1 project playbook(s) valid');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an extends target with no bundled skill', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(
      root,
      'ghost.md',
      '---\nextends: no-such-skill\nwhen: Nothing.\n---\n\nBody.\n',
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no bundled skill named "no-such-skill"');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an anchor the bundled skill no longer contains', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(
      root,
      'drifted.md',
      '---\nextends: tdd\nwhen: Old wording.\n---\n\n**After** "Write the failing test second." do nothing.\n',
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not appear in any extended skill');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a playbook without extends', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(root, 'loose.md', '---\nwhen: Vague.\n---\n\nBody.\n');
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing an "extends:"');
    rmSync(root, { recursive: true, force: true });
  });

  it('matches each multi-base anchor against any extended skill, not every one', () => {
    const { root, skillsRoot } = buildProject();
    mkdirSync(join(skillsRoot, 'verify', ''), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'verify', 'SKILL.md'),
      '---\nname: verify\n---\n\n# Verify\n\nDemand real command output as evidence. Evidence must be fresh.\n',
    );
    // One anchor quotes tdd, the other quotes verify; both must pass against the union.
    writePlaybook(
      root,
      'both.md',
      [
        '---',
        'extends: tdd, verify',
        'when: TDD work whose evidence must satisfy the verify bar.',
        '---',
        '',
        '**After** "Write the failing test first." keep the output artifact path.',
        '',
        '**In** "Demand real command output as evidence." name the freshness window.',
      ].join('\n'),
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('1 project playbook(s) valid');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a multi-base anchor absent from every extended skill', () => {
    const { root, skillsRoot } = buildProject();
    mkdirSync(join(skillsRoot, 'verify', ''), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'verify', 'SKILL.md'),
      '---\nname: verify\n---\n\n# Verify\n\nDemand real command output as evidence.\n',
    );
    writePlaybook(
      root,
      'drifted-both.md',
      '---\nextends: tdd, verify\nwhen: Drifted.\n---\n\n**After** "Write the failing test second." nothing.\n',
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not appear in any extended skill');
    rmSync(root, { recursive: true, force: true });
  });
});
