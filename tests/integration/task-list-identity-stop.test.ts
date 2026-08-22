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

  let hook = pluginHookMjs;
  if (kind === 'cjs') {
    hook = pluginHookCjs;
  } else if (kind === 'template') {
    // The installer template ships as a directory of standalone scripts
    // (templates/hooks/** including lib/), so copy the whole tree like a real
    // install does and run the copied persistent-mode.mjs.
    const installed = join(dir, 'installed-hooks');
    cpSync(join(root, 'templates', 'hooks'), installed, { recursive: true });
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

function ultraworkStatePath(f: Fixture): string {
  return join(f.project, '.omc', 'state', 'sessions', 'stop-session', 'ultrawork-state.json');
}

function writeActiveUltrawork(f: Fixture) {
  const statePath = ultraworkStatePath(f);
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
      reinforcement_count: 0,
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

// Identity contract under test (issue #3732): the Stop hook reads Claude Code's
// native task store at ~/.claude/tasks/<identity>/ where <identity> is the
// CLAUDE_CODE_TASK_LIST_ID override when set and valid, else the session id.
// Invalid/empty overrides fall back to the session id; no implicit team
// identity is inferred (hook payloads expose none).
describe.each(['mjs', 'cjs', 'template'] as const)(
  'Stop hook task-store identity resolution (%s)',
  (kind) => {
    it('counts tasks from the CLAUDE_CODE_TASK_LIST_ID override store when set and valid', () => {
      const f = makeFixture(kind);
      writeActiveUltrawork(f);
      // Override store has one pending task; the session store is absent.
      writeTaskStore(f.claudeConfigDir, 'team-list-override', ['pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: 'team-list-override' });

      // Claude Code writes tasks under the override identity, so the Stop hook
      // must read the same store or successful writes look vanished.
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('1 incomplete Tasks remain');
    });

    it('prefers the override store over a non-empty session store', () => {
      const f = makeFixture(kind);
      const statePath = writeActiveUltrawork(f);
      // Session store has two pending tasks; the override store is complete.
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending', 'pending']);
      writeTaskStore(f.claudeConfigDir, 'team-list-override', ['completed']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: 'team-list-override' });

      // Identity resolution, not counting heuristics, is under test: the two
      // session-store tasks must be invisible because the override identity
      // points elsewhere. The variants express "nothing incomplete" two ways
      // (the CJS/template mirrors auto-clear per #2419; the plugin ESM script
      // still blocks), but neither may report the session store's tasks.
      const reason = String(result.reason ?? '');
      expect(reason).not.toContain('1 incomplete');
      expect(reason).not.toContain('2 incomplete');
      if (result.decision === 'block') {
        expect(reason).toContain('No incomplete tasks detected');
      } else {
        expect(result).toEqual({ continue: true, suppressOutput: true });
        expect(JSON.parse(readFileSync(statePath, 'utf8')).deactivated_reason).toBe('task_completion');
      }
    });

    it('falls back to the session id store when the override is invalid (path traversal)', () => {
      const f = makeFixture(kind);
      writeActiveUltrawork(f);
      // Session store has one in_progress task; the traversal target must not be read.
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['in_progress']);
      writeTaskStore(f.claudeConfigDir, 'etc', ['pending', 'pending', 'pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: '../etc' });

      expect(result.decision).toBe('block');
      expect(result.reason).toContain('1 incomplete Tasks remain');
      expect(result.reason).not.toContain('3 incomplete Tasks remain');
    });

    it('falls back to the session id store when the override is whitespace', () => {
      const f = makeFixture(kind);
      writeActiveUltrawork(f);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

      const result = invokeStop(f, { CLAUDE_CODE_TASK_LIST_ID: '   ' });

      expect(result.decision).toBe('block');
      expect(result.reason).toContain('1 incomplete Tasks remain');
    });

    it('reads the session id store when no override is set', () => {
      const f = makeFixture(kind);
      writeActiveUltrawork(f);
      // A foreign store exists but must not be read without an override.
      writeTaskStore(f.claudeConfigDir, 'team-list-override', ['pending', 'pending']);
      writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

      const result = invokeStop(f, {});

      expect(result.decision).toBe('block');
      expect(result.reason).toContain('1 incomplete Tasks remain');
    });
  },
);

describe('Stop hook task-store identity mirror parity', () => {
  it('keeps the observable override/fallback contract identical across mjs, cjs, and template variants', () => {
    // The executable parity is proven by the describe.each suite above running
    // the same fixtures through each shipped variant. This structural guard
    // catches accidental removal of the override handling from any single
    // mirror, including the TypeScript reader of the same store.
    const sources = [
      ['scripts/persistent-mode.mjs', readFileSync(pluginHookMjs, 'utf8')],
      ['scripts/persistent-mode.cjs', readFileSync(pluginHookCjs, 'utf8')],
      ['templates/hooks/persistent-mode.mjs', readFileSync(join(root, 'templates', 'hooks', 'persistent-mode.mjs'), 'utf8')],
      ['src/hooks/todo-continuation/index.ts', readFileSync(join(root, 'src', 'hooks', 'todo-continuation', 'index.ts'), 'utf8')],
    ] as const;
    for (const [name, source] of sources) {
      expect(source, name).toContain('CLAUDE_CODE_TASK_LIST_ID');
    }
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
    // base child env in invokeStop() deletes it, so the no-override scenario
    // stays deterministic and resolves the session store.
    previousOverride = process.env.CLAUDE_CODE_TASK_LIST_ID;
    hadPrevious = true;
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'inherited-override';

    const f = makeFixture('mjs');
    writeActiveUltrawork(f);
    // The inherited store is non-empty; the session store is the identity the
    // no-override child must resolve to.
    writeTaskStore(f.claudeConfigDir, 'inherited-override', ['pending', 'pending']);
    writeTaskStore(f.claudeConfigDir, 'stop-session', ['pending']);

    const result = invokeStop(f, {});

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('1 incomplete Tasks remain');
    expect(result.reason).not.toContain('2 incomplete Tasks remain');
  });
});
