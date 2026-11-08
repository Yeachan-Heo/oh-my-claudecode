import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutoresearchMissionContract } from '../contracts.js';
import {
  assertResetSafeWorktree,
  decideAutoresearchOutcome,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
  resumeAutoresearchRuntime,
} from '../runtime.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-parity-extra-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function makeContract(repo: string, keepPolicy?: 'score_improvement' | 'pass_only'): Promise<AutoresearchMissionContract> {
  const missionDir = join(repo, 'missions', 'demo');
  await mkdir(missionDir, { recursive: true });
  await mkdir(join(repo, 'scripts'), { recursive: true });
  const missionFile = join(missionDir, 'mission.md');
  const sandboxFile = join(missionDir, 'sandbox.md');
  const missionContent = '# Mission\nSolve the task.\n';
  const keepPolicyLine = keepPolicy ? `  keep_policy: ${keepPolicy}\n` : '';
  const sandboxContent = `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n${keepPolicyLine}---\nStay inside the mission boundary.\n`;
  await writeFile(missionFile, missionContent, 'utf-8');
  await writeFile(sandboxFile, sandboxContent, 'utf-8');
  await writeFile(join(repo, 'score.txt'), '1\n', 'utf-8');
  await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true, score: 1 }));\n", 'utf-8');
  execFileSync('git', ['add', 'missions/demo/mission.md', 'missions/demo/sandbox.md', 'scripts/eval.js', 'score.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add autoresearch fixtures'], { cwd: repo, stdio: 'ignore' });
  return {
    missionDir,
    repoRoot: repo,
    missionFile,
    sandboxFile,
    missionRelativeDir: 'missions/demo',
    missionContent,
    sandboxContent,
    sandbox: {
      frontmatter: { evaluator: { command: 'node scripts/eval.js', format: 'json', ...(keepPolicy ? { keep_policy: keepPolicy } : {}) } },
      evaluator: { command: 'node scripts/eval.js', format: 'json', ...(keepPolicy ? { keep_policy: keepPolicy } : {}) },
      body: 'Stay inside the mission boundary.',
    },
    missionSlug: 'missions-demo',
  };
}

