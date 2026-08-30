import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEAM_TASK_STATUSES } from '../team/contracts.js';
import { parseSkillFile } from '../hooks/learner/parser.js';
import { loadAllSkills } from '../hooks/learner/loader.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { executeTeamApiOperation } from '../team/api-interop.js';

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
    expect(LAUNCH).toContain('`in_progress` → `failed`');
    expect(LAUNCH).toContain("failed transition's `error` field");
    expect(LAUNCH).toContain('This is a terminal Launch outcome');
    expect(LAUNCH).toContain('never promises automatic re-dispatch after C4');
    expect(LAUNCH).toContain('later explicit Launch invocation');
    expect(LAUNCH).toContain('owning Team lifecycle to be terminal and cleaned up through its supported owner');
    expect(LAUNCH).toContain('The team lead never claims a task unless it is explicitly registered as a Team worker');
    expect(LAUNCH).toContain('public Team `blocked_by` field');
    expect(LAUNCH).toContain('All ticket dependencies are declared before dispatch');
    expect(LAUNCH).toContain('never dynamically mutates a claimed task\'s dependencies');
    expect(LAUNCH).toContain('**Serial C4 (`--serial`).**');
    expect(LAUNCH).toContain('start a fresh executor successor');
    expect(LAUNCH).toContain('do not manufacture Team tasks when Team is not active');
  });

  it('Team API enforces pre-dispatch ticket dependencies and persists C4 failure evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-launch-c4-'));
    const teamName = 'launch-c4';
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStateDir = process.env.OMC_STATE_DIR;

    try {
      process.env.HOME = cwd;
      process.env.USERPROFILE = cwd;
      delete process.env.OMC_STATE_DIR;
      const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
      mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
      mkdirSync(join(teamRoot, 'events'), { recursive: true });
      writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
        name: teamName,
        task: 'Launch dependency contract',
        agent_type: 'executor',
        worker_count: 2,
        max_workers: 20,
        workers: [
          { name: 'predecessor-worker', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'executor-worker', index: 2, role: 'executor', assigned_tasks: [] },
        ],
        created_at: new Date().toISOString(),
        tmux_session: 'test:0',
        next_task_id: 1,
      }, null, 2));

      const predecessor = await executeTeamApiOperation('create-task', {
        team_name: teamName,
        subject: 'Predecessor ticket',
        description: 'Complete before the dependent ticket',
        owner: 'predecessor-worker',
      }, cwd);
      expect(predecessor.ok).toBe(true);
      if (!predecessor.ok) return;
      const predecessorId = String((predecessor.data as { task: { id: string } }).task.id);

      const implementation = await executeTeamApiOperation('create-task', {
        team_name: teamName,
        subject: 'Dependent ticket',
        description: 'Continue only after the predecessor completes',
        owner: 'executor-worker',
        blocked_by: [predecessorId],
      }, cwd);
      expect(implementation.ok).toBe(true);
      if (!implementation.ok) return;
      const implementationId = String((implementation.data as { task: { id: string } }).task.id);

      const premature = await executeTeamApiOperation('claim-task', {
        team_name: teamName,
        task_id: implementationId,
        worker: 'executor-worker',
      }, cwd);
      expect(premature.ok).toBe(true);
      if (!premature.ok) return;
      expect((premature.data as { error?: string }).error).toBe('blocked_dependency');

      const leaderClaim = await executeTeamApiOperation('claim-task', {
        team_name: teamName,
        task_id: predecessorId,
        worker: 'leader-fixed',
      }, cwd);
      expect(leaderClaim.ok).toBe(true);
      if (!leaderClaim.ok) return;
      expect((leaderClaim.data as { error?: string }).error).toBe('worker_not_found');

      const predecessorClaim = await executeTeamApiOperation('claim-task', {
        team_name: teamName,
        task_id: predecessorId,
        worker: 'predecessor-worker',
      }, cwd);
      expect(predecessorClaim.ok).toBe(true);
      if (!predecessorClaim.ok) return;
      const claimData = predecessorClaim.data as { ok?: boolean; claimToken?: string };
      expect(claimData.ok).toBe(true);
      expect(claimData.claimToken).toBeTruthy();

      const completed = await executeTeamApiOperation('transition-task-status', {
        team_name: teamName,
        task_id: predecessorId,
        from: 'in_progress',
        to: 'completed',
        claim_token: claimData.claimToken,
        result: 'Predecessor complete',
      }, cwd);
      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect((completed.data as { ok?: boolean }).ok).toBe(true);

      const eligible = await executeTeamApiOperation('claim-task', {
        team_name: teamName,
        task_id: implementationId,
        worker: 'executor-worker',
      }, cwd);
      expect(eligible.ok).toBe(true);
      if (!eligible.ok) return;
      expect((eligible.data as { ok?: boolean }).ok).toBe(true);

      const eligibleData = eligible.data as { claimToken?: string };
      const failed = await executeTeamApiOperation('transition-task-status', {
        team_name: teamName,
        task_id: implementationId,
        from: 'in_progress',
        to: 'failed',
        claim_token: eligibleData.claimToken,
        error: 'C4 decision required; see decisions-pending.md',
      }, cwd);
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect((failed.data as { ok?: boolean }).ok).toBe(true);

      const readFailed = await executeTeamApiOperation('read-task', {
        team_name: teamName,
        task_id: implementationId,
      }, cwd);
      expect(readFailed.ok).toBe(true);
      if (!readFailed.ok) return;
      expect((readFailed.data as { task?: { status?: string; error?: string } }).task).toMatchObject({
        status: 'failed',
        error: 'C4 decision required; see decisions-pending.md',
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previousStateDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('launch is stateless and requires explicit reinvocation after Team cleanup', () => {
    expect(LAUNCH).toContain('Launch adds no approval receipt, revision counter, replay log, cancellation path, rollback mechanism, or cleanup lifecycle of its own');
    expect(LAUNCH).toContain('Launch has no automatic resume');
    expect(LAUNCH).toContain('new explicit Launch invocation after the owning Team lifecycle has reached a supported terminal/cleanup boundary');
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

  it('drydock makes the document language a first-class decision with en + zh seed companions', () => {
    // user-language principle: generated harness files follow the human's language
    expect(DRYDOCK).toMatch(/document language for the generated harness files/);
    expect(DRYDOCK).toMatch(/structural keys stay language-stable/);
    // both language companions present for the load-bearing seeds
    expect(DRYDOCK).toContain('## Project conventions');
    expect(DRYDOCK).toContain('## 项目约定');
    expect(DRYDOCK).toContain('- Definition:');
    expect(DRYDOCK).toContain('- 定义:');
  });

  it('launch states the user-language rule for authored artifacts', () => {
    expect(LAUNCH).toMatch(/document language/);
    expect(LAUNCH).toMatch(/agents are language-agnostic/);
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
