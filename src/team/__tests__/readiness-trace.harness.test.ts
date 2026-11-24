// Records which tmux keys the readiness paths send for each recorded pane
// frame. scripts/dev/readiness-diff.mjs copies this file and its tmux mock
// (helpers/readiness-trace-tmux.ts) unchanged into a base checkout and runs it
// in both trees, so it may statically import only those and modules that exist
// on the base as well. Runs only when READINESS_TRACE_OUT is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StartupPaneContext } from '../tmux-session.js';
import { PANE_ID, scriptedPane, trace, type TracePane } from './helpers/readiness-trace-tmux.js';

const TRACE_OUT = process.env.READINESS_TRACE_OUT;
const TRACE_SET = process.env.READINESS_TRACE_SET ?? 'r5';
const FIXTURE_ROOT = process.env.READINESS_FIXTURE_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
const STARTUP_MESSAGE = 'Read .omc/state/team/trace/workers/worker-1/inbox.md, execute now, report concrete progress.';

vi.mock('../../platform/process-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../platform/process-utils.js')>(),
  isProcessIdentityLive: vi.fn(async () => 'live'),
}));

vi.mock('../../cli/tmux-utils.js', async importOriginal => {
  const { tmuxUtilsOverrides } = await import('./helpers/readiness-trace-tmux.js');
  return {
    ...await importOriginal<typeof import('../../cli/tmux-utils.js')>(),
    ...Object.fromEntries(Object.entries(tmuxUtilsOverrides()).map(([name, fn]) => [name, vi.fn(fn)])),
  };
});

import { deliverStartupInbox } from '../tmux-session.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';

type Fixture = { file: string; provider: StartupPaneContext['provider']; source: string };
type TraceCase = {
  case: string;
  fn: string;
  fixture: string;
  eventState: string | null;
  reference_case?: string;
  env: Record<string, string | null>;
  control: boolean;
  pane?: () => TracePane;
  run: () => Promise<unknown>;
};

// Claude Code's trust dialog: "No, exit" is focused first, Down moves the
// focus, Enter confirms the focused choice. `immediate` applies each key as it
// arrives. `batched` applies the keys sent since the last capture together,
// against the focus drawn before them: the hypothesis that fits the recorded
// Claude Code 2.1.328 failures.
function yesFocused(noFocused: string): string {
  const lines = noFocused.split('\n');
  const no = lines.findIndex(line => /❯\s*No, exit/.test(line));
  const yes = lines.findIndex(line => /^\s*Yes, (?:proceed|I trust this folder)/.test(line));
  const column = lines[no]!.indexOf('❯');
  lines[no] = `${lines[no]!.slice(0, column)} ${lines[no]!.slice(column + 1)}`;
  lines[yes] = `${lines[yes]!.slice(0, column)}❯${lines[yes]!.slice(column + 1)}`;
  return lines.join('\n');
}

function claudeTrustPane(noFocused: string, idle: string, mode: 'immediate' | 'batched'): TracePane {
  const frames = {
    no: noFocused,
    yes: yesFocused(noFocused),
    declined: `${noFocused.trimEnd()}\nClaude Code didn't start because this folder isn't trusted.\n`,
    trusted: idle,
  };
  let focus: keyof typeof frames = 'no';
  let pending: string[] = [];
  const apply = (keys: string[]) => {
    const drawn = focus;
    if (drawn !== 'no' && drawn !== 'yes') return;
    for (const key of keys) {
      if (key === 'Enter') {
        focus = drawn === 'yes' ? 'trusted' : 'declined';
        return;
      }
      if (key === 'Down') focus = 'yes';
    }
  };
  return {
    send: keys => {
      if (keys.length !== 1) return;
      if (mode === 'batched') pending.push(keys[0]!);
      else apply(keys);
    },
    capture: () => {
      apply(pending);
      pending = [];
      return frames[focus];
    },
  };
}

