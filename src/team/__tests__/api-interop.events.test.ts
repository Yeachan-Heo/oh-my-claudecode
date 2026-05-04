import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTeamApiOperation, TEAM_API_OPERATIONS } from '../api-interop.js';
import { enqueueDispatchRequest } from '../dispatch-queue.js';

describe('team api event/idle/stall parity operations', () => {
  let cwd: string;
  const teamName = 'events-team';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-events-'));
    const base = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(join(base, 'tasks'), { recursive: true });
    await mkdir(join(base, 'workers', 'worker-1'), { recursive: true });
    await writeFile(join(base, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'events parity',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      tmux_session: 'events:0',
      next_task_id: 2,
    }, null, 2));
    await writeFile(join(base, 'tasks', 'task-1.json'), JSON.stringify({
      id: '1',
      subject: 'event task',
      description: 'event task',
      status: 'pending',
      owner: 'worker-1',
      version: 1,
      created_at: new Date().toISOString(),
    }, null, 2));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('exposes read/await/idle/stall operations in the canonical API operation list', () => {
    expect(TEAM_API_OPERATIONS).toEqual(expect.arrayContaining([
      'read-events',
      'await-event',
      'read-idle-state',
      'read-stall-state',
    ]));
  });

  it('reads events with cursor and field filters', async () => {
    const first = await executeTeamApiOperation('append-event', {
      team_name: teamName,
      type: 'message_received',
      worker: 'worker-1',
      message_id: 'msg-1',
      reason: 'mailbox',
    }, cwd);
    expect(first.ok).toBe(true);
    const second = await executeTeamApiOperation('append-event', {
      team_name: teamName,
      type: 'task_completed',
      worker: 'worker-1',
      task_id: '1',
      reason: 'done',
    }, cwd);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstEventId = ((first.data as { event: { event_id: string } }).event.event_id);
    const secondEventId = ((second.data as { event: { event_id: string } }).event.event_id);
    const result = await executeTeamApiOperation('read-events', {
      team_name: teamName,
      after_event_id: firstEventId,
      type: 'task_completed',
      worker: 'worker-1',
      task_id: '1',
    }, cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { count: number; cursor: string; events: Array<{ event_id: string; type: string }> };
    expect(data.count).toBe(1);
    expect(data.cursor).toBe(secondEventId);
    expect(data.events[0]).toMatchObject({ event_id: secondEventId, type: 'task_completed' });
  });

  it('awaits matching events and returns timeout with cursor when none arrive', async () => {
    const timeout = await executeTeamApiOperation('await-event', {
      team_name: teamName,
      timeout_ms: 0,
      poll_ms: 0,
      after_event_id: 'cursor-1',
      type: 'task_failed',
    }, cwd);
    expect(timeout.ok).toBe(true);
    if (!timeout.ok) return;
    expect(timeout.data).toMatchObject({ status: 'timeout', cursor: 'cursor-1', event: null });

    const appended = await executeTeamApiOperation('append-event', {
      team_name: teamName,
      type: 'task_failed',
      worker: 'worker-1',
      task_id: '1',
      reason: 'boom',
    }, cwd);
    expect(appended.ok).toBe(true);

    const matched = await executeTeamApiOperation('await-event', {
      team_name: teamName,
      timeout_ms: 0,
      poll_ms: 0,
      type: 'task_failed',
      wakeable_only: true,
    }, cwd);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    const data = matched.data as { status: string; event: { type: string; task_id: string } | null };
    expect(data.status).toBe('event');
    expect(data.event).toMatchObject({ type: 'task_failed', task_id: '1' });
  });

  it('builds idle state from monitor snapshot and summary without leaving .omc state', async () => {
    await writeFile(join(cwd, '.omc', 'state', 'team', teamName, 'workers', 'worker-1', 'heartbeat.json'), JSON.stringify({
      pid: 123,
      last_turn_at: new Date().toISOString(),
      turn_count: 3,
      alive: true,
    }, null, 2));
    await executeTeamApiOperation('append-event', {
      team_name: teamName,
      type: 'worker_idle',
      worker: 'worker-1',
      reason: 'state_transition:working->idle',
    }, cwd);
    await executeTeamApiOperation('write-monitor-snapshot', {
      team_name: teamName,
      snapshot: {
        taskStatusById: { '1': 'pending' },
        workerAliveByName: { 'worker-1': true },
        workerStateByName: { 'worker-1': 'idle' },
        workerTurnCountByName: { 'worker-1': 3 },
        workerTaskIdByName: {},
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      },
    }, cwd);

    const result = await executeTeamApiOperation('read-idle-state', { team_name: teamName }, cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      team_name: teamName,
      worker_count: 1,
      idle_worker_count: 1,
      idle_workers: ['worker-1'],
      all_workers_idle: true,
    });
    expect(result.data.last_idle_transition_by_worker).toMatchObject({
      'worker-1': { type: 'worker_idle', worker: 'worker-1' },
    });
  });

  it('builds stall state from non-reporting workers and pending leader dispatch', async () => {
    await enqueueDispatchRequest(teamName, {
      kind: 'mailbox',
      to_worker: 'leader-fixed',
      message_id: 'leader-msg-1',
      trigger_message: 'leader nudge',
    }, cwd);

    const result = await executeTeamApiOperation('read-stall-state', { team_name: teamName }, cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      team_name: teamName,
      team_stalled: true,
      leader_attention_pending: true,
      pending_leader_dispatch_count: 1,
      pending_task_count: 1,
    });
    expect(result.data.reasons).toContain('leader_attention_pending:leader_dispatch_pending');
  });
});
