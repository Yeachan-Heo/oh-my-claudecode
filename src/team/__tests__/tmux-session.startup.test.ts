import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerLaunchAttempt } from '../worker-launch-ack.js';

const tmuxState = vi.hoisted(() => ({
  args: [] as string[][],
  captures: [] as Array<string | Error>,
  paneStatus: '0 cmd\n',
  activeAttempt: null as WorkerLaunchAttempt | null,
}));

vi.mock('../../cli/tmux-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExecAsync: vi.fn(async (args: string[]) => {
      tmuxState.args.push(args);
      if (args[0] === 'capture-pane') {
        const next = tmuxState.captures.length > 1 ? tmuxState.captures.shift() : tmuxState.captures[0];
        if (next instanceof Error) throw next;
        return { stdout: next ?? '', stderr: '' };
      }
      if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && tmuxState.activeAttempt) {
        const attempt = tmuxState.activeAttempt;
        await writeFile(attempt.ackPath, JSON.stringify({
          schema_version: attempt.schema_version,
          attempt_id: attempt.attempt_id,
          nonce: attempt.nonce,
          team_name: attempt.team_name,
          worker_name: attempt.worker_name,
          pane_id: attempt.pane_id,
          provider: attempt.provider,
          created_at: attempt.created_at,
          kind: 'worker_launch_ack',
          written_at: new Date().toISOString(),
        }), 'utf8');
        await writeFile(attempt.startedPath, JSON.stringify({
          schema_version: attempt.schema_version,
          attempt_id: attempt.attempt_id,
          nonce: attempt.nonce,
          team_name: attempt.team_name,
          worker_name: attempt.worker_name,
          pane_id: attempt.pane_id,
          provider: attempt.provider,
          created_at: attempt.created_at,
          kind: 'worker_launch_provider_started',
          pid: process.pid,
          process_start_identity: 'test:provider-start',
          written_at: new Date().toISOString(),
        }), 'utf8');
        tmuxState.activeAttempt = null;
      }
      return { stdout: '', stderr: '' };
    }),
    tmuxCmdAsync: vi.fn(async (args: string[]) => {
      tmuxState.args.push(args);
      if (args.includes('#{pane_dead} #{pane_current_command}')) {
        return { stdout: tmuxState.paneStatus, stderr: '' };
      }
      if (args.includes('#{pane_in_mode}')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  };
});

import {
  deliverStartupInbox,
  adoptWorkerPaneOwnership,
  proveWorkerPaneOwnership,
  spawnWorkerInPane,
  retryStartupInboxSubmit,
  type StartupPaneContext,
  type WorkerPaneOwnership,
} from '../tmux-session.js';
import {
  awaitWorkerLaunchAcknowledgement,
  prepareWorkerLaunchAttempt,
} from '../worker-launch-ack.js';

let cwd = '';
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  tmuxState.args = [];
  tmuxState.captures = [];
  tmuxState.paneStatus = '0 cmd\n';
  tmuxState.activeAttempt = null;
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  delete process.env.MSYSTEM;
  delete process.env.MINGW_PREFIX;
  delete process.env.COMSPEC;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

function ownership(paneId = '%2'): WorkerPaneOwnership {
  return {
    provider: 'tmux',
    providerTarget: 'startup:0',
    paneId,
    splitTarget: '%1',
    leaderPaneId: '%1',
    reservedPaneIds: [],
    source: 'split',
  };
}

async function acceptedContext(provider: StartupPaneContext['provider']): Promise<StartupPaneContext> {
  cwd = await mkdtemp(join(tmpdir(), 'startup-context-'));
  const attempt = await prepareWorkerLaunchAttempt({
    cwd,
    teamName: 'startup-team',
    workerName: 'worker-1',
    paneId: '%2',
    provider,
    runtimeCliPath: '/runtime-cli.cjs',
  });
  await writeFile(attempt.ackPath, JSON.stringify({
    schema_version: attempt.schema_version,
    attempt_id: attempt.attempt_id,
    nonce: attempt.nonce,
    team_name: attempt.team_name,
    worker_name: attempt.worker_name,
    pane_id: attempt.pane_id,
    provider: attempt.provider,
    created_at: attempt.created_at,
    kind: 'worker_launch_ack',
    written_at: new Date().toISOString(),
  }), 'utf8');
  await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 100, pollIntervalMs: 5 });
  return { ownership: ownership(), attempt, provider };
}

