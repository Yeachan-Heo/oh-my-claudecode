import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'git-guardrails.mjs');
const modeStateDirs: string[] = [];

afterAll(() => {
  for (const dir of modeStateDirs) rmSync(dir, { recursive: true, force: true });
});

// The state resolver falls back to the home .omc root when the directory is
// not inside a git repo — so every fixture directory must be a git repo for
// its state files to be the ones the hook actually reads.
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-guardrails-'));
  modeStateDirs.push(dir);
  gitInit(dir);
  return dir;
}

function dirWithActiveMode(mode: string, active: boolean): string {
  const dir = freshGitDir();
  const statePath = join(dir, '.omc', 'state', `${mode}-state.json`);
  mkdirSync(join(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ active, session_id: 'guardrail-test' }, null, 2));
  return dir;
}

interface RunResult {
  code: number | null;
  stderr: string;
}

function runHook(command: string, env: Record<string, string>, cwd: string = root): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
    child.stdin.end();
  });
}

function payloadWithoutCommand() {
  return JSON.stringify({ tool_name: 'Bash', tool_input: {} });
}

describe('git-guardrails hook', () => {
  const enabled = { OMC_GIT_GUARDRAILS: '1' };

  const destructive: Array<[string, string]> = [
    ['git push origin main', 'git push'],
    ['git push --force-with-lease', 'git push'],
    ['npm test && git push', 'git push'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['git clean -fd', 'git clean -f'],
    ['git clean --force', 'git clean -f'],
    ['git branch -D feature/x', 'git branch -D'],
    ['git checkout .', 'git checkout . (working-tree discard)'],
    ['git checkout -- .', 'git checkout . (working-tree discard)'],
    ['git restore .', 'git restore . (working-tree discard)'],
  ];

  it.each(destructive)('blocks %s', async (command, label) => {
    const result = await runHook(command, enabled);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`blocked "${label}"`);
    expect(result.stderr).toContain('You do not have authority');
  });

  const allowed = [
    'git status',
    'git add -A && git commit -m "fix: safe work"',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git branch -d merged-branch',
    'git checkout .github/workflows/ci.yml',
    'git restore src/foo.ts',
    'ls -la',
  ];

  it.each(allowed)('allows %s', async (command) => {
    const result = await runHook(command, enabled);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('is disabled by default', async () => {
    const dir = freshGitDir();
    const result = await runHook('git push origin main', {}, dir);
    expect(result.code).toBe(0);
  });

  it('OMC_GIT_GUARDRAILS=0 wins even over =1', async () => {
    const result = await runHook('git push origin main', { OMC_GIT_GUARDRAILS: '0' });
    expect(result.code).toBe(0);
  });

  it('tolerates payloads without a command', async () => {
    const result = await runHook(payloadWithoutCommand(), enabled);
    expect(result.code).toBe(0);
  });

  it('tolerates non-JSON stdin', async () => {
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn('node', [script], {
        cwd: root,
        env: { ...process.env, ...enabled },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
      child.stdin.write('not json at all');
      child.stdin.end();
    });
    expect(result.code).toBe(0);
  });

  describe('unattended-mode auto-enable', () => {
    it('blocks destructive git while an active mode state exists, without OMC_GIT_GUARDRAILS', async () => {
      const dir = dirWithActiveMode('ralph', true);
      const result = await runHook('git push origin main', {}, dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('unattended ralph run is active');
    });

    it('auto-enable covers each guarded mode', async () => {
      for (const mode of ['autopilot', 'team', 'ultragoal']) {
        const dir = dirWithActiveMode(mode, true);
        const result = await runHook('git reset --hard', {}, dir);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(`unattended ${mode} run is active`);
      }
    });

    it('OMC_GIT_GUARDRAILS=0 wins over an active mode state', async () => {
      const dir = dirWithActiveMode('ralph', true);
      const result = await runHook('git push origin main', { OMC_GIT_GUARDRAILS: '0' }, dir);
      expect(result.code).toBe(0);
    });

    it('an inactive mode state does not enable the guard', async () => {
      const dir = dirWithActiveMode('ralph', false);
      const result = await runHook('git push origin main', {}, dir);
      expect(result.code).toBe(0);
    });

    it('an active mode state still allows safe commands', async () => {
      const dir = dirWithActiveMode('autopilot', true);
      const result = await runHook('git status', {}, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    });
  });
});
