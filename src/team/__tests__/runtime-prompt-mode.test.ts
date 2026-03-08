import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
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
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify: utilPromisify } = await import('util');

  function mockExecFile(_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) {
    tmuxCalls.args.push(args);
    if (args[0] === 'split-window') {
      cb(null, '%42\n', '');
    } else if (args[0] === 'capture-pane') {
      cb(null, tmuxCalls.capturePaneText, '');
    } else if (args[0] === 'display-message') {
      // pane_dead check → "0" means alive; pane_in_mode → "0" means not in copy mode
      cb(null, '0', '');
    } else {
      cb(null, '', '');
    }
    return {} as never;
  }

  // Attach custom promisify so util.promisify(execFile) returns {stdout, stderr}
  (mockExecFile as any)[utilPromisify.custom] = async (_cmd: string, args: string[]) => {
    tmuxCalls.args.push(args);
    if (args[0] === 'split-window') {
      return { stdout: '%42\n', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      return { stdout: tmuxCalls.capturePaneText, stderr: '' };
    }
    if (args[0] === 'display-message') {
      return { stdout: '0', stderr: '' };
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
      return { status: 0, stdout: '', stderr: '' };
    }),
    execFile: mockExecFile,
  };
});

import { spawnWorkerForTask, type TeamRuntime } from '../runtime.js';

function makeRuntime(cwd: string, agentType: 'gemini' | 'codex' | 'claude'): TeamRuntime {
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
  const tasksDir = join(cwd, '.omc/state/team/test-team/tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
    id: '1',
    subject: 'Test task',
    description: 'Do something',
    status: 'pending',
    owner: null,
  }));
  const workerDir = join(cwd, '.omc/state/team/test-team/workers/worker-1');
  mkdirSync(workerDir, { recursive: true });
}

describe('spawnWorkerForTask – prompt mode (Gemini & Codex)', () => {
  let cwd: string;

  beforeEach(() => {
    tmuxCalls.args = [];
    tmuxCalls.capturePaneText = '❯ ready\n';
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
    cwd = mkdtempSync(join(tmpdir(), 'runtime-gemini-prompt-'));
    setupTaskDir(cwd);
  });

  it('gemini worker launch args include -i flag with inbox path', async () => {
    const runtime = makeRuntime(cwd, 'gemini');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // Find the send-keys call that launches the worker (contains -l flag)
    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Should contain -i flag for interactive mode
    expect(launchCmd).toContain("'-i'");
    // Should contain the inbox path reference
    expect(launchCmd).toContain('.omc/state/team/test-team/workers/worker-1/inbox.md');

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

    const inboxPath = join(cwd, '.omc/state/team/test-team/workers/worker-1/inbox.md');
    const content = readFileSync(inboxPath, 'utf-8');
    expect(content).toContain('Initial Task Assignment');
    expect(content).toContain('Test task');
    expect(content).toContain('Do something');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('codex worker launch args include positional prompt (no -p flag)', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // Find the send-keys call that launches the worker (contains -l flag)
    const launchCall = tmuxCalls.args.find(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(launchCall).toBeDefined();
    const launchCmd = launchCall![launchCall!.length - 1];

    // Should NOT contain -i flag (codex uses positional argument, not a flag)
    expect(launchCmd).not.toContain("'-i'");
    // Should contain the inbox path as a positional argument
    expect(launchCmd).toContain('.omc/state/team/test-team/workers/worker-1/inbox.md');

    rmSync(cwd, { recursive: true, force: true });
  });

  it('codex worker skips interactive send-keys notification (uses prompt mode)', async () => {
    const runtime = makeRuntime(cwd, 'codex');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    // After the initial launch send-keys, there should be NO follow-up
    // send-keys with "Read and execute" text (prompt-mode agents skip the
    // interactive notification path).
    const sendKeysCalls = tmuxCalls.args.filter(
      args => args[0] === 'send-keys' && args.includes('-l')
    );
    // Only one send-keys call: the launch command itself
    expect(sendKeysCalls.length).toBe(1);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('non-prompt worker waits for pane readiness before sending inbox instruction', async () => {
    const runtime = makeRuntime(cwd, 'claude');

    await spawnWorkerForTask(runtime, 'worker-1', 0);

    const captureCalls = tmuxCalls.args.filter(args => args[0] === 'capture-pane');
    expect(captureCalls.length).toBeGreaterThan(0);

    const readInstructionCalls = tmuxCalls.args.filter(
      args => args[0] === 'send-keys' && args.includes('-l') && (args[args.length - 1] ?? '').includes('Read and execute your task from:')
    );
    expect(readInstructionCalls.length).toBe(1);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('non-prompt worker throws when pane never becomes ready and resets task to pending', async () => {
    const runtime = makeRuntime(cwd, 'claude');
    tmuxCalls.capturePaneText = 'still booting\n';
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '40';

    await expect(spawnWorkerForTask(runtime, 'worker-1', 0)).rejects.toThrow('worker_pane_not_ready:worker-1');

    const taskPath = join(cwd, '.omc/state/team/test-team/tasks/1.json');
    const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as { status: string; owner: string | null };
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();

    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns empty and skips spawn when task is already in_progress (claim already taken)', async () => {
    const taskPath = join(cwd, '.omc/state/team/test-team/tasks/1.json');
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
  const originalEnv = process.env;

  beforeEach(() => {
    tmuxCalls.args = [];
    tmuxCalls.capturePaneText = '❯ ready\n';
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
    // Clear model/provider env vars before each test
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL;
    delete process.env.OMC_CODEX_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL;
    delete process.env.OMC_GEMINI_DEFAULT_MODEL;
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
    setupTaskDir(cwd);
  });

  afterEach(() => {
    process.env = originalEnv;
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
    expect(launchCmd).not.toContain("'--model'");
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
