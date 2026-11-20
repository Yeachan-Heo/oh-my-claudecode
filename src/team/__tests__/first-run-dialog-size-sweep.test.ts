// Drives the Claude startup wait through Claude Code's first-run dialogs in
// panes of many sizes, with isolated tmux servers drawing the recorded frames:
// - every width from 12 to 120 columns at 50 rows: the frame is drawn at 120
//   columns and the window shrunk, so the capture holds tmux's own reflow,
//   which breaks words at the pane edge;
// - heights from 5 to 30 rows at a set of widths, with history-limit 0: the
//   frame is drawn into the small pane, so its top scrolls out of the capture.
// Without tmux only the width sweep runs, on lines cut at the width. The file
// imports only deliverStartupInbox, so it also runs unchanged on a base
// checkout; SWEEP_DUMP=<file> writes every outcome for comparing the trees.
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
const SHORT_WIDTHS = [12, 16, 20, 35, 80, 120];
const HEIGHTS = Array.from({ length: 30 - 5 + 1 }, (_, index) => 5 + index);
const TRIGGER = 'Read .omc/state/team/sweep/workers/worker-1/inbox.md, execute now, report concrete progress.';
const FRAMES = {
  bypassNo: 'claude/2.1.328/bypass-permissions.txt',
  bypassYes: 'claude/2.1.328/bypass-permissions-yes-focused.txt',
  rendererYes: 'claude/2.1.328/fullscreen-renderer.txt',
  rendererNotNow: 'claude/2.1.328/fullscreen-renderer-not-now-focused.txt',
  afterRenderer: 'claude/2.1.328/idle-after-fullscreen-renderer.txt',
  onboardingTheme: 'claude/2.1.329/onboarding-theme.txt',
  onboardingNotes: 'claude/2.1.329/onboarding-security-notes.txt',
  quoting: 'claude/synthetic/output-quoting-first-run-dialogs.txt',
  idle: 'claude/2.1.325/idle.txt',
} as const;
// Recorded frames edited into panes that must not read as a first-run screen:
// a cwd named "Dark mode" in the banner and in the HUD below the live prompt,
// and a reply quoting the security notes above a > or › input prompt.
const recorded = (name: keyof typeof FRAMES) => readFileSync(join(CORPUS, FRAMES[name]), 'utf8');
const SHELL_LAUNCH = `${'─'.repeat(120)}\n❯ 'env' OMC_WORKER_LAUNCH_SPEC_FILE='/private/tmp/w/bootstrap.json' '/bin/zsh' '-lc' 'exec "$@"' '--' node runtime-cli.cjs --worker-launch\n`;
const securityNotesQuoted = () => readFileSync(join(CORPUS, FRAMES.onboardingNotes), 'utf8')
  .trimEnd().split('\n').map(line => `  ${line}`).join('\n');
const DERIVED = {
  hudDarkMode: () => readFileSync(join(CORPUS, FRAMES.idle.replace('idle.txt', 'idle-hud.txt')), 'utf8')
    .replace('/private/tmp/omc-proto-X5IS/work', '/private/tmp/omc-proto-X5IS/work/Dark mode')
    .replace('[OMC#5.8.4] |', '[OMC#5.8.4] | /private/tmp/omc-proto-X5IS/work/Dark mode |'),
  quoteAboveGreaterThan: () => `⏺ The worker pane showed:\n${securityNotesQuoted()}\n\n> `,
  quoteAboveChevron: () => `⏺ The worker pane showed:\n${securityNotesQuoted()}\n\n› `,
  // First-run screens below what could pass for an input box: a shell theme
  // that rules a line above its ❯ prompt, with the worker launch command, or an
  // earlier Claude input box left in the scrollback.
  shellBypassNo: () => `${SHELL_LAUNCH}${recorded('bypassNo')}`,
  shellBypassYes: () => `${SHELL_LAUNCH}${recorded('bypassYes')}`,
  shellRendererYes: () => `${SHELL_LAUNCH}${recorded('rendererYes')}`,
  shellRendererNotNow: () => `${SHELL_LAUNCH}${recorded('rendererNotNow')}`,
  boxOnboardingTheme: () => `${recorded('idle').trimEnd()}\n${recorded('onboardingTheme')}`,
  boxOnboardingNotes: () => `${recorded('idle').trimEnd()}\n${recorded('onboardingNotes')}`,
} as const;
type FrameName = keyof typeof FRAMES | keyof typeof DERIVED;
type Size = `${number}x${number}`;

