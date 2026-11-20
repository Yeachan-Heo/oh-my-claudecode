// Drives the Claude startup wait through Claude Code's first-run dialogs at
// every pane width from 12 to 120 columns. Each recorded frame is drawn at 120
// columns in an isolated tmux server and the window is resized, so the capture
// holds tmux's own reflow, which breaks words at the pane edge. Without tmux the
// frame is cut at the width the same way. It imports only deliverStartupInbox,
// so it also runs unchanged on a base checkout.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StartupPaneContext } from '../tmux-session.js';
import { PANE_ID, trace, type TracePane } from './helpers/readiness-trace-tmux.js';

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

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
const WIDTHS = Array.from({ length: 120 - 12 + 1 }, (_, index) => 12 + index);
const TRIGGER = 'Read .omc/state/team/sweep/workers/worker-1/inbox.md, execute now, report concrete progress.';
const FRAMES = {
  bypassNo: 'claude/2.1.328/bypass-permissions.txt',
  bypassYes: 'claude/2.1.328/bypass-permissions-yes-focused.txt',
  rendererYes: 'claude/2.1.328/fullscreen-renderer.txt',
  rendererNotNow: 'claude/2.1.328/fullscreen-renderer-not-now-focused.txt',
  quoting: 'claude/synthetic/output-quoting-first-run-dialogs.txt',
  idle: 'claude/2.1.325/idle.txt',
} as const;
type FrameName = keyof typeof FRAMES;

const TMUX = spawnSync('tmux', ['-V']).status === 0;

function cutAt(text: string, width: number): string {
  return text.split('\n').flatMap(line => line.match(new RegExp(`.{1,${width}}`, 'gu')) ?? ['']).join('\n');
}

// One server per frame: draw it at 120 columns, then shrink the window one
// column at a time and capture what a worker capture (-p -S -80) would read.
function tmuxReflows(file: string, dir: string): Map<number, string> {
  const socket = join(dir, `${randomUUID().slice(0, 8)}.sock`);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], { encoding: 'utf8' });
  const lastLine = readFileSync(join(CORPUS, file), 'utf8').trimEnd().split('\n').at(-1)!.trim();
  tmux('new-session', '-d', '-x', '120', '-y', '40', `cat ${JSON.stringify(join(CORPUS, file))}; exec sleep 600`);
  try {
    const deadline = Date.now() + 5_000;
    while (!tmux('capture-pane', '-p', '-t', '0').includes(lastLine)) {
      if (Date.now() > deadline) throw new Error(`tmux never drew ${file}`);
    }
    const reflows = new Map<number, string>();
    for (const width of [...WIDTHS].reverse()) {
      tmux('resize-window', '-t', '0', '-x', String(width), '-y', '40');
      reflows.set(width, tmux('capture-pane', '-p', '-S', '-80', '-t', '0'));
    }
    return reflows;
  } finally {
    tmux('kill-server');
  }
}

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

