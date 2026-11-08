/**
 * Regression tests for issue #3662: leader-nudge idle accounting must not
 * classify a worker with queued/unanswered directed mailbox messages as
 * idle/available.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkLeaderStaleness, maybeNudgeLeader, type TmuxRunner } from '../../hooks/team-leader-nudge-hook.js';

const TEAM = 'demo-team';
const WORKER = 'worker-1';

function writeJsonSync(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function seedTeam(cwd: string, options: { undeliveredInbound?: boolean; deliveredInbound?: boolean } = {}): string {
  const stateDir = join(cwd, '.omc', 'state');
  const teamDir = join(stateDir, 'team', TEAM);
  const nowIso = new Date().toISOString();

  writeJsonSync(join(teamDir, 'config.json'), {
    workers: [{ name: WORKER }],
    leader_pane_id: '%1',
  });
  writeJsonSync(join(teamDir, 'workers', WORKER, 'status.json'), {
    state: 'idle',
    updated_at: nowIso,
  });
  writeJsonSync(join(teamDir, 'workers', WORKER, 'heartbeat.json'), {
    alive: true,
    last_turn_at: nowIso,
  });
  writeJsonSync(join(teamDir, 'tasks', 'task-1.json'), {
    status: 'pending',
  });

  if (options.undeliveredInbound || options.deliveredInbound) {
    writeJsonSync(join(teamDir, 'mailbox', `${WORKER}.json`), {
      worker: WORKER,
      messages: [{
        message_id: 'msg-1',
        from_worker: 'leader-fixed',
        to_worker: WORKER,
        body: 'Deliver the review findings.',
        created_at: nowIso,
        ...(options.deliveredInbound ? { delivered_at: nowIso } : {}),
      }],
    });
  }

  return stateDir;
}

describe('team leader nudge outstanding-work classification (issue #3662)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omc-leader-nudge-outstanding-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not count a worker with undelivered inbound messages as idle', async () => {
    const stateDir = seedTeam(cwd, { undeliveredInbound: true });
    const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });

    expect(staleness.idleWorkerCount).toBe(0);
    expect(staleness.stale).toBe(false);
  });

  it('does not nudge "all workers idle" while a worker owes a response to a queued message', async () => {
    const stateDir = seedTeam(cwd, { undeliveredInbound: true });
    const sent: string[] = [];
    const tmux: TmuxRunner = {
      async sendKeys(_target, text) {
        sent.push(text);
      },
    };

    const result = await maybeNudgeLeader({ cwd, stateDir, teamName: TEAM, tmux });

    expect(result.nudged).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('restores the idle classification once the message is delivered (ack transition)', async () => {
    const stateDir = seedTeam(cwd, { deliveredInbound: true });
    const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });

    expect(staleness.idleWorkerCount).toBe(1);
    expect(staleness.stale).toBe(true);
    expect(staleness.reason).toContain('all_workers_idle_with_active_tasks');
  });

  it('preserves existing nudge behavior when there is no mailbox at all', async () => {
    const stateDir = seedTeam(cwd);
    const sent: string[] = [];
    const tmux: TmuxRunner = {
      async sendKeys(_target, text) {
        sent.push(text);
      },
    };

    const result = await maybeNudgeLeader({ cwd, stateDir, teamName: TEAM, tmux });

    expect(result.nudged).toBe(true);
    expect(sent[0]).toContain('Leader nudge');
  });
});