describe('autoresearch runtime parity extras', () => {
  it('treats allowed runtime files as reset-safe and blocks unrelated dirt', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t020000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t020000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T020000Z' });

      await writeFile(join(worktreePath, 'results.tsv'), 'iteration\tcommit\tpass\tscore\tstatus\tdescription\n', 'utf-8');
      await writeFile(join(worktreePath, 'run.log'), 'ok\n', 'utf-8');
      expect(() => assertResetSafeWorktree(worktreePath)).not.toThrow();

      await writeFile(join(worktreePath, 'scratch.tmp'), 'nope\n', 'utf-8');
      expect(() => assertResetSafeWorktree(worktreePath)).toThrow(/autoresearch_reset_requires_clean_worktree/i);

      const manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      expect(manifest.results_file).toBe(join(worktreePath, 'results.tsv'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });


  it('fresh prepare tolerates bootstrap dirt even when the worktree path is not normalized', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreeRoot = `${repo.split('/').pop()}.omc-worktrees`;
      const worktreePath = `${repo}/../${worktreeRoot}/autoresearch-missions-demo-20260314t021500z`;
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t021500z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);

      await expect(
        prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T021500Z' }),
      ).resolves.toMatchObject({ worktreePath });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects concurrent fresh runs via the repo-root active-run lock', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePathA = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t030000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t030000z', worktreePathA, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContractA = await materializeAutoresearchMissionToWorktree(contract, worktreePathA);
      await prepareAutoresearchRuntime(worktreeContractA, repo, worktreePathA, { runTag: '20260314T030000Z' });

      const worktreePathB = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t030500z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t030500z', worktreePathB, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContractB = await materializeAutoresearchMissionToWorktree(contract, worktreePathB);

      await expect(
        prepareAutoresearchRuntime(worktreeContractB, repo, worktreePathB, { runTag: '20260314T030500Z' }),
      ).rejects.toThrow(/autoresearch_active_run_exists/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resumes a running manifest and rejects missing worktrees', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t040000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t040000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T040000Z' });
      const statePath = join(repo, '.omc', 'state', 'autoresearch-state.json');
      const idleState = {
        schema_version: 1,
        active: false,
        run_id: runtime.runId,
        mission_slug: contract.missionSlug,
        repo_root: repo,
        worktree_path: worktreePath,
        status: 'idle',
        updated_at: '2026-03-14T04:05:00.000Z',
      };
      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');

      const resumed = await resumeAutoresearchRuntime(repo, runtime.runId);
      expect(resumed.runId).toBe(runtime.runId);
      expect(resumed.worktreePath).toBe(worktreePath);

      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');
      await rm(worktreePath, { recursive: true, force: true });
      await expect(
        resumeAutoresearchRuntime(repo, runtime.runId),
      ).rejects.toThrow(/autoresearch_resume_missing_worktree/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });


  it('resume only tolerates the active run bootstrap dirt', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t041500z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t041500z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T041500Z' });
      const statePath = join(repo, '.omc', 'state', 'autoresearch-state.json');
      const idleState = {
        schema_version: 1,
        active: false,
        run_id: runtime.runId,
        mission_slug: contract.missionSlug,
        repo_root: repo,
        worktree_path: worktreePath,
        status: 'idle',
        updated_at: '2026-03-14T04:16:00.000Z',
      };

      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');
      await expect(resumeAutoresearchRuntime(repo, runtime.runId)).resolves.toMatchObject({ runId: runtime.runId });

      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');
      await writeFile(join(worktreePath, 'missions', 'demo', 'extra.md'), 'unexpected\n', 'utf-8');
      await expect(resumeAutoresearchRuntime(repo, runtime.runId)).rejects.toThrow(/autoresearch_reset_requires_clean_worktree/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('decides ambiguous vs keep based on keep_policy semantics', () => {
    const candidate = {
      status: 'candidate' as const,
      candidate_commit: 'abc1234',
      base_commit: 'base1234',
      description: 'candidate',
      notes: [] as string[],
      created_at: '2026-03-14T05:00:00.000Z',
    };

    const ambiguous = decideAutoresearchOutcome(
      { keep_policy: 'score_improvement', last_kept_score: null },
      candidate,
      { command: 'node eval.js', ran_at: '2026-03-14T05:00:01.000Z', status: 'pass', pass: true, exit_code: 0 },
    );
    expect(ambiguous.decision).toBe('ambiguous');
    expect(ambiguous.keep).toBe(false);

    const kept = decideAutoresearchOutcome(
      { keep_policy: 'pass_only', last_kept_score: null },
      candidate,
      { command: 'node eval.js', ran_at: '2026-03-14T05:00:01.000Z', status: 'pass', pass: true, exit_code: 0 },
    );
    expect(kept.decision).toBe('keep');
    expect(kept.keep).toBe(true);
  });

  it('resume rejects terminal manifests', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t050000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t050000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T050000Z' });
      const manifest = JSON.parse(await readFile(runtime.manifestFile, 'utf-8')) as Record<string, unknown>;
      manifest.status = 'completed';
      await writeFile(runtime.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
      await writeFile(join(repo, '.omc', 'state', 'autoresearch-state.json'), `${JSON.stringify({
        schema_version: 1,
        active: false,
        run_id: runtime.runId,
        mission_slug: contract.missionSlug,
        repo_root: repo,
        worktree_path: worktreePath,
        status: 'completed',
        updated_at: '2026-03-14T05:05:00.000Z',
      }, null, 2)}\n`, 'utf-8');

      await expect(
        resumeAutoresearchRuntime(repo, runtime.runId),
      ).rejects.toThrow(/autoresearch_resume_terminal_run/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records noop and abort candidate branches explicitly', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t060000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t060000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T060000Z' });

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'noop',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'no useful change',
        notes: ['noop branch'],
        created_at: '2026-03-14T06:01:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      expect(await processAutoresearchCandidate(worktreeContract, manifest, repo)).toBe('noop');

      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'abort',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'operator stop',
        notes: ['abort branch'],
        created_at: '2026-03-14T06:02:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      expect(await processAutoresearchCandidate(worktreeContract, manifest, repo)).toBe('abort');

      const results = await readFile(runtime.resultsFile, 'utf-8');
      expect(results).toMatch(/^1\t.+\t\t\tnoop\tno useful change$/m);
      expect(results).toMatch(/^2\t.+\t\t\tabort\toperator stop$/m);

      const finalManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      expect(finalManifest.status).toBe('stopped');
      expect(finalManifest.stop_reason).toBe('candidate abort');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('discard reset tolerates only exact bootstrap dirt', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t061500z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t061500z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T061500Z' });

      await writeFile(join(worktreePath, 'score.txt'), '0\n', 'utf-8');
      execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worse score'], { cwd: worktreePath, stdio: 'ignore' });
      const worseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: worseCommit,
        base_commit: manifest.last_kept_commit,
        description: 'worse score',
        notes: ['discard should reset safely'],
        created_at: '2026-03-14T06:15:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      await expect(processAutoresearchCandidate(worktreeContract, manifest, repo)).resolves.toBe('discard');

      await writeFile(join(worktreePath, 'score.txt'), '0\n', 'utf-8');
      execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worse score again'], { cwd: worktreePath, stdio: 'ignore' });
      const worseAgainCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      await writeFile(join(worktreePath, 'missions', 'demo', 'extra.md'), 'unexpected\n', 'utf-8');

      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: worseAgainCommit,
        base_commit: manifest.last_kept_commit,
        description: 'worse again',
        notes: ['discard should fail on unrelated dirt'],
        created_at: '2026-03-14T06:16:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      await expect(processAutoresearchCandidate(worktreeContract, manifest, repo)).rejects.toThrow(/autoresearch_reset_requires_clean_worktree/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('interrupted handling tolerates only exact bootstrap dirt', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t061700z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t061700z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T061700Z' });

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'interrupted',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'interrupted cleanly',
        notes: ['bootstrap dirt only'],
        created_at: '2026-03-14T06:17:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      await expect(processAutoresearchCandidate(worktreeContract, manifest, repo)).resolves.toBe('interrupted');

      await writeFile(join(worktreePath, 'missions', 'demo', 'extra.md'), 'unexpected\n', 'utf-8');
      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'interrupted',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'interrupted with unrelated dirt',
        notes: ['should fail'],
        created_at: '2026-03-14T06:18:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      await expect(processAutoresearchCandidate(worktreeContract, manifest, repo)).resolves.toBe('error');
      const failedManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      expect(failedManifest.status).toBe('failed');
      expect(failedManifest.stop_reason).toMatch(/interrupted dirty worktree requires operator intervention/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

});
