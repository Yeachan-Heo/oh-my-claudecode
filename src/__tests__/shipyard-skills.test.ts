import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEAM_TASK_STATUSES } from '../team/contracts.js';
import { parseSkillFile } from '../hooks/learner/parser.js';
import { loadAllSkills } from '../hooks/learner/loader.js';

const ROOT = join(__dirname, '..', '..');
const LAUNCH = readFileSync(join(ROOT, 'skills', 'launch', 'SKILL.md'), 'utf-8');
const DRYDOCK = readFileSync(join(ROOT, 'skills', 'drydock', 'SKILL.md'), 'utf-8');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));

function frontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('missing frontmatter');
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

describe('shipyard skills — behavior & packaging contract', () => {
  it('launch/drydock ship as loadable skill directories with matching frontmatter names', () => {
    for (const name of ['launch', 'drydock']) {
      expect(existsSync(join(ROOT, 'skills', name, 'SKILL.md'))).toBe(true);
      const fm = frontmatter(name === 'launch' ? LAUNCH : DRYDOCK);
      expect(fm.name).toBe(name);
      expect(fm.description.length).toBeGreaterThan(0);
      expect(fm.level).toBeDefined();
    }
  });

  it('launch pipeline references resolve to shipped skills', () => {
    const fm = frontmatter(LAUNCH);
    const pipeline = (fm.pipeline || '').replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    expect(pipeline).toContain('deep-interview');
    for (const ref of pipeline) {
      if (ref === 'launch') continue;
      expect(existsSync(join(ROOT, 'skills', ref, 'SKILL.md')), `pipeline ref ${ref} must exist`).toBe(true);
    }
  });

  it('launch Phase 4 references only Team-supported task statuses (no invented state mutations)', () => {
    // regression for the C4 lifecycle blocker: "blocked-on-decision" was an unsupported mutation
    expect(LAUNCH).not.toContain('blocked-on-decision');
    const statusTokens = [...LAUNCH.matchAll(/`?(pending|blocked|in_progress|completed|failed)`?/g)].map((m) => m[1]);
    for (const t of statusTokens) {
      expect(TEAM_TASK_STATUSES as readonly string[]).toContain(t);
    }
    expect(LAUNCH).toContain('normal numeric Team decision task');
    expect(LAUNCH).toContain('decision task ID in `blockedBy`');
    expect(LAUNCH).toContain('`pending` → `in_progress` → `completed`');
    expect(LAUNCH).toContain('never reopen or re-dispatch that failed task');
    expect(LAUNCH).toContain('No mid-flight `in_progress` → `blocked` or `in_progress` → `pending` transition is promised');
  });

  it('launch is stateless and resumes only at a safe batch boundary', () => {
    expect(LAUNCH).toContain('Launch adds no approval receipt, revision counter, replay log, cancellation path, rollback mechanism, or cleanup lifecycle of its own');
    expect(LAUNCH).toContain('allowed only at a batch boundary');
    expect(LAUNCH).toContain('Never infer a human approval or replay an `in_progress` task');
    expect(LAUNCH).toContain('Team remains authoritative for runtime state');
  });

  it('launch keeps the canonical path canonical and itself opt-in (no seeded default override)', () => {
    // drydock's generated CLAUDE.md must not mandate launch as the default delivery path
    expect(DRYDOCK).not.toContain('交付走 /oh-my-claudecode:launch');
    expect(DRYDOCK).toContain('plan → execute → review → verify');
    expect(LAUNCH).toMatch(/opt-in|explicit/i);
  });

  it('drydock seed requires non-empty triggers so generated project skills are loadable', () => {
    const example = DRYDOCK.match(/```markdown\n(---\nname: project-release-check[\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();

    const parsed = parseSkillFile(example!);
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.metadata.triggers).toEqual(['project release check']);

    const projectRoot = mkdtempSync(join(tmpdir(), 'omc-drydock-seed-'));
    try {
      const skillsDir = join(projectRoot, '.omc', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'project-release-check.md'), example!);

      const loaded = loadAllSkills(projectRoot).find(
        (skill) => skill.scope === 'project' && skill.metadata.id === 'project-release-check',
      );
      expect(loaded).toBeDefined();
      expect(loaded?.relativePath).toBe('project-release-check.md');
      expect(loaded?.metadata.triggers).toEqual(['project release check']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('plugin.json ships both skills and every path exists on disk', () => {
    for (const name of ['launch', 'drydock']) {
      const entry = `./skills/${name}/`;
      expect(PLUGIN.skills as string[]).toContain(entry);
      expect(existsSync(join(ROOT, entry, 'SKILL.md'))).toBe(true);
    }
  });

  it('docs/REFERENCE.md skills count matches the filesystem', () => {
    const ref = readFileSync(join(ROOT, 'docs', 'REFERENCE.md'), 'utf-8');
    const dirCount = existsSync(join(ROOT, 'skills'))
      ? readdirSync(join(ROOT, 'skills')).filter((d) => d !== 'AGENTS.md' && d !== 'README.md').length
      : 0;
    expect(ref).toContain(`Skills (${dirCount} Total)`);
    expect(ref).toContain('[Skills (35 Total)](#skills-35-total)');
    expect(ref).toContain('/oh-my-claudecode:drydock [--check]');
    expect(ref).toContain('/oh-my-claudecode:launch <brief\\|spec-path> [--serial]');
    for (const name of ['launch', 'drydock']) {
      expect(ref).toContain(`\`${name}\``);
    }
  });
});
