import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'git-guardrails.mjs');
const runner = join(root, 'scripts', 'run.cjs');

interface RunResult {
  code: number | null;
  stderr: string;
}

function childEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const childEnv = { ...process.env, ...env };
  if (!Object.hasOwn(env, 'OMC_GIT_GUARDRAILS'))
    delete childEnv.OMC_GIT_GUARDRAILS;
  return childEnv;
}

function runHookInput(
  input: string,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: root,
      env: childEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function runHook(
  command: string,
  env: Record<string, string>,
): Promise<RunResult> {
  return runHookInput(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env,
  );
}

function payloadWithoutCommand() {
  return JSON.stringify({ tool_name: 'Bash', tool_input: {} });
}

describe('git-guardrails hook', () => {
  const enabled = { OMC_GIT_GUARDRAILS: '1' };

  const destructive: Array<[string, string]> = [
    ['git push origin main', 'git push'],
    ['command git push origin main', 'git push'],
    ['sudo git push origin main', 'git push'],
    ['env GIT_CONFIG_NOSYSTEM=1 git push origin main', 'git push'],
    ['exec git push origin main', 'git push'],
    ['nohup git push origin main', 'git push'],
    ['time git push origin main', 'git push'],
    ["sh -c 'git push origin main'", 'git push'],
    ['bash -c "git push origin main"', 'git push'],
    ['if true; then git push origin main; fi', 'git push'],
    ['echo "$(git push origin main)"', 'git push'],
    ['echo "`git push origin main`"', 'git push'],
    ['git push --force-with-lease', 'git push'],
    ['npm test && git push', 'git push'],
    ['git status\ngit push origin main', 'git push'],
    ['git -C /tmp push origin main', 'git push'],
    ['git -c user.name=agent push origin main', 'git push'],
    ['git -C /tmp -c user.name=agent push origin main', 'git push'],
    ['git push -- --dry-run', 'git push'],
    ['git push -o --dry-run origin main', 'git push'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['git -C /tmp -c user.name=agent reset --hard HEAD~1', 'git reset --hard'],
    ['git reset -q --hard HEAD~1', 'git reset --hard'],
    ['git clean -fd', 'git clean -f'],
    ['git clean -fdx', 'git clean -f'],
    ['git clean --force', 'git clean -f'],
    ['git -c core.quotePath=false clean -f', 'git clean -f'],
    ['git branch -D feature/x', 'git branch -D'],
    ['git branch -d --force feature/x', 'git branch -D'],
    ['git branch -fd feature/x', 'git branch -D'],
    ['git branch --force --delete feature/x', 'git branch -D'],
    ['git branch --delete --force feature/x', 'git branch -D'],
    ['git -C /tmp -c user.name=agent branch -D feature/x', 'git branch -D'],
    ['git checkout .', 'git checkout . (working-tree discard)'],
    ['git checkout -- .', 'git checkout . (working-tree discard)'],
    ['git status && git checkout .', 'git checkout . (working-tree discard)'],
    [
      'git status; git checkout -- .; echo done',
      'git checkout . (working-tree discard)',
    ],
    [
      'git -C /tmp -c user.name=agent checkout .',
      'git checkout . (working-tree discard)',
    ],
    ['git restore .', 'git restore . (working-tree discard)'],
    ['git status && git restore .', 'git restore . (working-tree discard)'],
    [
      'git status; git restore .; echo done',
      'git restore . (working-tree discard)',
    ],
    ['git status\ngit restore .', 'git restore . (working-tree discard)'],
    [
      'git -C /tmp -c user.name=agent restore .',
      'git restore . (working-tree discard)',
    ],
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
    'echo git push',
    'echo "git push"',
    "echo 'git push'",
    "echo '$(git push)'",
    'echo "\\$(git push)"',
    'echo "\\`git push\\`"',
    'echo "$(printf \'git push\')"',
    "printf '%s\\n' 'git reset --hard'",
    'echo git push\ngit status',
    'git status\necho "push is ready"',
    'git push --dry-run origin main',
    'git push -n origin main',
    'git pushd',
    'git reset --soft HEAD~1',
    'git reset --soft HEAD~1\necho --hard',
    'git reset -- --hard',
    'git clean -n',
    'git clean -nf',
    'git clean -fn',
    'git clean -n\necho -f',
    'git clean -n -- -f',
    'git clean -- -f',
    'git clean -e -f',
    'git branch -d merged-branch',
    'git branch -- --delete --force',
    'git branch --format -D',
    'git checkout .github/workflows/ci.yml',
    'git checkout ./path',
    'git checkout -- ./path',
    'git restore src/foo.ts',
    'git restore ./file',
    'git restore -- ./file',
    'ls -la',
  ];

  it.each(allowed)('allows %s', async (command) => {
    const result = await runHook(command, enabled);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('registers the guard script as the Bash PreToolUse hook with a five-second timeout', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'),
    ) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string; timeout: number }>;
        }>;
      };
    };
    const bashHook = manifest.hooks.PreToolUse.find(
      ({ matcher }) => matcher === 'Bash',
    );

    expect(bashHook).toBeDefined();
    expect(bashHook?.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command',
          command: expect.stringContaining('/scripts/git-guardrails.mjs'),
          timeout: 5,
        }),
      ]),
    );
  });

  it('is disabled by default and exits promptly while stdin remains open', async () => {
    const child = spawn('node', [runner, script], {
      cwd: root,
      env: childEnvironment({}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const startedAt = performance.now();
    const exit = new Promise<RunResult & { elapsedMs: number }>(
      (resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          resolve({ code, stderr, elapsedMs: performance.now() - startedAt }),
        );
      },
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        child.kill();
        reject(new Error('default-off hook waited for stdin to close'));
      }, 1000);
    });

    child.stdin.write(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
    );
    let result: RunResult & { elapsedMs: number };
    try {
      result = await Promise.race([exit, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it('OMC_GIT_GUARDRAILS=0 disables the guard', async () => {
    const result = await runHook('git push origin main', {
      OMC_GIT_GUARDRAILS: '0',
    });
    expect(result.code).toBe(0);
  });

  it('tolerates raw payloads without a command', async () => {
    const result = await runHookInput(payloadWithoutCommand(), enabled);
    expect(result.code).toBe(0);
  });

  it.each(['not json at all', ''])(
    'fails open for malformed or absent payloads (%j)',
    async (input) => {
      const result = await runHookInput(input, enabled);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    },
  );
});
