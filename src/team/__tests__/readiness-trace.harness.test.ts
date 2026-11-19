// Records which tmux keys the readiness paths send for each recorded pane
// frame. scripts/dev/readiness-diff.mjs copies this file unchanged into a base
// checkout and runs it in both trees, so it may statically import only modules
// that exist on the base as well. Runs only when READINESS_TRACE_OUT is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StartupPaneContext } from '../tmux-session.js';

const TRACE_OUT = process.env.READINESS_TRACE_OUT;
const TRACE_SET = process.env.READINESS_TRACE_SET ?? 'r5';
const FIXTURE_ROOT = process.env.READINESS_FIXTURE_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
const PANE_ID = '%2';
const STARTUP_MESSAGE = 'Read .omc/state/team/trace/workers/worker-1/inbox.md, execute now, report concrete progress.';

type KeyRecord = { fn: string; pane: string; guarded: boolean; keys: string[]; at_ms: number };

const trace = vi.hoisted(() => ({
  frame: '',
  startedAt: 0,
  keys: [] as KeyRecord[],
  unknown: [] as string[],
}));

// Same word rule as the guarded `if-shell` success side: single-quoted words,
// with '"'"' standing for a literal quote.
function guardedShellWords(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'"'"')*)'/g)].map(match =>
    match[1]!.replace(/'"'"'/g, "'"));
}

function recordSend(fn: string, args: string[], guarded: boolean): void {
  const target = args.indexOf('-t');
  trace.keys.push({
    fn,
    pane: target >= 0 ? args[target + 1] ?? '' : '',
    guarded,
    keys: args.filter((_, index) => index !== 0 && index !== target && index !== target + 1),
    at_ms: Date.now() - trace.startedAt,
  });
}

function fakeTmux(fn: string, rawArgs: string[]): string {
  let index = 0;
  while (rawArgs[index] === '-S') index += 2;
  const args = rawArgs.slice(index);
  const command = args[0];
  if (command === 'capture-pane') return trace.frame;
  if (command === 'list-panes') return `${PANE_ID}\n`;
  if (command === 'display-message' && args.includes('#{pid}')) return `${process.pid}\n`;
  if (args.includes('#{pane_dead} #{pane_current_command}')) return '0 cmd\n';
  if (args.includes('#{pane_dead}')) return '0\n';
  if (args.includes('#{pane_in_mode}')) return '0\n';
  if (command === 'if-shell') {
    const success = args[2] ?? '';
    const marker = success.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
    const nativeEnd = success.lastIndexOf('; display-message');
    const native = guardedShellWords(nativeEnd >= 0 ? success.slice(0, nativeEnd) : success);
    if (native[0] === 'send-keys') recordSend(fn, native, true);
    else trace.unknown.push(`${fn}: if-shell ${success}`);
    return marker ? `${marker}\n` : '';
  }
  if (command === 'send-keys') {
    recordSend(fn, args, false);
    return '';
  }
  trace.unknown.push(`${fn}: ${JSON.stringify(args)}`);
  return '';
}

function fakeShell(fn: string, command: string): string {
  const words = guardedShellWords(command);
  if (words.length > 0) return fakeTmux(fn, words);
  trace.unknown.push(`${fn}: ${command}`);
  return '';
}

vi.mock('../../platform/process-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../platform/process-utils.js')>(),
  isProcessIdentityLive: vi.fn(async () => 'live'),
}));

vi.mock('../../cli/tmux-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../cli/tmux-utils.js')>(),
  tmuxExec: vi.fn((args: string[]) => fakeTmux('tmuxExec', args)),
  tmuxShell: vi.fn((command: string) => fakeShell('tmuxShell', command)),
  tmuxExecAsync: vi.fn(async (args: string[]) => ({ stdout: fakeTmux('tmuxExecAsync', args), stderr: '' })),
  tmuxCmdAsync: vi.fn(async (args: string[]) => ({ stdout: fakeTmux('tmuxCmdAsync', args), stderr: '' })),
  tmuxShellAsync: vi.fn(async (command: string) => ({ stdout: fakeShell('tmuxShellAsync', command), stderr: '' })),
}));

import { deliverStartupInbox } from '../tmux-session.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';

type Fixture = { file: string; provider: StartupPaneContext['provider']; source: string };
type TraceCase = {
  case: string;
  fn: string;
  fixture: string;
  eventState: string | null;
  env: Record<string, string | null>;
  control: boolean;
  run: () => Promise<unknown>;
};

