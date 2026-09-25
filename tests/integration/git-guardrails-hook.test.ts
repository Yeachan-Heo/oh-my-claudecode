import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveSessionStatePathsForHook } from '../../scripts/lib/state-root.mjs';

const root = process.cwd();
const script = join(root, 'scripts', 'git-guardrails.mjs');
const runner = join(root, 'scripts', 'run.cjs');
const modeStateDirs: string[] = [];

afterAll(() => {
  for (const dir of modeStateDirs)
    rmSync(dir, { recursive: true, force: true });
});

// State resolution falls back to the home .omc root outside a Git worktree,
// so each fixture is a Git repository and the hook reads only fixture state.
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-guardrails-'));
  modeStateDirs.push(dir);
  gitInit(dir);
  return dir;
}

async function dirWithActiveMode(
  mode: string,
  active: boolean,
  sessionId = 'guardrail-test',
  sessionScoped = false,
): Promise<string> {
  const dir = freshGitDir();
  const { writePath } = await resolveSessionStatePathsForHook(
    dir,
    mode,
    sessionScoped ? sessionId : undefined,
  );
  mkdirSync(dirname(writePath), { recursive: true });
  writeFileSync(
    writePath,
    JSON.stringify({ active, session_id: sessionId }, null, 2),
  );
  return dir;
}

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
  cwd = root,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd,
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
  cwd = root,
  sessionId?: string,
): Promise<RunResult> {
  return runHookInput(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
    env,
    cwd,
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

  it('is disabled by default when there is no active mode state', async () => {
    const dir = freshGitDir();
    const result = await runHook('git push origin main', {}, dir);
    expect(result.code).toBe(0);
  });

  it('OMC_GIT_GUARDRAILS=0 exits promptly while stdin remains open', async () => {
    const child = spawn('node', [runner, script], {
      cwd: root,
      env: childEnvironment({ OMC_GIT_GUARDRAILS: '0' }),
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
        reject(new Error('explicit opt-out waited for stdin to close'));
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

  it('fails open within the hook deadline when no mode is active and stdin stays open', async () => {
    const dir = freshGitDir();
    const child = spawn('node', [runner, script], {
      cwd: dir,
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
        reject(
          new Error('default inactive-mode path exceeded the hook deadline'),
        );
      }, 4500);
    });

    child.stdin.write(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        cwd: dir,
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
    expect(result.elapsedMs).toBeLessThan(4500);
  }, 6000);

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

  it.each(['not json at all', '', 'null'])(
    'fails open for malformed or absent payloads (%j)',
    async (input) => {
      const result = await runHookInput(input, enabled);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    },
  );

  describe('unattended-mode auto-enable', () => {
    it('blocks destructive git while an active legacy mode state exists', async () => {
      const dir = await dirWithActiveMode('ralph', true);
      const result = await runHook(
        'git push origin main',
        {},
        dir,
        'guardrail-test',
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('unattended ralph run is active');
    });

    it('auto-enable covers each guarded mode', async () => {
      for (const mode of ['autopilot', 'team', 'ultragoal']) {
        const dir = await dirWithActiveMode(mode, true);
        const result = await runHook(
          'git reset --hard',
          {},
          dir,
          'guardrail-test',
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(`unattended ${mode} run is active`);
      }
    });

    it('enables a session-scoped state only for its owning session', async () => {
      const dir = await dirWithActiveMode('ralph', true, 'session-a', true);
      const owner = await runHook('git push origin main', {}, dir, 'session-a');
      const other = await runHook('git push origin main', {}, dir, 'session-b');
      expect(owner.code).toBe(2);
      expect(other.code).toBe(0);
    });

    it('does not use a legacy active state owned by another session', async () => {
      const dir = await dirWithActiveMode('ralph', true, 'session-a');
      const result = await runHook(
        'git push origin main',
        {},
        dir,
        'session-b',
      );
      expect(result.code).toBe(0);
    });

    it('does not auto-enable without a session identity', async () => {
      const dir = await dirWithActiveMode('ralph', true);
      const result = await runHook('git push origin main', {}, dir);
      expect(result.code).toBe(0);
    });

    it('OMC_GIT_GUARDRAILS=0 wins over an active mode state', async () => {
      const dir = await dirWithActiveMode('ralph', true);
      const result = await runHook(
        'git push origin main',
        { OMC_GIT_GUARDRAILS: '0' },
        dir,
        'guardrail-test',
      );
      expect(result.code).toBe(0);
    });

    it('an inactive mode state does not enable the guard', async () => {
      const dir = await dirWithActiveMode('ralph', false);
      const result = await runHook(
        'git push origin main',
        {},
        dir,
        'guardrail-test',
      );
      expect(result.code).toBe(0);
    });

    it('an active mode state still allows safe commands', async () => {
      const dir = await dirWithActiveMode('autopilot', true);
      const result = await runHook('git status', {}, dir, 'guardrail-test');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    });
  });
});
