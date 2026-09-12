import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync as rawMkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { teamStateRoot } from '../state-paths.js';

function teamStatePath(cwd: string, relativePath: string): string {
  return join(teamStateRoot(cwd, 'test-team'), relativePath);
}
import { tmpdir } from 'os';

/**
 * Tests for Gemini prompt-mode (headless) spawn flow.
 *
 * Gemini CLI v0.29.7+ uses an Ink-based TUI that does not receive keystrokes
 * via tmux send-keys. The fix passes the initial instruction via the `-i` flag
 * (interactive mode) so the TUI is bypassed entirely. Trust-confirm and send-keys
 * notification are skipped for prompt-mode agents.
 *
 * See: https://github.com/anthropics/claude-code/issues/1000
 */

// Track all tmux calls made during spawn
const tmuxCalls = vi.hoisted(() => ({
  args: [] as string[][],
  capturePaneText: '❯ ready\n',
  lastLiteralSend: '',
  splitPaneOutput: '%42\n',
  failCommands: [] as string[],
  afterSplit: null as (() => void) | null,
  afterKillPane: null as (() => void) | null,
}));

beforeEach(() => {
  vi.stubEnv('TMUX', 'fixture-tmux-session');
  vi.stubEnv('CMUX_SURFACE_ID', '');
  vi.stubEnv('CMUX_WORKSPACE_ID', '');
});
afterEach(() => vi.unstubAllEnvs());