// Each set lists its cases; later PRs add sets here and in readiness-diff.mjs.
const SETS: Record<string, (fixtures: Fixture[], contexts: Map<string, StartupPaneContext>) => TraceCase[]> = {
  r5: (fixtures, contexts) => {
    const values = [undefined, '', 'abc', '4999', '5000', '29999', '30000', '60000', '120000', '120001', '600000'];
    return fixtures.flatMap(fixture => values.map(raw => ({
      case: `${fixture.file} OMC_TEAM_READY_TIMEOUT_MS=${raw === undefined ? '<unset>' : JSON.stringify(raw)}`,
      fn: 'deliverStartupInbox',
      fixture: fixture.file,
      eventState: null,
      env: { OMC_TEAM_READY_TIMEOUT_MS: raw ?? null },
      control: fixture.file === 'claude/2.1.325/idle.txt' && raw === undefined,
      run: () => deliverStartupInbox(contexts.get(fixture.provider)!, STARTUP_MESSAGE, { attemptAlreadyFenced: true }),
    })));
  },
};

// Advance the fake clock only while the code under test sleeps; between
// sleeps let real file I/O finish so it never eats into the deadline.
async function settleOnFakeClock<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  void work.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await new Promise(resolve => setImmediate(resolve));
  }
  return work;
}

const supported = currentStrictProcessStartIdentity() !== null
  && (process.platform === 'darwin' || process.platform === 'linux');

describe.skipIf(!TRACE_OUT)('readiness trace harness', () => {
  let root = '';
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'readiness-trace-'));
    for (const key of ['HOME', 'USERPROFILE', 'OMC_STATE_DIR', 'OMC_TEAM_READY_TIMEOUT_MS']) savedEnv.set(key, process.env[key]);
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it(`records the keys sent for set ${TRACE_SET}`, async () => {
    expect(supported, 'needs a strict process start identity (darwin or linux)').toBe(true);
    const buildCases = SETS[TRACE_SET];
    expect(buildCases, `unknown set ${TRACE_SET}`).toBeDefined();
    const fixtures = (JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8')) as Fixture[]);

    const contexts = new Map<string, StartupPaneContext>();
    for (const provider of new Set(fixtures.map(fixture => fixture.provider))) {
      const attempt = await prepareWorkerLaunchAttempt({
        cwd: root,
        teamName: 'trace-team',
        workerName: `worker-${provider}`,
        instanceId: randomUUID(),
        paneId: PANE_ID,
        provider,
        runtimeCliPath: '/runtime-cli.cjs',
      });
      const { ackPath, ...rest } = attempt;
      writeFileSync(ackPath, JSON.stringify({
        schema_version: rest.schema_version,
        attempt_id: rest.attempt_id,
        nonce: rest.nonce,
        instance_id: rest.instance_id,
        team_name: rest.team_name,
        worker_name: rest.worker_name,
        pane_id: rest.pane_id,
        provider: rest.provider,
        created_at: rest.created_at,
        kind: 'worker_launch_ack',
        written_at: new Date().toISOString(),
      }));
      await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 });
      contexts.set(provider, {
        provider,
        attempt,
        ownership: {
          provider: 'tmux',
          providerTarget: 'trace:0',
          paneId: PANE_ID,
          splitTarget: '%1',
          leaderPaneId: '%1',
          reservedPaneIds: [],
          source: 'split',
          tmuxServerIdentity: {
            socket_path: '/tmp/omc-readiness-trace.sock',
            server_pid: process.pid,
            process_started_at: currentStrictProcessStartIdentity()!,
          },
        },
      });
    }

    const results = [];
    const warn = vi.spyOn(console, 'warn');
    for (const traceCase of buildCases!(fixtures, contexts)) {
      trace.frame = readFileSync(join(FIXTURE_ROOT, traceCase.fixture), 'utf8');
      trace.keys = [];
      trace.unknown = [];
      for (const [key, value] of Object.entries(traceCase.env)) {
        if (value === null) delete process.env[key];
        else process.env[key] = value;
      }
      const warnings: string[] = [];
      warn.mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      trace.startedAt = Date.now();
      let result: unknown;
      try {
        result = await settleOnFakeClock(traceCase.run());
      } catch (error) {
        result = { threw: error instanceof Error ? error.message : String(error) };
      }
      const waitMs = Date.now() - trace.startedAt;
      vi.useRealTimers();
      const { run: _run, ...described } = traceCase;
      results.push({
        ...described,
        keys: trace.keys,
        result,
        wait_ms: waitMs,
        unknown_commands: trace.unknown,
        warnings,
      });
    }
    warn.mockRestore();

    writeFileSync(TRACE_OUT!, `${JSON.stringify({
      set: TRACE_SET,
      loaded_modules: ['tmux-session', 'worker-launch-ack', 'team-owner-epoch'],
      cases: results,
    }, null, 2)}\n`);
  }, 30 * 60_000);
});
