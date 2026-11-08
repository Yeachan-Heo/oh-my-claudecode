import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The three shipped Stop-hook variants that must agree on task-store identity
// resolution (issue #3732): the plugin ESM script, its CJS mirror, and the
// installer template.
const pluginHookMjs = join(root, 'scripts', 'persistent-mode.mjs');
const pluginHookCjs = join(root, 'scripts', 'persistent-mode.cjs');

const created: string[] = [];

function makeFixture(kind: 'mjs' | 'cjs' | 'template') {
  const dir = mkdtempSync(join(tmpdir(), `task-override-${kind}-`));
  created.push(dir);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  const claudeConfigDir = join(home, 'claude-config');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init'], { cwd: project, stdio: 'pipe' });

  let hook = pluginHookMjs;
  if (kind === 'cjs') {
    hook = pluginHookCjs;
  } else if (kind === 'template') {
    // The installer template ships as a directory of standalone scripts
    // (templates/hooks/** including lib/), so copy the whole tree like a real
    // install does and run the copied persistent-mode.mjs.
    const installed = join(dir, 'installed-hooks');
    cpSync(join(root, 'templates', 'hooks'), installed, { recursive: true });
    execFileSync('npx', ['tsx', '-e', `import { provisionStandaloneStateLockBridge } from './src/installer/index.ts'; provisionStandaloneStateLockBridge(${JSON.stringify(root)}, ${JSON.stringify(join(installed, 'lib', 'state-lock.mjs'))});`], { cwd: root, stdio: 'inherit' });
    hook = join(installed, 'persistent-mode.mjs');
  }

  return { dir, home, project, claudeConfigDir, hook, kind };
}

type Fixture = ReturnType<typeof makeFixture>;

function writeTaskStore(claudeConfigDir: string, identity: string, statuses: string[]) {
  const taskDir = join(claudeConfigDir, 'tasks', identity);
  mkdirSync(taskDir, { recursive: true });
  statuses.forEach((status, index) => {
    writeFileSync(
      join(taskDir, `${index + 1}.json`),
      JSON.stringify({ id: String(index + 1), subject: `task-${index + 1}`, status }),
    );
  });
}

function ralphStatePath(f: Fixture): string {
  return join(f.project, '.omc', 'state', 'sessions', 'stop-session', 'ralph-state.json');
}

function writeActiveRalph(f: Fixture) {
  const statePath = ralphStatePath(f);
  mkdirSync(dirname(statePath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      session_id: 'stop-session',
      project_path: f.project,
      started_at: now,
      last_checked_at: now,
      iteration: 1,
      max_iterations: 100,
      prompt: 'finish tracked work',
    }),
  );
  return statePath;
}

function invokeStop(f: Fixture, extraEnv: Record<string, string> = {}) {
  // Start from a deterministic base: an inherited CLAUDE_CODE_TASK_LIST_ID
  // from the parent process would silently change the no-override scenarios
  // (issue #3732 review). Delete it here; extraEnv re-applies an override for
  // the tests that need one.
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_CODE_TASK_LIST_ID;
  const stdout = execFileSync(process.execPath, [f.hook], {
    cwd: f.project,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'stop-session', cwd: f.project }),
    encoding: 'utf8',
    env: {
      ...baseEnv,
      HOME: f.home,
      USERPROFILE: f.home,
      CLAUDE_CONFIG_DIR: f.claudeConfigDir,
      OMC_STATE_DIR: '',
      OMC_PERSISTENT_MODE_TIMEOUT_MS: '3000',
      ...extraEnv,
    },
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim());
}

afterEach(() => {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
});