let fixtureRoot: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousStateDir: string | undefined;
function mkdtempSync(prefix: string): string {
  const root = rawMkdtempSync(prefix);
  if (!fixtureRoot) {
    fixtureRoot = root;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
  }
  return root;
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify: utilPromisify } = await import('util');

  function runMock(args: string[]): { stdout: string; stderr: string } {
    const command = args[0] ?? '';
    if (command === 'split-window') {
      tmuxCalls.afterSplit?.();
      tmuxCalls.afterSplit = null;
    } else if (command === 'kill-pane') {
      tmuxCalls.afterKillPane?.();
      tmuxCalls.afterKillPane = null;
    }

    // Launch commands and inbox text use literal send-keys. Notify regression
    // cases fail only submit keys, while a plain send-keys failure exercises
    // provider launch cleanup before the pane is registered in runtime state.
    const lastArg = args[args.length - 1] ?? '';
    const failureKey = command !== 'send-keys'
      ? command
      : args.includes('-l')
        ? ''
        : tmuxCalls.failCommands.includes('notify-send-keys') && ['C-m', 'Tab', '1'].includes(lastArg)
          ? 'notify-send-keys'
          : command;
    if (failureKey && tmuxCalls.failCommands.includes(failureKey)) {
      throw new Error(`tmux_${failureKey}_failed`);
    }

    if (command === 'split-window') {
      return { stdout: tmuxCalls.splitPaneOutput, stderr: '' };
    }
    if (command === 'send-keys' && args.includes('-l')) {
      tmuxCalls.lastLiteralSend = args[args.length - 1] ?? '';
      return { stdout: '', stderr: '' };
    }
    if (command === 'send-keys') {
      tmuxCalls.lastLiteralSend = '';
      return { stdout: '', stderr: '' };
    }
    if (command === 'capture-pane') {
      return { stdout: `${tmuxCalls.lastLiteralSend}\n${tmuxCalls.capturePaneText}`, stderr: '' };
    }
    if (command === 'display-message') {
      const format = args[args.length - 1] ?? '';
      return { stdout: format.includes('pane_current_command') ? '0 zsh\n' : '0\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }

  function mockExecFile(_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) {
    tmuxCalls.args.push(args);
    try {
      const result = runMock(args);
      cb(null, result.stdout, result.stderr);
    } catch (error) {
      cb(error instanceof Error ? error : new Error(String(error)), '', '');
    }
    return {} as never;
  }

  // Attach custom promisify so util.promisify(execFile) returns {stdout, stderr}
  (mockExecFile as any)[utilPromisify.custom] = async (_cmd: string, args: string[]) => {
    tmuxCalls.args.push(args);
    return runMock(args);
  };

  function mockExec(cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) {
    if (cmd.includes('display-message') && cmd.includes('#{window_width}')) {
      cb(null, '160\n', '');
    } else if (cmd.includes('display-message') && cmd.includes('#{pane_current_command}')) {
      cb(null, '0 zsh\n', '');
    } else {
      cb(null, '', '');
    }
    return {} as never;
  }

  (mockExec as any)[utilPromisify.custom] = async (cmd: string) => {
    if (cmd.includes('display-message') && cmd.includes('#{window_width}')) {
      return { stdout: '160\n', stderr: '' };
    }
    if (cmd.includes('display-message') && cmd.includes('#{pane_current_command}')) {
      return { stdout: '0 zsh\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  return {
    ...actual,
    spawnSync: vi.fn((cmd: string, args: string[] = []) => {
      if (args[0] === '--version') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'which' || cmd === 'where') {
        const bin = args[0] ?? 'unknown';
        return { status: 0, stdout: `/usr/bin/${bin}\n`, stderr: '' };
      }
      return actual.spawnSync(cmd, args, { encoding: 'utf-8' });
    }),
    exec: mockExec,
    execFile: mockExecFile,
  };
});

import { spawnWorkerForTask, type TeamRuntime } from '../runtime.js';

function makeRuntime(cwd: string, agentType: 'gemini' | 'codex' | 'claude' | 'grok' | 'antigravity'): TeamRuntime {
  return {
    teamName: 'test-team',
    sessionName: 'test-session:0',
    leaderPaneId: '%0',
    ownsWindow: false,
    config: {
      teamName: 'test-team',
      workerCount: 1,
      agentTypes: [agentType],
      tasks: [{ subject: 'Test task', description: 'Do something' }],
      cwd,
    },
    workerNames: ['worker-1'],
    workerPaneIds: [],
    activeWorkers: new Map(),
    cwd,
    resolvedBinaryPaths: {
      [agentType]: `/usr/local/bin/${agentType}`,
    },
  };
}

function setupTaskDir(cwd: string): void {
  const tasksDir = teamStatePath(cwd, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, 'task-1.json'), JSON.stringify({
    id: '1',
    subject: 'Test task',
    description: 'Do something',
    status: 'pending',
    owner: null,
  }));
  const workerDir = teamStatePath(cwd, 'workers/worker-1');
  mkdirSync(workerDir, { recursive: true });
}

function denyTaskReset(cwd: string): void {
  writeFileSync(
    teamStatePath(cwd, 'tasks/task-1.lock'),
    JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
  );
}

function resetTmuxFailureState(): void {
  tmuxCalls.splitPaneOutput = '%42\n';
  tmuxCalls.failCommands = [];
  tmuxCalls.afterSplit = null;
  tmuxCalls.afterKillPane = null;
}


describe('spawnWorkerForTask – prompt mode and interactive worker launch', () => {
  let cwd: string;

  beforeEach(() => {
    tmuxCalls.args = [];
    tmuxCalls.capturePaneText = '❯ ready\n';
    tmuxCalls.lastLiteralSend = '';
    resetTmuxFailureState();
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
    cwd = mkdtempSync(join(tmpdir(), 'runtime-gemini-prompt-'));
    process.env.OMC_STATE_DIR = join(cwd, 'omc-state');
    setupTaskDir(cwd);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousStateDir;
    fixtureRoot = undefined;
    previousHome = undefined;
    previousUserProfile = undefined;
    previousStateDir = undefined;
  });

  it('gemini worker launch args include -p flag with inbox path', async () => {
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // Find the send-keys call that launches the worker (contains -l flag)
    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Should contain -p flag for prompt mode
    expect(launchCmd).toContain("'-p'");
    // Should contain the inbox path reference
    expect(launchCmd).toContain(teamStatePath(cwd, 'workers/worker-1/inbox.md'));
    expect(launchCmd).toContain('execute now');
    expect(launchCmd).toContain('concrete progress');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('settles the tmux main-vertical layout before launching a legacy worker', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const layoutIndex = tmuxCalls.args.findIndex(
      args => args[0] === 'select-layout' && args.includes('main-vertical'),
    );
    const launchIndex = tmuxCalls.args.findIndex(
      args => args[0] === 'send-keys' && args.includes('-l'),
    );
    expect(layoutIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(layoutIndex);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed with layout rollback evidence when task reset is denied', async () => {
    const runtime = makeRuntime(cwd, 'codex');
    tmuxCalls.failCommands = ['select-layout'];
    tmuxCalls.afterKillPane = () => denyTaskReset(cwd);

    let failure: unknown;
    try {
      await spawnWorkerForTask(runtime, 'worker-1', 0);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const rollbackFailure = failure as Error & {
      cause?: { layoutError?: unknown; paneCleanupError?: unknown; taskCleanupError?: unknown };
    };
    expect(rollbackFailure.message).toBe('worker_layout_rollback_unverified:worker-1:%42');
    expect(rollbackFailure.cause?.layoutError).toBeInstanceOf(Error);
    expect(rollbackFailure.cause?.paneCleanupError).toBeUndefined();
    expect(rollbackFailure.cause?.taskCleanupError).toBeInstanceOf(Error);
    expect((rollbackFailure.cause?.taskCleanupError as Error).message)
      .toBe('worker_layout_task_reset_unconfirmed:worker-1:1');

    const task = JSON.parse(readFileSync(teamStatePath(cwd, 'tasks/task-1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-1');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed when a split returns no pane and task reset is denied', async () => {
    const runtime = makeRuntime(cwd, 'codex');
    tmuxCalls.splitPaneOutput = '';
    tmuxCalls.afterSplit = () => denyTaskReset(cwd);

    let failure: unknown;
    try {
      await spawnWorkerForTask(runtime, 'worker-1', 0);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const rollbackFailure = failure as Error & { cause?: { taskCleanupError?: unknown } };
    expect(rollbackFailure.message).toBe('worker_startup_task_reset_unconfirmed:worker-1:1');
    expect(rollbackFailure.cause?.taskCleanupError).toBeInstanceOf(Error);

    const task = JSON.parse(readFileSync(teamStatePath(cwd, 'tasks/task-1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-1');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('antigravity worker launch args lead with --dangerously-skip-permissions and pass the instruction as the -p value', async () => {
    const runtime = makeRuntime(cwd, 'antigravity');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // approval flag from the contract (no --print: agy's -p carries the prompt value)
    expect(launchCmd).toContain("'--dangerously-skip-permissions'");
    expect(launchCmd).not.toContain("'--print'");
    // prompt-mode flag for the file-pointer instruction, with the inbox path as its value
    expect(launchCmd).toContain("'-p'");
    expect(launchCmd).toContain(teamStatePath(cwd, 'workers/worker-1/inbox.md'));
    // --dangerously-skip-permissions precedes -p (flags before the -p value)
    expect(launchCmd.indexOf("'--dangerously-skip-permissions'")).toBeLessThan(launchCmd.indexOf("'-p'"));

    rmSync(cwd, { recursive: true, force: true });
  });

  it('antigravity worker skips trust-confirm (no "1" sent via send-keys)', async () => {
    const runtime = makeRuntime(cwd, 'antigravity');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const literalMessages = tmuxCalls.args
      .filter(args => args[0] === 'send-keys' && args.includes('-l'))
      .map(args => args[args.length - 1]);

    // --dangerously-skip-permissions suppresses prompts, so no "1" is sent.
    expect(literalMessages.some(msg => msg === '1')).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('gemini worker skips trust-confirm (no "1" sent via send-keys)', async () => {
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // Collect all literal send-keys messages (the -l flag content)
    const literalMessages = tmuxCalls.args
      .filter(args => args[0] === 'send-keys' && args.includes('-l'))
      .map(args => args[args.length - 1]);

    // Should NOT contain the trust-confirm "1" as a literal send
    const trustConfirmSent = literalMessages.some(msg => msg === '1');
    expect(trustConfirmSent).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('gemini worker writes inbox before spawn', async () => {
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const inboxPath = teamStatePath(cwd, 'workers/worker-1/inbox.md');
    const content = readFileSync(inboxPath, 'utf-8');
    expect(content).toContain('Initial Task Assignment');
    expect(content).toContain('Test task');
    expect(content).toContain('Do something');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('codex worker launch args start a persistent codex pane without prompt/exec subcommands', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // Find the send-keys call that launches the worker (contains -l flag).
    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain('/usr/local/bin/codex');
    expect(launchCmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(launchCmd).not.toContain("'exec'");
    expect(launchCmd).not.toContain(teamStatePath(cwd, 'workers/worker-1/inbox.md'));
    expect(launchCmd).not.toContain('execute now');
    expect(launchCmd).not.toContain('concrete progress');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('codex worker uses the interactive inbox notification path like claude', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const sendKeysCalls = tmuxCalls.args.filter(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(sendKeysCalls.length).toBe(2);
    const readInstructionCall = sendKeysCalls.find((args) => (args[args.length - 1] ?? '').includes('execute now'));
    expect(readInstructionCall).toBeDefined();

    rmSync(cwd, { recursive: true, force: true });
  });

  it('non-prompt worker waits for pane readiness before sending inbox instruction', async () => {
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const captureCalls = tmuxCalls.args.filter(args => args[0] === 'capture-pane');
    expect(captureCalls.length).toBeGreaterThan(0);

    const readInstructionCalls = tmuxCalls.args.filter(
      args => args[0] === 'send-keys' && args.includes('-l') && (args[args.length - 1] ?? '').includes('execute now')
    );
    expect(readInstructionCalls.length).toBe(1);
    expect(tmuxCalls.args).toContainEqual(['set-window-option', '-t', 'test-session:0', 'main-pane-width', '80']);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('non-prompt worker throws when pane never becomes ready and resets task to pending', async () => {
    const runtime = makeRuntime(cwd, 'claude');
    tmuxCalls.capturePaneText = 'still booting\n';
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '40';

    await expect(spawnWorkerForTask(runtime, 'worker-1', 0)).rejects.toThrow('worker_pane_not_ready:worker-1');

    const taskPath = teamStatePath(cwd, 'tasks/task-1.json');
    const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as { status: string; owner: string | null };
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();

    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed with startup rollback evidence when readiness cleanup reset is denied', async () => {
    const runtime = makeRuntime(cwd, 'claude');
    tmuxCalls.capturePaneText = 'still booting\n';
    tmuxCalls.afterKillPane = () => denyTaskReset(cwd);
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '40';

    let failure: unknown;
    try {
      await spawnWorkerForTask(runtime, 'worker-1', 0);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const rollbackFailure = failure as Error & {
      cause?: { startupError?: unknown; paneCleanupError?: unknown; taskCleanupError?: unknown };
    };
    expect(rollbackFailure.message).toBe('worker_startup_rollback_unverified:worker-1:%42');
    expect((rollbackFailure.cause?.startupError as Error).message).toBe('worker_pane_not_ready:worker-1');
    expect(rollbackFailure.cause?.paneCleanupError).toBeUndefined();
    expect((rollbackFailure.cause?.taskCleanupError as Error).message)
      .toBe('worker_startup_task_reset_unconfirmed:worker-1:1');

    const task = JSON.parse(readFileSync(teamStatePath(cwd, 'tasks/task-1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-1');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed with startup rollback evidence when notify cleanup fails', async () => {
    const runtime = makeRuntime(cwd, 'claude');
    tmuxCalls.failCommands = ['notify-send-keys', 'kill-pane'];

    let failure: unknown;
    try {
      await spawnWorkerForTask(runtime, 'worker-1', 0);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const rollbackFailure = failure as Error & {
      cause?: { startupError?: unknown; paneCleanupError?: unknown; taskCleanupError?: unknown };
    };
    expect(rollbackFailure.message).toBe('worker_startup_rollback_unverified:worker-1:%42');
    expect((rollbackFailure.cause?.startupError as Error).message)
      .toBe('worker_notify_failed:worker-1:initial-inbox');
    expect(rollbackFailure.cause?.paneCleanupError).toBeInstanceOf(Error);
    expect(rollbackFailure.cause?.taskCleanupError).toBeUndefined();

    const task = JSON.parse(readFileSync(teamStatePath(cwd, 'tasks/task-1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();

    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed with startup rollback evidence when provider launch fails', async () => {
    const runtime = makeRuntime(cwd, 'codex');
    tmuxCalls.failCommands = ['send-keys'];

    let failure: unknown;
    try {
      await spawnWorkerForTask(runtime, 'worker-1', 0);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const rollbackFailure = failure as Error & {
      cause?: { startupError?: unknown; paneCleanupError?: unknown; taskCleanupError?: unknown };
    };
    expect(rollbackFailure.message).toBe('tmux_send-keys_failed');
    expect(rollbackFailure.cause).toBeUndefined();

    const task = JSON.parse(readFileSync(teamStatePath(cwd, 'tasks/task-1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();

    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns empty and skips spawn when task is already in_progress (claim already taken)', async () => {
    const taskPath = teamStatePath(cwd, 'tasks/task-1.json');
    writeFileSync(taskPath, JSON.stringify({
      id: '1',
      subject: 'Test task',
      description: 'Do something',
      status: 'in_progress',
      owner: 'worker-2',
    }), 'utf-8');

    const runtime = makeRuntime(cwd, 'codex');
    const paneId = await spawnWorkerForTask(runtime, 'worker-1', 0);

    expect(paneId).toBe('');
    expect(tmuxCalls.args.some(args => args[0] === 'split-window')).toBe(false);
    expect(tmuxCalls.args.some(args => args[0] === 'send-keys')).toBe(false);
    expect(runtime.activeWorkers.size).toBe(0);

    const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as { status: string; owner: string | null };
    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-2');
  });
});

describe('spawnWorkerForTask – model passthrough from environment variables', () => {
  let cwd: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    tmuxCalls.args = [];
    tmuxCalls.capturePaneText = '❯ ready\n';
    tmuxCalls.lastLiteralSend = '';
    resetTmuxFailureState();
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
    // Clear model/provider env vars before each test
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL;
    delete process.env.OMC_CODEX_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL;
    delete process.env.OMC_GEMINI_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    delete process.env.OMC_GROK_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL;
    delete process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL;
    delete process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL;
    delete process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.OMC_MODEL_HIGH;
    delete process.env.OMC_MODEL_MEDIUM;
    delete process.env.OMC_MODEL_LOW;
    cwd = mkdtempSync(join(tmpdir(), 'runtime-model-passthrough-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    process.env.OMC_STATE_DIR = join(cwd, 'omc-state');
    setupTaskDir(cwd);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousStateDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('codex worker passes model from OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL = 'gpt-4o';
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Should contain --model flag with the model value
    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'gpt-4o'");
  });

  it('codex worker falls back to OMC_CODEX_DEFAULT_MODEL', async () => {
    process.env.OMC_CODEX_DEFAULT_MODEL = 'o3-mini';
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'o3-mini'");
  });

  it('codex worker prefers OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL over legacy fallback', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL = 'gpt-4o';
    process.env.OMC_CODEX_DEFAULT_MODEL = 'o3-mini';
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model' 'gpt-4o'");
  });

  it('gemini worker passes model from OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'gemini-2.0-flash'");
  });

  it('gemini worker falls back to OMC_GEMINI_DEFAULT_MODEL', async () => {
    process.env.OMC_GEMINI_DEFAULT_MODEL = 'gemini-1.5-pro';
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'gemini-1.5-pro'");
  });

  it('gemini worker prefers OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL over legacy fallback', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
    process.env.OMC_GEMINI_DEFAULT_MODEL = 'gemini-1.5-pro';
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model' 'gemini-2.0-flash'");
  });

  it('grok worker passes model from OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL = 'grok-4-fast';
    const runtime = makeRuntime(cwd, 'grok');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--always-approve'");
    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'grok-4-fast'");
  });

  it('grok worker falls back to OMC_GROK_DEFAULT_MODEL', async () => {
    process.env.OMC_GROK_DEFAULT_MODEL = 'grok-code-fast-1';
    const runtime = makeRuntime(cwd, 'grok');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain("'grok-code-fast-1'");
  });

  it('grok worker prefers OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL over legacy fallback', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL = 'grok-4-fast';
    process.env.OMC_GROK_DEFAULT_MODEL = 'grok-code-fast-1';
    const runtime = makeRuntime(cwd, 'grok');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model' 'grok-4-fast'");
  });

  it('direct grok worker does not fall through to a Claude/Bedrock model (maintainer key ask)', async () => {
    // A DIRECT grok launch must resolve its model only from grok env vars.
    // Even with Bedrock/Claude model env present, grok must NOT receive any
    // --model flag (its grok env vars are unset here) and must NOT pick up a
    // Claude/Bedrock model id via resolveClaudeWorkerModel().
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.OMC_MODEL_MEDIUM = 'us.anthropic.claude-sonnet-4-6-v1:0';
    const runtime = makeRuntime(cwd, 'grok');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // grok env vars unset → no --model flag at all. The grok IIFE branch returns
    // undefined and never falls through to resolveClaudeWorkerModel(), so the
    // Claude/Bedrock model id is never passed as a `--model` CLI argument.
    // (The Bedrock ids still appear in the forwarded env prefix via the worker
    //  model-env allowlist, exactly as they would for any non-claude worker —
    //  that is pane startup env, not the grok model selection.)
    expect(launchCmd).toContain("'--always-approve'");
    expect(launchCmd).not.toContain("'--model'");
    expect(launchCmd).not.toContain("'--model' 'us.anthropic.claude-sonnet-4-6-v1:0'");
  });

  it('antigravity worker passes model from OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL (flags-first)', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL = 'Gemini 3.1 Pro (High)';
    const runtime = makeRuntime(cwd, 'antigravity');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).not.toContain("'--print'");
    expect(launchCmd).toContain("'--dangerously-skip-permissions'");
    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain('Gemini 3.1 Pro (High)');
    // approval flag and --model precede the -p prompt value
    expect(launchCmd.indexOf("'--dangerously-skip-permissions'")).toBeLessThan(launchCmd.indexOf("'-p'"));
  });

  it('antigravity worker falls back to OMC_ANTIGRAVITY_DEFAULT_MODEL', async () => {
    process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL = 'Gemini 3.1 Pro';
    const runtime = makeRuntime(cwd, 'antigravity');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain('Gemini 3.1 Pro');
  });

  it('claude worker does not pass model flag (not supported)', async () => {
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL = 'gpt-4o';
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Claude worker should not have --model flag
    expect(launchCmd).not.toContain("'--model'");
  });

  it('claude worker propagates ANTHROPIC_MODEL into the pane startup env', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-1';
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain('ANTHROPIC_MODEL=');
    expect(launchCmd).toContain('claude-opus-4-1');
    expect(launchCmd).not.toContain("'--model'");
  });

  it('claude worker propagates custom provider env needed for inherited model selection', async () => {
    process.env.CLAUDE_MODEL = 'vertex_ai/claude-3-5-sonnet';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.invalid';
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain('CLAUDE_MODEL=');
    expect(launchCmd).toContain('vertex_ai/claude-3-5-sonnet');
    expect(launchCmd).toContain('ANTHROPIC_BASE_URL=');
    expect(launchCmd).toContain('https://gateway.example.invalid');
  });

  it('claude worker propagates tiered Bedrock/env model selection variables', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-v1:0';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6-custom';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6-custom';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-custom';
    process.env.OMC_MODEL_HIGH = 'claude-opus-4-6-override';
    process.env.OMC_MODEL_MEDIUM = 'claude-sonnet-4-6-override';
    process.env.OMC_MODEL_LOW = 'claude-haiku-4-5-override';
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    expect(launchCmd).toContain('CLAUDE_CODE_USE_BEDROCK=');
    expect(launchCmd).toContain('CLAUDE_CODE_BEDROCK_OPUS_MODEL=');
    expect(launchCmd).toContain('us.anthropic.claude-opus-4-6-v1:0');
    expect(launchCmd).toContain('CLAUDE_CODE_BEDROCK_SONNET_MODEL=');
    expect(launchCmd).toContain('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(launchCmd).toContain('CLAUDE_CODE_BEDROCK_HAIKU_MODEL=');
    expect(launchCmd).toContain('us.anthropic.claude-haiku-4-5-v1:0');
    expect(launchCmd).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=');
    expect(launchCmd).toContain('claude-opus-4-6-custom');
    expect(launchCmd).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=');
    expect(launchCmd).toContain('claude-sonnet-4-6-custom');
    expect(launchCmd).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=');
    expect(launchCmd).toContain('claude-haiku-4-5-custom');
    expect(launchCmd).toContain('OMC_MODEL_HIGH=');
    expect(launchCmd).toContain('claude-opus-4-6-override');
    expect(launchCmd).toContain('OMC_MODEL_MEDIUM=');
    expect(launchCmd).toContain('claude-sonnet-4-6-override');
    expect(launchCmd).toContain('OMC_MODEL_LOW=');
    expect(launchCmd).toContain('claude-haiku-4-5-override');
    // With Bedrock env vars set, resolveClaudeWorkerModel returns the sonnet model
    // so --model IS expected now (this was the #1695 fix)
    expect(launchCmd).toContain("'--model'");
    expect(launchCmd).toContain('us.anthropic.claude-sonnet-4-6-v1:0');
  });


  it('codex worker does not pass model flag when no env var is set', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Should not have --model flag when no env var is set
    expect(launchCmd).not.toContain("'--model'");
  });
});
