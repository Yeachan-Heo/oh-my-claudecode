import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'git-guardrails.mjs');

interface RunResult {
  code: number | null;
  stderr: string;
}

function runHook(command: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
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
    const result = await runHook('git push origin main', {});
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
});
