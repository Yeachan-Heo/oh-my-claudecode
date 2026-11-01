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
  // The checker resolves the playbooks dir through resolveOmcStateRoot(),
  // which returns <project>/.omc for a git repo and redirects elsewhere for
  // a bare directory — so the fixture models a real project with git init.
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
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
  it('resolves bundled skills from OMC_PLUGIN_ROOT (local --plugin-dir mode)', () => {
    const { root } = buildProject();
    // --plugin-dir mode: bundled skills live ONLY under OMC_PLUGIN_ROOT and
    // nothing was copied into the config dir; the resolver must honor it.
    const pluginRoot = join(root, 'plugin-dir');
    mkdirSync(join(pluginRoot, 'skills', 'tdd'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'skills', 'tdd', 'SKILL.md'),
      '---\nname: tdd\n---\n\n# TDD\n\nWrite the failing test first. Watch it fail for the intended reason.\n',
    );
    const configDir = join(root, 'empty-config');
    mkdirSync(configDir, { recursive: true });
    writePlaybook(
      root,
      'plugin-dir.md',
      '---\nextends: tdd\nwhen: Local checkout without a setup copy.\n---\n\n**After** "Write the failing test first." keep the output artifact path.\n',
    );
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    env.OMC_PLUGIN_ROOT = pluginRoot;
    env.CLAUDE_CONFIG_DIR = configDir;
    const r = spawnSync('node', [CHECKER, root], { encoding: 'utf8', env });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('1 project playbook(s) valid');
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores anchor-like text in frontmatter', () => {
    const { root, skillsRoot } = buildProject();
    writeFileSync(join(skillsRoot, 'tdd', 'SKILL.md'), '---\nname: tdd\n---\n\nBundled step.\n');
    writePlaybook(root, 'frontmatter-anchor.md', '---\nextends: tdd\nwhen: Requests using **After** "metadata".\n---\n\nBody.\n');
    const r = runChecker(root, skillsRoot);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a plain file passed as the project root', () => {
    const { root, skillsRoot } = buildProject();
    const filePath = join(root, 'not-a-dir.txt');
    writeFileSync(filePath, 'placeholder');
    const r = runChecker(filePath, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a directory');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a nonexistent project root instead of validating an ancestor state', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(root, 'real.md', '---\nextends: tdd\nwhen: Real project has playbooks.\n---\n\nBody.\n');
    const missing = join(root, 'does-not-exist');
    const r = runChecker(missing, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('project root does not exist');
    rmSync(root, { recursive: true, force: true });
  });

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

  it('rejects an extends list that names no skills', () => {
    const { root, skillsRoot } = buildProject();
    writePlaybook(root, 'empty.md', '---\nextends: ,\nwhen: Bypass.\n---\n\nBody.\n');
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('lists no skills');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a path-like extends value that would leave the skills root', () => {
    const { root, skillsRoot } = buildProject();
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(
      join(root, 'outside', 'SKILL.md'),
      '---\nname: outside\n---\n\nWrite the failing test first.\n',
    );
    writePlaybook(root, 'escape.md', '---\nextends: ../outside\nwhen: Escape.\n---\n\nBody.\n');
    const r = runChecker(root, skillsRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid extended skill name');
    rmSync(root, { recursive: true, force: true });
  });

  it('validates anchors against the installer archive layout (skill-bodies sibling of skills)', () => {
    const { root } = buildProject();
    // Real `omc setup` layout: the plugin root holds `skills/` (compact
    // registry shims) and `skill-bodies/` (full bodies) as SIBLINGS. The
    // checker receives skills/ as the skills root and must find the archive
    // next to it, not inside it.
    const fullBody = '---\nname: tdd\n---\n\n# TDD\n\nWrite the failing test first. Watch it fail for the intended reason.\n';
    const pluginRoot = join(root, 'plugin');
    mkdirSync(join(pluginRoot, 'skills', 'tdd'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skill-bodies', 'tdd'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skill-bodies', 'tdd', 'SKILL.md'), fullBody);
    writeFileSync(
      join(pluginRoot, 'skills', 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Registry shim; full body archived under skill-bodies.\n---\n\nLoad on demand.\n',
    );
    writePlaybook(
      root,
      'installed.md',
      '---\nextends: tdd\nwhen: Resync after a compacting setup.\n---\n\n**After** "Write the failing test first." keep the output artifact path.\n',
    );
    const r = runChecker(root, join(pluginRoot, 'skills'));
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('1 project playbook(s) valid');
    rmSync(root, { recursive: true, force: true });
  });

  it('also accepts a self-contained archive nested under the skills root', () => {
    const { root, skillsRoot } = buildProject();
    const fullBody = '---\nname: tdd\n---\n\n# TDD\n\nWrite the failing test first. Watch it fail for the intended reason.\n';
    mkdirSync(join(skillsRoot, 'skill-bodies', 'tdd'), { recursive: true });
    writeFileSync(join(skillsRoot, 'skill-bodies', 'tdd', 'SKILL.md'), fullBody);
    writeFileSync(
      join(skillsRoot, 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Registry shim; full body archived under skill-bodies.\n---\n\nLoad on demand.\n',
    );
    writePlaybook(
      root,
      'installed-nested.md',
      '---\nextends: tdd\nwhen: Self-contained archive.\n---\n\n**After** "Write the failing test first." keep the output artifact path.\n',
    );
    const r = runChecker(root, skillsRoot);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
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