describe.skipIf(!supported)(`Claude first-run dialogs at every width from 12 to 120 columns (${TMUX ? 'tmux reflow' : 'cut at the width'})`, () => {
  let root = '';
  let context: StartupPaneContext;
  const wrapped = new Map<FrameName, Map<number, string>>();
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'omc-sweep-'));
    process.env.HOME = root;
    for (const [name, file] of Object.entries(FRAMES) as Array<[FrameName, string]>) {
      const text = readFileSync(join(CORPUS, file), 'utf8');
      wrapped.set(name, TMUX ? tmuxReflows(file, root) : new Map(WIDTHS.map(width => [width, cutAt(text, width)])));
    }
    const attempt = await prepareWorkerLaunchAttempt({
      cwd: root,
      teamName: 'sweep-team',
      workerName: 'worker-1',
      instanceId: randomUUID(),
      paneId: PANE_ID,
      provider: 'claude',
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
    context = {
      provider: 'claude',
      attempt,
      ownership: {
        provider: 'tmux',
        providerTarget: 'sweep:0',
        paneId: PANE_ID,
        splitTarget: '%1',
        leaderPaneId: '%1',
        reservedPaneIds: [],
        source: 'split',
        tmuxServerIdentity: {
          socket_path: '/tmp/omc-first-run-sweep.sock',
          server_pid: process.pid,
          process_started_at: currentStrictProcessStartIdentity()!,
        },
      },
    };
  }, 120_000);

  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  // Runs one startup delivery against the pane; returns its result, the keys
  // sent (literal text as `text`) and the frame each key reached.
  async function deliver(pane: TracePane & { shown?: () => string }) {
    trace.pane = pane;
    trace.keys = [];
    trace.unknown = [];
    const reached: string[] = [];
    const send = pane.send;
    pane.send = keys => {
      reached.push(`${pane.shown?.() ?? 'static'}:${keys.includes('-l') ? 'text' : keys.at(-1)}`);
      send(keys);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trace.startedAt = Date.now();
    try {
      const result = await settleOnFakeClock(deliverStartupInbox(context, TRIGGER, { attemptAlreadyFenced: true }));
      return { result, reached, unknown: [...trace.unknown] };
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      trace.pane = null;
    }
  }

  const frameAt = (name: FrameName, width: number) => wrapped.get(name)!.get(width)!;

  it('fails at the Bypass Permissions warning with the consent reason and sends it no key, at every width', async () => {
    const misses: string[] = [];
    for (const name of ['bypassNo', 'bypassYes'] as const) {
      for (const width of WIDTHS) {
        const frame = frameAt(name, width);
        const { result, reached } = await deliver({ capture: () => frame, send: () => undefined });
        const outcome = JSON.stringify({ result, reached });
        if (outcome !== JSON.stringify({ result: { ok: false, reason: 'claude_bypass_permissions_consent_required' }, reached: [] })) {
          misses.push(`${name}@${width}: ${outcome}`);
        }
      }
    }
    expect(misses).toEqual([]);
  }, 120_000);

  it('answers the fullscreen renderer offer with Down, then Enter on Not now, then delivers, at every width', async () => {
    const misses: string[] = [];
    for (const width of WIDTHS) {
      let shown: 'offered' | 'notNow' | 'accepted' | 'dismissed' = 'offered';
      const frames = {
        offered: frameAt('rendererYes', width),
        notNow: frameAt('rendererNotNow', width),
        accepted: 'fullscreen renderer on\n',
        // A bare prompt: what comes after the offer is not under test here.
        dismissed: '❯ \n',
      };
      const { result, reached } = await deliver({
        shown: () => shown,
        capture: () => frames[shown],
        send: keys => {
          const key = keys.at(-1);
          if (key === 'Down' && shown === 'offered') shown = 'notNow';
          if (key === 'Enter' && shown === 'offered') shown = 'accepted';
          if (key === 'Enter' && shown === 'notNow') shown = 'dismissed';
        },
      });
      const outcome = JSON.stringify({ result, reached });
      const expected = JSON.stringify({
        result: { ok: true, kind: 'attempted_unconfirmed' },
        reached: ['offered:Down', 'notNow:Enter', 'dismissed:text', 'dismissed:Enter', 'dismissed:Enter'],
      });
      if (outcome !== expected) misses.push(`renderer@${width}: ${outcome}`);
    }
    expect(misses).toEqual([]);
  }, 120_000);

  // As on dev: below 20 columns the recorded idle frame never reads as ready.
  const IDLE_NEVER_READY_BELOW = 20;

  it('delivers to an idle pane and a reply quoting the dialogs as before, at every width', async () => {
    const misses: string[] = [];
    for (const name of ['idle', 'quoting'] as const) {
      for (const width of WIDTHS) {
        const frame = frameAt(name, width);
        const { result, reached } = await deliver({ capture: () => frame, send: () => undefined });
        const outcome = JSON.stringify({ result, reached });
        const expected = JSON.stringify(name === 'idle' && width < IDLE_NEVER_READY_BELOW
          ? { result: { ok: false, reason: 'readiness_timeout' }, reached: [] }
          : { result: { ok: true, kind: 'attempted_unconfirmed' }, reached: ['static:text', 'static:Enter', 'static:Enter'] });
        if (outcome !== expected) misses.push(`${name}@${width}: ${outcome}`);
      }
    }
    expect(misses).toEqual([]);
  }, 120_000);
});