// Issue #3732 history: the Stop hook's task-store identity reader
// (~/.claude/tasks/<identity>/ with the CLAUDE_CODE_TASK_LIST_ID override)
// shipped only inside the ultrawork reinforcement block. Ultrawork is retired
// (#3827), so the shipped stop variants no longer read the native task store
// at all; the override-aware reader lives on in
// src/hooks/todo-continuation/index.ts (covered by unit tests) and runs at
// SessionStart. These executable checks pin the retired stop contract: no
// shipped variant may resurrect task-store counting or leak the override
// into stop decisions.
describe.each(['mjs', 'cjs', 'template'] as const)(
  'Stop hook task-store independence after ultrawork retirement (%s)',
  (kind) => {
    it('blocks on ralph state without consulting any task store', () => {
      const f = makeFixture(kind);
      writeActiveRalph(f);
      // Override store and session store both exist with pending work; neither
      // may surface in the stop decision now that ultrawork counting is gone.
      writeTaskStore(f.claudeConfigDir, 'team-list-override', ['pending']);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending', 'pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: 'team-list-override' });

      expect(result.decision).toBe('block');
      expect(String(result.reason)).toContain('RALPH LOOP');
      expect(String(result.reason)).not.toContain('incomplete Tasks remain');
      expect(String(result.reason)).not.toContain('No incomplete tasks detected');
    });

    it('allows stop without mode state even when task stores hold pending work', () => {
      const f = makeFixture(kind);
      writeTaskStore(f.claudeConfigDir, 'team-list-override', ['pending']);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: 'team-list-override' });

      expect(result).toEqual({ continue: true, suppressOutput: true });
    });

    it('does not resurrect task-store counting for a traversal override', () => {
      const f = makeFixture(kind);
      writeActiveRalph(f);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['in_progress']);
      writeTaskStore(f.claudeConfigDir, 'etc', ['pending', 'pending', 'pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: '../etc' });

      expect(result.decision).toBe('block');
      expect(String(result.reason)).not.toContain('incomplete Tasks remain');
    });

    it('does not resurrect task-store counting for a whitespace override', () => {
      const f = makeFixture(kind);
      writeActiveRalph(f);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: '   ' });

      expect(result.decision).toBe('block');
      expect(String(result.reason)).not.toContain('incomplete Tasks remain');
    });
  },
);

describe('Stop hook task-store identity mirror parity', () => {
  it('keeps the override-aware reader confined to the live todo-continuation surface', () => {
    // The stop variants no longer read the native task store; only the
    // SessionStart todo-continuation reader still resolves the override
    // identity. Guard against the retired reader sneaking back into any
    // shipped stop mirror while the live reader keeps the contract.
    const stoppedSources = [
      ['scripts/persistent-mode.mjs', readFileSync(pluginHookMjs, 'utf8')],
      ['scripts/persistent-mode.cjs', readFileSync(pluginHookCjs, 'utf8')],
      ['templates/hooks/persistent-mode.mjs', readFileSync(join(root, 'templates', 'hooks', 'persistent-mode.mjs'), 'utf8')],
    ] as const;
    for (const [name, source] of stoppedSources) {
      expect(source, name).not.toContain('CLAUDE_CODE_TASK_LIST_ID');
    }
    expect(
      readFileSync(join(root, 'src', 'hooks', 'todo-continuation', 'index.ts'), 'utf8'),
      'src/hooks/todo-continuation/index.ts',
    ).toContain('CLAUDE_CODE_TASK_LIST_ID');
  });
});

describe('Stop hook inherited task-list override isolation (issue #3732 review)', () => {
  let previousOverride: string | undefined;
  let hadPrevious = false;

  // Restore the parent env in cleanup even when the assertion fails.
  afterEach(() => {
    if (hadPrevious) {
      if (previousOverride === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID;
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousOverride;
      hadPrevious = false;
    }
  });

  it('ignores an inherited CLAUDE_CODE_TASK_LIST_ID in the no-override child env', () => {
    // Simulate a parent process that already has the override exported: the
    // base child env in invokeStop() deletes it, so the retired stop variants
    // cannot be influenced by an inherited override.
    previousOverride = process.env.CLAUDE_CODE_TASK_LIST_ID;
    hadPrevious = true;
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'inherited-override';

    const f = makeFixture('mjs');
    writeActiveRalph(f);
    writeTaskStore(f.claudeConfigDir, 'inherited-override', ['pending', 'pending']);
    writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

    const result = invokeStop(f, {});

    expect(result.decision).toBe('block');
    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('incomplete Tasks remain');
  });
});
