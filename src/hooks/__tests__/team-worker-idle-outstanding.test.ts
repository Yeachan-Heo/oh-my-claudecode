/**
 * Regression tests for issue #3662: a worker with queued/unanswered directed
 * messages or an undelivered owed report must never be reported as plainly
 * idle/available. OMC worker-idle notifications carry observable
 * outstanding-work metadata instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { maybeNotifyLeaderWorkerIdle, maybeNotifyLeaderAllWorkersIdle, type TmuxRunner } from '../team-worker-hook.js';

const TEAM = 'test-team';
const WORKER = 'worker-1';
const OTHER_WORKER = 'worker-2';

interface SeedOptions {
  state?: string;
  prevState?: string;
  mailboxFor?: string;
  otherWorkerMailbox?: boolean;
  outboundReportToLeader?: boolean;
  deliveredInbound?: boolean;
  malformedMailbox?: boolean;
  heartbeat?: boolean;
}

function makeTestEnv() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'omc-worker-idle-outstanding-'));
  const stateDir = join(tmpDir, '.omc', 'state');
  const teamDir = join(stateDir, 'team', TEAM);
  mkdirSync(join(teamDir, 'workers', WORKER), { recursive: true });
  mkdirSync(join(teamDir, 'workers', OTHER_WORKER), { recursive: true });

  writeFileSync(
    join(teamDir, 'config.json'),
    JSON.stringify({
      workers: [{ name: WORKER }, { name: OTHER_WORKER }],
      tmux_session: 'test-session',
      leader_pane_id: '%99',
    }),
  );
  return { tmpDir, stateDir, teamDir };
}

function seed(options: SeedOptions, teamDir: string, stateDir: string): void {
  const nowIso = new Date().toISOString();

  // status.json
  const status = {
    state: options.state ?? 'idle',
    updated_at: nowIso,
    ...(options.state === 'done' ? { reason: 'completed' } : {}),
  };
  writeFileSync(join(teamDir, 'workers', WORKER, 'status.json'), JSON.stringify(status));

  // prev-notify-state.json: force the working->idle transition
  writeFileSync(
    join(teamDir, 'workers', WORKER, 'prev-notify-state.json'),
    JSON.stringify({ state: options.prevState ?? 'working', updated_at: nowIso }),
  );

  // heartbeat.json (fresh)
  if (options.heartbeat !== false) {
    writeFileSync(
      join(teamDir, 'workers', WORKER, 'heartbeat.json'),
      JSON.stringify({ pid: process.pid, last_turn_at: nowIso, turn_count: 1, alive: true }),
    );
    writeFileSync(
      join(teamDir, 'workers', OTHER_WORKER, 'heartbeat.json'),
      JSON.stringify({ pid: process.pid, last_turn_at: nowIso, turn_count: 1, alive: true }),
    );
  }

  // mailbox: {worker}.json with an undelivered directed message
  const mailboxDir = join(stateDir, 'team', TEAM, 'mailbox');
  mkdirSync(mailboxDir, { recursive: true });

  const inboundMessage = (delivered: boolean) => ({
    message_id: 'msg-inbound-1',
    from_worker: OTHER_WORKER,
    to_worker: WORKER,
    body: 'Please review this diff and report findings.',
    created_at: nowIso,
    ...(delivered ? { delivered_at: nowIso } : {}),
  });
  const outboundReport = {
    message_id: 'msg-report-1',
    from_worker: WORKER,
    to_worker: 'leader-fixed',
    body: 'Review findings: approval-gated.',
    created_at: nowIso,
  };

  if (options.malformedMailbox) {
    writeFileSync(join(mailboxDir, `${WORKER}.json`), '{not valid json');
  } else if (options.mailboxFor === 'inbound') {
    const messages: unknown[] = [inboundMessage(!!options.deliveredInbound)];
    writeFileSync(
      join(mailboxDir, `${WORKER}.json`),
      JSON.stringify({ worker: WORKER, messages }),
    );
  }

  if (options.otherWorkerMailbox) {
    writeFileSync(
      join(mailboxDir, `${OTHER_WORKER}.json`),
      JSON.stringify({
        worker: OTHER_WORKER,
        messages: [{ ...inboundMessage(false), message_id: 'msg-inbound-other', to_worker: OTHER_WORKER, from_worker: 'leader-fixed' }],
      }),
    );
  }

  if (options.outboundReportToLeader) {
    writeFileSync(
      join(mailboxDir, 'leader-fixed.json'),
      JSON.stringify({
        worker: 'leader-fixed',
        messages: [outboundReport],
      }),
    );
  }
}

function makeTmux(): { tmux: TmuxRunner; sent: Array<{ target: string; text: string }> } {
  const sent: Array<{ target: string; text: string }> = [];
  const tmux: TmuxRunner = {
    async sendKeys(target: string, text: string) {
      // Ignore the trailing Enter keystrokes the hook sends after the message.
      if (text !== 'C-m') sent.push({ target, text });
    },
  };
  return { tmux, sent };
}

describe('team-worker-hook idle outstanding metadata (issue #3662)', () => {
  let tmpDir: string;
  let stateDir: string;
  let teamDir: string;

  beforeEach(() => {
    const env = makeTestEnv();
    tmpDir = env.tmpDir;
    stateDir = env.stateDir;
    teamDir = env.teamDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('annotates idle notification with undelivered inbound count (queued directed message)', async () => {
    seed({ mailboxFor: 'inbound' }, teamDir, stateDir);
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    const text = sent[0]!.text;
    // Must NOT be a plain "idle" claim: it must carry outstanding-work metadata.
    expect(text).toContain(`[OMC] ${WORKER} idle`);
    expect(text).toContain('outstanding: 1 unanswered');
    expect(text).toContain('[OMC_TMUX_INJECT]');
  });

  it('writes undelivered_inbound_count into the worker_idle event', async () => {
    seed({ mailboxFor: 'inbound' }, teamDir, stateDir);
    const { tmux } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    const eventsPath = join(teamDir, 'events', 'events.ndjson');
    expect(existsSync(eventsPath)).toBe(true);
    const raw = readFileSync(eventsPath, 'utf-8');
    expect(raw).toContain('"type":"worker_idle"');
    expect(raw).toContain('"undelivered_inbound_count":1');
    expect(raw).toContain('"undelivered_outbound_count":0');
  });

  it('annotates idle notification with undelivered owed report (completion without output)', async () => {
    seed({ outboundReportToLeader: true }, teamDir, stateDir);
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain('undelivered reports: 1');
  });

  it('reports plain idle after delivery/ack transition (no false outstanding state)', async () => {
    seed({ mailboxFor: 'inbound', deliveredInbound: true }, teamDir, stateDir);
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    const text = sent[0]!.text;
    expect(text).toContain(`[OMC] ${WORKER} idle`);
    expect(text).not.toContain('outstanding');
    expect(text).not.toContain('undelivered');
  });

  it('does not re-notify on repeated idle signals (transition dedupe preserved)', async () => {
    seed({}, teamDir, stateDir); // no outstanding
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });
    expect(sent.length).toBe(1);

    // Second signal: prev-notify-state is now idle -> no duplicate notify.
    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });
    expect(sent.length).toBe(1);
  });

  it('survives a malformed mailbox (race tolerance) and still notifies plainly', async () => {
    seed({ malformedMailbox: true }, teamDir, stateDir);
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain(`[OMC] ${WORKER} idle`);
    expect(sent[0]!.text).not.toContain('outstanding');
  });

  it('does not count other workers directed messages against this worker (session isolation)', async () => {
    seed({ otherWorkerMailbox: true }, teamDir, stateDir);
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderWorkerIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.text).not.toContain('outstanding');
    expect(sent[0]!.text).not.toContain('undelivered');
  });

  it('qualifies the all-workers-idle readiness claim when any worker has undelivered directed messages', async () => {
    seed({ mailboxFor: 'inbound' }, teamDir, stateDir);
    // All workers need fresh status+heartbeat for the all-idle gate.
    const nowIso = new Date().toISOString();
    writeFileSync(
      join(teamDir, 'workers', OTHER_WORKER, 'status.json'),
      JSON.stringify({ state: 'idle', updated_at: nowIso }),
    );
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderAllWorkersIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    const text = sent[0]!.text;
    expect(text).toContain('All 2 workers idle');
    // Never a plain "ready for next instructions" while work is outstanding.
    // 2 = 1 inbound queued for worker-1 + 1 outbound owed by worker-2 (sender).
    expect(text).toContain('outstanding: 2 undelivered directed messages');
    expect(text).not.toContain('Ready for next instructions');
  });

  it('keeps the plain all-workers-idle claim when nothing is outstanding', async () => {
    seed({}, teamDir, stateDir);
    const nowIso = new Date().toISOString();
    writeFileSync(
      join(teamDir, 'workers', OTHER_WORKER, 'status.json'),
      JSON.stringify({ state: 'idle', updated_at: nowIso }),
    );
    const { tmux, sent } = makeTmux();

    await maybeNotifyLeaderAllWorkersIdle({
      cwd: tmpDir,
      stateDir,
      parsedTeamWorker: { teamName: TEAM, workerName: WORKER },
      tmux,
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain('Ready for next instructions');
  });
});