const TMUX = spawnSync('tmux', ['-V']).status === 0;
const squeeze = (text: string) => text.replace(/\s+/g, '');

function cutAt(text: string, width: number): string {
  return text.split('\n').flatMap(line => line.match(new RegExp(`.{1,${width}}`, 'gu')) ?? ['']).join('\n');
}

function tmuxIn(dir: string) {
  const socket = join(dir, `${randomUUID().slice(0, 8)}.sock`);
  return (...args: string[]) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], { encoding: 'utf8' });
}

// Waits until cat has drawn the whole frame and the pane runs sleep.
function awaitDrawn(tmux: ReturnType<typeof tmuxIn>, target: string): void {
  const deadline = Date.now() + 5_000;
  while (tmux('display-message', '-p', '-t', target, '#{pane_current_command}').trim() !== 'sleep') {
    if (Date.now() > deadline) throw new Error(`tmux never finished drawing in ${target}`);
  }
}

// One server per frame: draw it at 120x50, then shrink the window one column
// at a time and capture what a worker capture (-p -S -80) would read.
function widthReflows(path: string, dir: string): Map<Size, string> {
  const tmux = tmuxIn(dir);
  tmux('new-session', '-d', '-x', '120', '-y', '50', `cat ${JSON.stringify(path)}; exec sleep 600`);
  try {
    awaitDrawn(tmux, '0');
    const reflows = new Map<Size, string>();
    for (const width of [...WIDTHS].reverse()) {
      tmux('resize-window', '-t', '0', '-x', String(width), '-y', '50');
      reflows.set(`${width}x50`, tmux('capture-pane', '-p', '-S', '-80', '-t', '0'));
    }
    return reflows;
  } finally {
    tmux('kill-server');
  }
}