describe('worker pane startup safety', () => {
  it.each([
    ['leader_alias', '%1', '%1', []],
    ['split_target_alias', '%3', '%1', []],
    ['reserved_worker_alias', '%4', '%1', ['%4']],
  ] as const)('rejects %s before pane mutation', (reason, paneId, leaderPaneId, reservedPaneIds) => {
    const result = proveWorkerPaneOwnership({
      commandSucceeded: true,
      provider: 'tmux',
      splitTarget: reason === 'split_target_alias' ? paneId : '%9',
      direction: 'right',
      rawOutput: `${paneId}\n`,
      stderr: '',
      paneId,
    }, { providerTarget: 'startup:0', leaderPaneId, reservedPaneIds });
    expect(result).toEqual({ ok: false, reason });
    expect(tmuxState.args).toEqual([]);
  });

  it('adopts only panes proven inside the expected tmux target', async () => {
    const owned = await adoptWorkerPaneOwnership({
      provider: 'tmux',
      providerTarget: 'startup:0',
      paneId: '%9',
      leaderPaneId: '%1',
      reservedPaneIds: [],
      dependencies: {
        tmuxExec: vi.fn(async args => {
          expect(args).toEqual(['list-panes', '-t', 'startup:0', '-F', '#{pane_id}']);
          return { stdout: '%9\n', stderr: '' };
        }),
        cmuxExec: vi.fn(),
      },
    });
    expect(owned).toMatchObject({ ok: true, ownership: { paneId: '%9', providerTarget: 'startup:0', source: 'adopted' } });

    await expect(adoptWorkerPaneOwnership({
      provider: 'tmux',
      providerTarget: 'startup:0',
      paneId: '%9',
      leaderPaneId: '%1',
      reservedPaneIds: [],
      dependencies: {
        tmuxExec: vi.fn(async args => {
          expect(args).toEqual(['list-panes', '-t', 'startup:0', '-F', '#{pane_id}']);
          return { stdout: '%8\n', stderr: '' };
        }),
        cmuxExec: vi.fn(),
      },
    })).resolves.toEqual({ ok: false, reason: 'pane_foreign' });
  });

  it.each([
    ['wide visible command', 'node runtime-cli.cjs --worker-launch'],
    ['narrow wrapped command', 'node runtime-\ncli.cjs --worker-\nlaunch'],
    ['stale scrollback command', 'old launch command\n› ready'],
    ['alternate-screen repaint', '\u001b[?1049h\u001b[2Jprovider ui'],
    ['capture failure placeholder', ''],
  ])('accepts a stable Windows cmd wrapper independently of %s capture', async (_fixture, captured) => {
    cwd = await mkdtemp(join(tmpdir(), 'startup-stable-cmd-'));
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.COMSPEC = 'cmd.exe';
    tmuxState.captures = [captured];
    const attempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: 'startup-team',
      workerName: 'worker-1',
      paneId: '%2',
      provider: 'codex',
      runtimeCliPath: 'C:\\Program Files\\omc\\runtime-cli.cjs',
    });
    tmuxState.activeAttempt = attempt;

    await expect(spawnWorkerInPane('startup:0', '%2', {
      teamName: 'startup-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_WORKER: 'startup-team/worker-1' },
      launchBinary: 'C:\\Program Files\\Codex\\codex.exe',
      launchArgs: ['--full-auto'],
      cwd,
      provider: 'codex',
      launchAttempt: attempt,
    })).resolves.toBeUndefined();

    expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
    expect(tmuxState.captures).toEqual([captured]);
    expect(tmuxState.args.some(args => args.includes('#{pane_dead} #{pane_current_command}'))).toBe(true);
    expect(tmuxState.paneStatus).toBe('0 cmd\n');
  });

  it('clears an exact Codex directory selector before typing the inbox trigger', async () => {
    const context = await acceptedContext('codex');
    tmuxState.captures = [
      'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
      '› ready\n',
    ];

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: true,
      kind: 'attempted_unconfirmed',
    });
    const literalInputs = tmuxState.args
      .filter(args => args[0] === 'send-keys' && args.includes('-l'))
      .map(args => args.at(-1));
    expect(literalInputs).toEqual(['1', 'Read inbox.md, execute now.']);
    expect(tmuxState.args.findIndex(args => args.at(-1) === '1'))
      .toBeLessThan(tmuxState.args.findIndex(args => args.at(-1) === 'Read inbox.md, execute now.'));
  });

  it('handles the exact Codex directory and hooks selectors in order before delivery', async () => {
    const context = await acceptedContext('codex');
    tmuxState.captures = [
      'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
      'Hooks need review\n› 3. Continue without trusting\nPress enter to confirm or esc to go back\n',
      '› ready\n',
    ];

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: true,
      kind: 'attempted_unconfirmed',
    });
    const literalInputs = tmuxState.args
      .filter(args => args[0] === 'send-keys' && args.includes('-l'))
      .map(args => args.at(-1));
    expect(literalInputs).toEqual(['1', '3', 'Read inbox.md, execute now.']);
  });

  it('fails closed when the selector persists after the narrow action', async () => {
    const context = await acceptedContext('codex');
    const selector = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n';
    tmuxState.captures = [selector, selector];

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: false,
      reason: 'selector_persistent',
    });
    expect(tmuxState.args.some(args => args.at(-1) === 'Read inbox.md, execute now.')).toBe(false);
  });

  it('retries Enter only when the exact startup trigger is visibly pending', async () => {
    const context = await acceptedContext('claude');
    const message = 'Read inbox.md, execute now.';
    tmuxState.captures = [`❯ ${message}\n`];

    await expect(retryStartupInboxSubmit(context, message)).resolves.toBe(true);
    expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(true);
  });

  it('does not retry Enter for unrelated pane text', async () => {
    const context = await acceptedContext('claude');
    tmuxState.captures = ['❯ unrelated text\n'];

    await expect(retryStartupInboxSubmit(context, 'Read inbox.md, execute now.')).resolves.toBe(false);
    expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(false);
  });

  it('never sends a Gemini confirmation key without an evidence-backed Gemini selector', async () => {
    const context = await acceptedContext('gemini');
    tmuxState.captures = [
      'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
    ];

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: false,
      reason: 'selector_unsupported',
    });
    expect(tmuxState.args.some(args => args.at(-1) === '1')).toBe(false);
    expect(tmuxState.args.some(args => args.at(-1) === 'Read inbox.md, execute now.')).toBe(false);
  });

  it('does not send the Codex hooks selector key to Claude', async () => {
    const context = await acceptedContext('claude');
    tmuxState.captures = [
      'Hooks need review\n› 3. Continue without trusting\nPress enter to confirm or esc to go back\n',
    ];

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: false,
      reason: 'selector_unsupported',
    });
    expect(tmuxState.args.some(args => args.at(-1) === '3')).toBe(false);
  });

  it('emits bounded redacted capture diagnostics and never treats failure as readiness', async () => {
    const context = await acceptedContext('codex');
    const secret = 'SUPERSECRET_VALUE';
    const jsonSecret = 'JSON_ONLY_SECRET';
    tmuxState.captures = [new Error(
      `capture failed --api-key ${secret} Bearer ${secret} {"provider_argv":["codex","--token","${jsonSecret}"]}`,
    )];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
      ok: false,
      reason: 'capture_failed',
    });
    const diagnostic = stderr.mock.calls.map(call => String(call[0])).join('');
    expect(diagnostic).toContain('pane capture failed operation=startup-readiness pane=%2');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(jsonSecret);
    expect(diagnostic.length).toBeLessThan(500);
    stderr.mockRestore();
  });
});