// Each set lists its cases; later PRs add sets here and in readiness-diff.mjs.
const SETS: Record<string, (fixtures: Fixture[], contexts: Map<string, StartupPaneContext>) => TraceCase[]> = {
  r5: (fixtures, contexts) => {
    const values = [undefined, '', 'abc', '4999', '5000', '29999', '30000', '60000', '120000', '120001', '600000', '6e4', '9007199254740992'];
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
  trust: (fixtures, contexts) => {
    const idle = readFileSync(join(FIXTURE_ROOT, 'claude/2.1.325/idle.txt'), 'utf8');
    // Claude's other "No, exit" dialog, the Bypass Permissions warning, is not a trust dialog.
    const dialogs = fixtures.filter(fixture => {
      const text = readFileSync(join(FIXTURE_ROOT, fixture.file), 'utf8');
      return fixture.provider === 'claude' && /❯\s*No, exit/.test(text) && /^\s*Yes, (?:proceed|I trust this folder)/m.test(text);
    });
    // An answered dialog left above the live input prompt: keys reach the
    // prompt, so the pane stays as recorded.
    const stale = (file: string) => {
      const lines = readFileSync(join(FIXTURE_ROOT, file), 'utf8').split('\n');
      return lines.slice(lines.findIndex(line => /^\s*Yes,/.test(line)) + 1).some(line => /^\s*❯/.test(line));
    };
    return dialogs.flatMap(fixture => (stale(fixture.file) ? ['stale'] as const : ['immediate', 'batched'] as const).map(mode => ({
      case: `${fixture.file} keys=${mode}`,
      fn: 'deliverStartupInbox',
      fixture: fixture.file,
      eventState: mode,
      env: { OMC_TEAM_READY_TIMEOUT_MS: null },
      control: fixture.file === 'claude/2.1.325/trust.txt' && mode === 'immediate',
      pane: mode === 'stale' ? undefined : () => claudeTrustPane(readFileSync(join(FIXTURE_ROOT, fixture.file), 'utf8'), idle, mode),
      run: () => deliverStartupInbox(contexts.get(fixture.provider)!, STARTUP_MESSAGE, { attemptAlreadyFenced: true }),
    })));
  },
  // Claude Code 2.1.330's trust dialog captured while it draws, each partial
  // frame shown for one capture. reference: the whole dialog, answered.
  // initial-partial: a partial frame of the first draw, then the reference.
  // post-down-partial: the redraw after Down cut short. pre-typing-partial: an
  // idle pane, then the dialog starting to draw, a guard for the check before
  // the trigger is typed rather than a measured sequence.
  'trust-partial': (_fixtures, contexts) => {
    const read = (file: string) => readFileSync(join(FIXTURE_ROOT, file), 'utf8');
    const idle = read('claude/2.1.325/idle.txt');
    const answered = (whole: string, partial?: { frame: string; afterDown?: boolean }) => {
      const pane = {
        whole: { frame: whole, Down: partial?.afterDown ? 'partial' : 'yes' },
        yes: { frame: yesFocused(whole), Enter: 'idle' },
        idle: { frame: idle },
      };
      if (!partial) return () => scriptedPane(pane, 'whole');
      const next = partial.afterDown ? 'yes' : 'whole';
      return () => scriptedPane({ ...pane, partial: { frame: partial.frame, partial: true, next } }, partial.afterDown ? 'whole' : 'partial');
    };
    const base = (id: string, eventState: string, pane: () => TracePane, extra: Partial<TraceCase> = {}): TraceCase => ({
      case: id,
      fn: 'deliverStartupInbox',
      fixture: 'claude/2.1.330/trust.txt',
      eventState,
      env: { OMC_TEAM_READY_TIMEOUT_MS: null },
      control: false,
      pane,
      run: () => deliverStartupInbox(contexts.get('claude')!, STARTUP_MESSAGE, { attemptAlreadyFenced: true }),
      ...extra,
    });
    const reference = (file: string) => `reference ${file}`;
    const wholes = ['claude/2.1.330/trust.txt', 'claude/2.1.330/trust-80col.txt', 'claude/2.1.330/trust-60col.txt'];
    const trust = read('claude/2.1.330/trust.txt');
    const no = trust.indexOf('❯ No, exit');
    const cut = (end: number) => `${trust.slice(0, end)}\n`;
    const initial: Array<[string, string, string]> = [
      ['recorded trust-no-choice-partial', read('claude/2.1.330/trust-no-choice-partial.txt'), 'claude/2.1.330/trust-80col.txt'],
      ['recorded trust-yes-choice-partial', read('claude/2.1.330/trust-yes-choice-partial.txt'), 'claude/2.1.330/trust-60col.txt'],
      ['recorded trust-body-partial', read('claude/2.1.330/trust-body-partial.txt'), 'claude/2.1.330/trust.txt'],
      ['cut at "❯"', cut(no + 1), 'claude/2.1.330/trust.txt'],
      ['cut at "❯ N"', cut(no + 3), 'claude/2.1.330/trust.txt'],
      ['cut at "❯ No, exit"', cut(no + 10), 'claude/2.1.330/trust.txt'],
      ['cut at "Y"', cut(trust.indexOf('Yes, I trust this folder') + 1), 'claude/2.1.330/trust.txt'],
    ];
    const yes = yesFocused(trust);
    const noLine = yes.indexOf('  No, exit');
    const postDown: Array<[string, string]> = [
      ['"No, exit" and an empty "❯"', `${yes.slice(0, noLine)}  No, exit\n ❯\n`],
      ['"No, exit" and "❯ Yes, I tr"', `${yes.slice(0, noLine)}  No, exit\n ❯ Yes, I tr\n`],
      ['"❯ No, exit" and "❯ Yes, I tr"', `${yes.slice(0, noLine)}❯ No, exit\n ❯ Yes, I tr\n`],
    ];
    return [
      ...wholes.map(file => base(reference(file), 'reference', answered(read(file)), {
        fixture: file,
        control: file === 'claude/2.1.330/trust.txt',
      })),
      ...initial.map(([name, frame, whole]) => base(`initial-partial ${name}`, 'initial-partial', answered(read(whole), { frame }), {
        fixture: whole,
        reference_case: reference(whole),
      })),
      ...postDown.map(([name, frame]) => base(`post-down-partial ${name}`, 'post-down-partial', answered(trust, { frame, afterDown: true }), {
        reference_case: reference('claude/2.1.330/trust.txt'),
      })),
      base('pre-typing-partial recorded trust-no-choice-partial', 'pre-typing-partial', () => scriptedPane({
        idleFirst: { frame: idle, next: 'partial' },
        partial: { frame: read('claude/2.1.330/trust-no-choice-partial.txt'), partial: true, next: 'whole' },
        whole: { frame: trust, Down: 'yes' },
        yes: { frame: yes, Enter: 'idle' },
        idle: { frame: idle },
      }, 'idleFirst')),
    ];
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
      trace.pane = traceCase.pane?.() ?? null;
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
      const partial = trace.pane?.partial?.();
      trace.pane = null;
      const { run: _run, pane: _pane, ...described } = traceCase;
      results.push({
        ...described,
        ...(partial ? { keys_on_partial: partial.keys, partial_captures: partial.captures } : {}),
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
