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
const NAVIGATOR = readFileSync(join(ROOT, 'skills', 'ask-navigator', 'SKILL.md'), 'utf-8');
const LOFT = readFileSync(join(ROOT, 'skills', 'loft', 'SKILL.md'), 'utf-8');
const HARBOR = readFileSync(join(ROOT, 'skills', 'harbor', 'SKILL.md'), 'utf-8');
const SHIPYARD_DOC = readFileSync(join(ROOT, 'docs', 'shipyard.md'), 'utf-8');
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
  it('launch/drydock/ask-navigator/loft/harbor ship as loadable skill directories with matching frontmatter names', () => {
    for (const name of ['launch', 'drydock', 'ask-navigator', 'loft', 'harbor']) {
      expect(existsSync(join(ROOT, 'skills', name, 'SKILL.md'))).toBe(true);
      const fm = frontmatter(
        name === 'launch'
          ? LAUNCH
          : name === 'drydock'
            ? DRYDOCK
            : name === 'ask-navigator'
              ? NAVIGATOR
              : name === 'loft'
                ? LOFT
                : HARBOR,
      );
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

  it('launch fog gate and ask-navigator agree on the fog test verbatim', () => {
    // The two-question fog test is the routing contract between launch and the navigator:
    // both files must carry the same wording so a drift on either side is a test failure.
    for (const q of [
      'can the destination be stated in one sentence',
      'can the first three decisions be stated precisely right now',
    ]) {
      expect(LAUNCH.toLowerCase()).toContain(q);
      expect(NAVIGATOR.toLowerCase()).toContain(q);
    }
  });

  it('launch routes fog with the yard-gate honesty contract (run never started, no artifacts)', () => {
    expect(LAUNCH).toContain('**Fog gate**');
    expect(LAUNCH).toContain('**Map check**');
    expect(LAUNCH).toContain('`/oh-my-claudecode:ask-navigator`');
    expect(LAUNCH).toContain('the run never starts');
    expect(LAUNCH).toContain('no artifacts were produced');
    expect(LAUNCH).toContain('the pipeline never invents a destination');
  });

  it('ask-navigator produces decisions, never deliverables, and exits through launch', () => {
    expect(NAVIGATOR).toContain('decisions, never deliverables');
    expect(NAVIGATOR).toContain('navigator:map');
    expect(NAVIGATOR).toContain('`/oh-my-claudecode:launch`');
    expect(NAVIGATOR).toContain('Stop after one ticket');
    expect(NAVIGATOR).toContain('never answers a question that belongs to the captain');
  });

  it('ask-navigator ticket types stay within the documented vocabulary', () => {
    const types = [...NAVIGATOR.matchAll(/`?(research|loft|grilling|task)`?/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) {
      expect(['research', 'loft', 'grilling', 'task']).toContain(t);
    }
    expect(NAVIGATOR).toContain('| `research` |');
    expect(NAVIGATOR).toContain('| `loft` |');
    expect(NAVIGATOR).toContain('| `grilling` |');
    expect(NAVIGATOR).toContain('| `task` |');
  });

  it('ask-navigator defers un-laid-yard sediment instead of skipping it', () => {
    expect(NAVIGATOR).toContain('report-only mode');
    expect(NAVIGATOR).toContain('Deferred sediment');
    expect(DRYDOCK).toContain('report-only mode');
  });

  it('loft is model-invoked: model-facing description, no keyword triggers', () => {
    const fm = frontmatter(LOFT);
    expect(fm['argument-hint']).toBeUndefined(); // input is the conversation's design question
    expect(fm.description).toContain('prose cannot settle');
    expect(LOFT).not.toMatch(/^triggers:/m); // no keyword auto-activation
  });

  it('loft carries the two forks and the never-docks law', () => {
    expect(LOFT).toContain('Cut no steel until the shape is fair');
    expect(LOFT).toContain('Logic fork');
    expect(LOFT).toContain('UI fork');
    expect(LOFT).toContain('differ in structure');
    expect(LOFT).toContain('never merges');
    expect(LOFT).toContain('No persistence, no tests, no abstractions');
  });

  it('launch and navigator wire the loft contract', () => {
    expect(LAUNCH).toContain('**Loft detour.**');
    expect(LAUNCH).toContain('call the Skill tool with "loft"');
    expect(LAUNCH).toContain('usually a loft');
    expect(LAUNCH).toContain('map resolutions or deferred-sediment lines');
    expect(LAUNCH).toContain('/oh-my-claudecode:minimal-code-discipline');
    expect(NAVIGATOR).toContain('| `loft` |');
    expect(NAVIGATOR).not.toContain('`prototype`');
    expect(NAVIGATOR).toContain('Call the Skill tool with "loft"');
  });

  it('harbor speaks plain language on the tracker (no methodology metaphors leak)', () => {
    // The sheets are read by maintainers and reporters who never learned the
    // metaphors; harbor's output contract must not leak them.
    expect(HARBOR).not.toContain('berthed');
    expect(HARBOR).not.toContain('at-anchor');
    expect(HARBOR).not.toContain('turned-away');
    expect(DRYDOCK).toContain("the navigator's map home and the harbor's intake queue");
  });

  it('harbor splits authority: facts autonomous, dispositions signed', () => {
    expect(HARBOR).toContain('harbor never merges');
    expect(HARBOR).toContain('Self-built cargo rule');
    expect(HARBOR).toContain('Never disposition on an unverified claim');
    expect(HARBOR).toContain('harbor stops tracking it');
  });

  it('harbor disclosure header and label vocabulary are pinned', () => {
    expect(HARBOR).toContain('Generated by AI during harbor intake — a human decided the disposition');
    for (const label of [
      'harbor:accepted',
      'harbor:need-decision',
      'harbor:need-info',
      'harbor:rejected',
      'harbor:for-maintainer',
      'harbor:merge-ready',
      'harbor:changes-requested',
    ]) {
      expect(HARBOR).toContain(label);
    }
    expect(HARBOR).toContain('Create these labels if the tracker does not have them');
  });

  it('harbor sweeps and reconciles (docket contract)', () => {
    expect(HARBOR).toContain('This issue — do it, or not?');
    expect(HARBOR).toContain('This PR — take it, or not?');
    expect(HARBOR).toContain('The reconciliation');
    expect(HARBOR).toContain('- [ ]');
    expect(NAVIGATOR).toContain('/oh-my-claudecode:harbor');
    expect(SHIPYARD_DOC).toContain('harbor gate');
    expect(SHIPYARD_DOC).toContain('outer ear');
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

  it('launch enforces a hard yard gate at entry (drydock --check, fail-closed with narrow override)', () => {
    // yard gate is fail-closed for high-confidence actionable findings; low-confidence / false-positive / throwaway may be overridden only with explicit per-invocation intent
    expect(LAUNCH).toContain('The yard gate is the first action of every invocation');
    expect(LAUNCH).toContain('Run the full drydock `--check` audit');
    expect(LAUNCH).toContain('Actionable / high-confidence findings hard-block the run');
    expect(LAUNCH).toContain('no artifacts were produced');
    expect(LAUNCH).toContain('Narrow override (explicit intent only)');
    expect(LAUNCH).toContain('low-confidence');
    expect(LAUNCH).toContain('false positives');
    expect(LAUNCH).toContain('scratch/throwaway');
    expect(LAUNCH).toContain('never silently swallow a high-confidence actionable finding');
    expect(LAUNCH).toContain('No general bypass');
    expect(LAUNCH).toContain('Current audit limitation');
    expect(LAUNCH).toContain('without a machine-readable finding/severity contract or executable');
    expect(LAUNCH).toContain('The rules entry is `CLAUDE.md` — the shipyard map recognizes no substitute');
    expect(LAUNCH).not.toContain('No override flag, no confirm-to-continue path');
    expect(LAUNCH).not.toContain('no exception for throwaway prototypes — laying the yard is one command away');
    expect(LAUNCH).not.toContain('never a gate');
    expect(LAUNCH).not.toContain('Facility surface checkup');
    expect(LAUNCH).not.toContain('never listed as missing');

    // drydock --check must be honest about confidence and throwaway scope, and name the same override
    expect(DRYDOCK).toContain('state the confidence (`high`');
    expect(DRYDOCK).toContain('low` when heuristic');
    expect(DRYDOCK).toContain('throwaway/scratch');
    expect(DRYDOCK).toContain('high-confidence actionable findings as blocking');
    expect(DRYDOCK).toContain('low-confidence or explicitly-classified false-positive');
    expect(DRYDOCK).toContain('no executable or machine-readable exit contract');
    expect(DRYDOCK).toContain('planned follow-up');

    // docs/shipyard.md must reflect the same softened contract
    expect(SHIPYARD_DOC).toContain('per-finding confidence');
    expect(SHIPYARD_DOC).toContain('no executable or machine-readable severity contract (planned follow-up)');
    expect(SHIPYARD_DOC).toContain('blocks on high-confidence actionable drydock findings');
    expect(SHIPYARD_DOC).toContain('narrowly, explicitly overridden low-confidence / false-positive / scratch-scope finding — no general bypass');
  });

  it('launch closeout re-runs the yard audit as yard drift instead of the retired gap list', () => {
    expect(LAUNCH).toContain('yard drift');
    expect(LAUNCH).toContain('re-run the drydock `--check` audit');
    expect(LAUNCH).not.toContain('shipyard gap list');
  });

  it('launch C5 carries the sediment pass: source checklist, mandatory answer, slot table', () => {
    // regression: the sediment half-loop referenced a nonexistent retro; it now lives in C5
    expect(LAUNCH).toContain('what did this ship teach the yard');
    expect(LAUNCH).toContain('Sweep the source checklist first');
    expect(LAUNCH).toContain('three-strike failure root causes');
    expect(LAUNCH).toContain('"no new lessons"');
    expect(LAUNCH).toContain('blocks non-answers, never empty answers');
    expect(LAUNCH).toContain('`lesson → slot → intended change`');
    expect(LAUNCH).toContain('`design-system/`');
    expect(LAUNCH).toContain('skillify gate');
    expect(LAUNCH).toContain('`.mcp.json`');
    expect(LAUNCH).toContain('individually vetoable');
    expect(LAUNCH).toContain('written to their slots only after acceptance');
  });

  it('launch keeps the thin entry a bounded cache (hot-entry budget with deterministic demotion)', () => {
    expect(LAUNCH).toContain('at most five hot entries');
    expect(LAUNCH).toContain('same violation at least twice in this run');
    expect(LAUNCH).toContain('the coldest entry is deterministically the last one listed');
    expect(LAUNCH).toContain('nothing is deleted, only re-tiered');
    expect(LAUNCH).toContain('not a `--check` finding');
  });

  it('drydock governance loop names the real sediment carrier (no ghost retro)', () => {
    // regression: the sediment loop referenced a nonexistent retro skill
    expect(DRYDOCK).not.toMatch(/retro/i);
    expect(DRYDOCK).toContain('launch C5 sediment');
    expect(SHIPYARD_DOC).not.toMatch(/retros?/i);
    expect(SHIPYARD_DOC).toContain('C5 sediment');
  });

  it('drydock seed requires non-empty triggers so generated project skills are loadable', () => {
    const example = DRYDOCK.match(/```markdown\n(---\nid: project-release-check\nname: project-release-check[\s\S]*?)\n```/)?.[1];
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
    for (const name of ['launch', 'drydock', 'ask-navigator', 'loft', 'harbor']) {
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
    expect(ref).toContain(`[Skills (${dirCount} Total)](#skills-${dirCount}-total)`);
    expect(ref).toContain('/oh-my-claudecode:drydock [--check]');
    expect(ref).toContain('/oh-my-claudecode:launch <brief\\|spec-path> [--serial]');
    expect(ref).toContain('/oh-my-claudecode:ask-navigator <idea\\|map>');
    expect(ref).toContain('/oh-my-claudecode:harbor [sweep\\|look at #N\\|what\'s ready?]');
    for (const name of ['launch', 'drydock', 'ask-navigator', 'loft', 'harbor']) {
      expect(ref).toContain(`\`${name}\``);
    }
  });
});