// One server with history-limit 0 per frame, one session per size: the frame,
// without its trailing blank lines, is drawn into the small pane, so the lines
// that scroll off its top are gone from the capture.
function shortPanes(path: string, dir: string): Map<Size, string> {
  const tmux = tmuxIn(dir);
  const drawn = join(dir, `${randomUUID().slice(0, 8)}.txt`);
  const text = readFileSync(path, 'utf8').trimEnd();
  writeFileSync(drawn, text);
  tmux('start-server', ';', 'set-option', '-g', 'history-limit', '0', ';', 'new-session', '-d', '-s', 'keep');
  try {
    const panes = new Map<Size, string>();
    for (const width of SHORT_WIDTHS) {
      for (const height of HEIGHTS) {
        const session = `s${width}x${height}`;
        tmux('new-session', '-d', '-s', session, '-x', String(width), '-y', String(height), `cat ${JSON.stringify(drawn)}; exec sleep 600`);
        awaitDrawn(tmux, session);
        panes.set(`${width}x${height}`, tmux('capture-pane', '-p', '-S', '-80', '-t', session));
        tmux('kill-session', '-t', session);
      }
    }
    return panes;
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

const CONSENT = { ok: false, reason: 'claude_bypass_permissions_consent_required' };
const ONBOARDING = { ok: false, reason: 'claude_onboarding_required' };
const TIMEOUT = { ok: false, reason: 'readiness_timeout' };
const DELIVERED = { ok: true, kind: 'attempted_unconfirmed' };

describe.skipIf(!supported)(`Claude first-run dialogs across pane sizes (${TMUX ? 'tmux' : 'lines cut at the width'})`, () => {
  let root = '';
  let context: StartupPaneContext;
  const panes = new Map<FrameName, Map<Size, string>>();
  const widthSizes = WIDTHS.map(width => `${width}x50` as Size);
  const shortSizes = TMUX ? SHORT_WIDTHS.flatMap(width => HEIGHTS.map(height => `${width}x${height}` as Size)) : [];
  const dump: Record<string, unknown> = {};
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'omc-sweep-'));
    process.env.HOME = root;
    const sources: Array<[FrameName, string]> = [
      ...Object.entries(FRAMES).map(([name, file]) => [name as FrameName, join(CORPUS, file)] as [FrameName, string]),
      ...Object.entries(DERIVED).map(([name, build]) => {
        const path = join(root, `${name}.txt`);
        writeFileSync(path, build());
        return [name as FrameName, path] as [FrameName, string];
      }),
    ];
    for (const [name, file] of sources) {
      const text = readFileSync(file, 'utf8');
      const frames = TMUX
        ? new Map([...widthReflows(file, root), ...shortPanes(file, root)])
        : new Map(WIDTHS.map(width => [`${width}x50` as Size, cutAt(text, width)]));
      panes.set(name, frames);
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
  }, 300_000);

  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
    if (process.env.SWEEP_DUMP) writeFileSync(process.env.SWEEP_DUMP, `${JSON.stringify(dump, null, 2)}\n`);
  });

  // Runs one startup delivery against the pane; returns its result and the
  // keys sent (literal text as `text`), each with the frame it reached.
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
      return { result, reached };
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      trace.pane = null;
    }
  }

  const frameAt = (name: FrameName, size: Size) => panes.get(name)!.get(size)!;

  // The warning gets no key at any size. Any part of a choice on screen is
  // enough to name it; with no choice left on screen the wait sends nothing
  // and times out.
  it.each([['width', widthSizes], ['height', shortSizes]] as const)(
    'fails at the Bypass Permissions warning without a key (%s sweep)',
    async (_sweep, sizes) => {
      const misses: string[] = [];
      for (const name of ['bypassNo', 'bypassYes', 'shellBypassNo', 'shellBypassYes'] as const) {
        for (const size of sizes) {
          const frame = frameAt(name, size);
          const outcome = await deliver({ capture: () => frame, send: () => undefined });
          dump[`${name}@${size}`] = outcome;
          const choiceVisible = /No,exit|Yes,Iaccept/.test(squeeze(frame));
          const expected = { result: choiceVisible ? CONSENT : TIMEOUT, reached: [] };
          if (JSON.stringify(outcome) !== JSON.stringify(expected)) misses.push(`${name}@${size}: ${JSON.stringify(outcome)}`);
        }
      }
      expect(misses).toEqual([]);
    },
    300_000,
  );

  // Onboarding gets no key at any size, and any part of it on screen names it.
  it.each([['width', widthSizes], ['height', shortSizes]] as const)(
    'stops at Claude Code onboarding without a key (%s sweep)',
    async (_sweep, sizes) => {
      const misses: string[] = [];
      for (const name of ['onboardingTheme', 'onboardingNotes', 'boxOnboardingTheme', 'boxOnboardingNotes'] as const) {
        for (const size of sizes) {
          const frame = frameAt(name, size);
          const outcome = await deliver({ capture: () => frame, send: () => undefined });
          dump[`${name}@${size}`] = outcome;
          if (JSON.stringify(outcome) !== JSON.stringify({ result: ONBOARDING, reached: [] })) misses.push(`${name}@${size}: ${JSON.stringify(outcome)}`);
        }
      }
      expect(misses).toEqual([]);
    },
    300_000,
  );

  // The offer is answered Down, then Enter once Not now is focused, whenever
  // its focused first choice is on screen; otherwise it gets no key. It never
  // gets Enter or the trigger while "Yes, try it" is focused. After Not now
  // the startup goes on as it does on the recorded pane after Not now alone,
  // which dev reads as ready only from 15 columns and at enough rows.
  it.each([['width', widthSizes], ['height', shortSizes]] as const)(
    'answers the fullscreen renderer offer with Not now (%s sweep)',
    async (_sweep, sizes) => {
      const misses: string[] = [];
      const counts = { delivered: 0, answeredThenTimedOut: 0, untouched: 0 };
      for (const [prefix, yes, notNow] of [['', 'rendererYes', 'rendererNotNow'], ['shell', 'shellRendererYes', 'shellRendererNotNow']] as const) for (const size of sizes) {
        let shown: 'offered' | 'notNow' | 'accepted' | 'dismissed' = 'offered';
        const frames = {
          offered: frameAt(yes, size),
          notNow: frameAt(notNow, size),
          accepted: 'fullscreen renderer on\n',
          dismissed: frameAt('afterRenderer', size),
        };
        const outcome = await deliver({
          shown: () => shown,
          capture: () => frames[shown],
          send: keys => {
            const key = keys.at(-1);
            if (key === 'Down' && shown === 'offered') shown = 'notNow';
            if (key === 'Enter' && shown === 'offered') shown = 'accepted';
            if (key === 'Enter' && shown === 'notNow') shown = 'dismissed';
          },
        });
        dump[`${prefix}renderer@${size}`] = outcome;
        const answered = ['offered:Down', 'notNow:Enter'];
        const said = JSON.stringify(outcome);
        const alone = await deliver({ capture: () => frames.dismissed, send: () => undefined });
        if (squeeze(frames.offered).includes('❯1.Yes,tryit')) {
          const then = alone.reached.map(key => key.replace('static:', 'dismissed:'));
          if (said !== JSON.stringify({ result: alone.result, reached: [...answered, ...then] })) misses.push(`${prefix}renderer@${size}: ${said}`);
          else if (!prefix && alone.result.ok) counts.delivered++;
          else if (!prefix) counts.answeredThenTimedOut++;
        } else if (said === JSON.stringify({ result: TIMEOUT, reached: [] })) {
          if (!prefix) counts.untouched++;
        } else {
          misses.push(`${prefix}renderer@${size}: ${said}`);
        }
      }
      dump[`renderer-counts@${_sweep}`] = counts;
      expect(misses).toEqual([]);
      if (_sweep === 'width') {
        // Pinned: from 15 columns on the pane after Not now reads as ready.
        expect(counts).toEqual({ delivered: WIDTHS.length - 3, answeredThenTimedOut: 3, untouched: 0 });
      }
    },
    300_000,
  );

  // An idle pane, the pane after Not now and a reply quoting the dialogs either take the trigger
  // (text, Enter, Enter) or, where dev never reads them as ready, time out
  // without a key. SWEEP_DUMP compares each size with a base checkout.
  it.each([['width', widthSizes], ['height', shortSizes]] as const)(
    'delivers to idle panes and to a reply quoting the dialogs as dev does (%s sweep)',
    async (_sweep, sizes) => {
      const misses: string[] = [];
      for (const name of ['idle', 'quoting', 'afterRenderer', 'hudDarkMode', 'quoteAboveGreaterThan', 'quoteAboveChevron'] as const) {
        for (const size of sizes) {
          const frame = frameAt(name, size);
          const outcome = await deliver({ capture: () => frame, send: () => undefined });
          dump[`${name}@${size}`] = outcome;
          const said = JSON.stringify(outcome);
          const ok = said === JSON.stringify({ result: DELIVERED, reached: ['static:text', 'static:Enter', 'static:Enter'] })
            || said === JSON.stringify({ result: TIMEOUT, reached: [] });
          if (!ok) misses.push(`${name}@${size}: ${said}`);
        }
      }
      expect(misses).toEqual([]);
    },
    300_000,
  );
});
