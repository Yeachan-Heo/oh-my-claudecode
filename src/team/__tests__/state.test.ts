import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  claimTask,
  computeTaskReadiness,
  createTask,
  enqueueDispatchRequest,
  initTeamState,
  listDispatchRequests,
  listMailboxMessages,
  listTasks,
  markDispatchRequestDelivered,
  markDispatchRequestNotified,
  markMessageDelivered,
  markMessageNotified,
  readDispatchRequest,
  readMonitorSnapshot,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  readTeamPhase,
  releaseTaskClaim,
  sendDirectMessage,
  transitionDispatchRequest,
  transitionTaskStatus,
  updateWorkerHeartbeat,
  writeMonitorSnapshot,
  writeTeamPhase,
  writeWorkerStatus,
} from '../state.js';
import type { TeamConfig } from '../types.js';

function teamConfig(name: string, cwd: string, workerCount = 2): TeamConfig {
  return {
    name,
    task: 'state contract',
    agent_type: 'executor',
    worker_launch_mode: 'interactive',
    worker_count: workerCount,
    max_workers: 20,
    workers: Array.from({ length: workerCount }, (_, index) => ({
      name: `worker-${index + 1}`,
      index: index + 1,
      role: 'executor',
      assigned_tasks: [],
      pane_id: `%${index + 2}`,
      working_dir: cwd,
    })),
    created_at: new Date().toISOString(),
    tmux_session: `${name}:0`,
    next_task_id: 1,
    leader_cwd: cwd,
    team_state_root: join(cwd, '.omc', 'state', 'team', name),
    workspace_mode: 'single',
    worktree_mode: 'disabled',
    leader_pane_id: '%1',
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
  };
}

describe('team state', () => {
  it('initializes config and core directories under the OMC team state root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-state-'));
    try {
      await initTeamState(teamConfig('team-1', cwd), cwd);

      const root = join(cwd, '.omc', 'state', 'team', 'team-1');
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, 'config.json'))).toBe(true);
      expect(existsSync(join(root, 'workers'))).toBe(true);
      expect(existsSync(join(root, 'tasks'))).toBe(true);

      const cfg = await readTeamConfig('team-1', cwd);
      expect(cfg?.name).toBe('team-1');
      expect(cfg?.workers.map((worker) => worker.name)).toEqual(['worker-1', 'worker-2']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('supports task creation, readiness, claim, release, and terminal transition', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-state-task-'));
    try {
      await initTeamState(teamConfig('team-tasks', cwd), cwd);
      const task = await createTask('team-tasks', { subject: 'do it', description: 'd', status: 'pending' }, cwd);

      expect((await listTasks('team-tasks', cwd)).map((item) => item.id)).toEqual([task.id]);
      expect(await computeTaskReadiness('team-tasks', task.id, cwd)).toEqual({ ready: true });

      const claim = await claimTask('team-tasks', task.id, 'worker-1', task.version ?? 1, cwd);
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect((await readTask('team-tasks', task.id, cwd))?.status).toBe('in_progress');

      const release = await releaseTaskClaim('team-tasks', task.id, 'worker-1', claim.claimToken, cwd);
      expect(release.ok).toBe(true);
      const secondClaim = await claimTask('team-tasks', task.id, 'worker-2', null, cwd);
      expect(secondClaim.ok).toBe(true);
      if (!secondClaim.ok) return;

      const transition = await transitionTaskStatus(
        'team-tasks',
        task.id,
        'in_progress',
        'completed',
        secondClaim.claimToken,
        { result: 'done' },
        cwd,
      );
      expect(transition.ok).toBe(true);
      expect((await readTask('team-tasks', task.id, cwd))?.status).toBe('completed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('enforces restricted worker task scope for claim, transition, and release', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-state-scope-'));
    try {
      const cfg = teamConfig('team-scope', cwd);
      cfg.workers[0]!.assigned_tasks = ['1'];
      await initTeamState(cfg, cwd);
      const first = await createTask('team-scope', { subject: 'allowed', description: 'd', status: 'pending', owner: 'worker-1' }, cwd);
      const second = await createTask('team-scope', { subject: 'denied', description: 'd', status: 'pending', owner: 'worker-1' }, cwd);

      expect(first.id).toBe('1');
      expect(second.id).toBe('2');

      const deniedClaim = await claimTask('team-scope', second.id, 'worker-1', second.version ?? 1, cwd);
      expect(deniedClaim).toEqual({ ok: false, error: 'task_scope_violation' });
      expect((await readTask('team-scope', second.id, cwd))?.status).toBe('pending');

      const allowedClaim = await claimTask('team-scope', first.id, 'worker-1', first.version ?? 1, cwd);
      expect(allowedClaim.ok).toBe(true);
      if (!allowedClaim.ok) return;

      cfg.workers[0]!.assigned_tasks = ['2'];
      await saveTeamConfig(cfg, cwd);

      const deniedTransition = await transitionTaskStatus(
        'team-scope',
        first.id,
        'in_progress',
        'completed',
        allowedClaim.claimToken,
        { result: 'done' },
        cwd,
      );
      expect(deniedTransition).toEqual({ ok: false, error: 'task_scope_violation' });
      expect((await readTask('team-scope', first.id, cwd))?.status).toBe('in_progress');

      const deniedRelease = await releaseTaskClaim('team-scope', first.id, 'worker-1', allowedClaim.claimToken, cwd);
      expect(deniedRelease).toEqual({ ok: false, error: 'task_scope_violation' });
      expect((await readTask('team-scope', first.id, cwd))?.status).toBe('in_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats explicit empty task_scope as deny-all while preserving legacy assigned_tasks fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-state-empty-scope-'));
    try {
      const cfg = teamConfig('team-empty-scope', cwd);
      cfg.workers[0]!.task_scope = [];
      await initTeamState(cfg, cwd);
      const task = await createTask('team-empty-scope', { subject: 'denied', description: 'd', status: 'pending', owner: 'worker-1' }, cwd);

      expect(await claimTask('team-empty-scope', task.id, 'worker-1', task.version ?? 1, cwd))
        .toEqual({ ok: false, error: 'task_scope_violation' });

      cfg.workers[0]!.task_scope = undefined;
      await saveTeamConfig(cfg, cwd);

      const legacyClaim = await claimTask('team-empty-scope', task.id, 'worker-1', task.version ?? 1, cwd);
      expect(legacyClaim.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('round-trips mailbox, dispatch, worker status, monitor snapshot, and phase state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-state-runtime-'));
    try {
      await initTeamState(teamConfig('team-runtime', cwd), cwd);

      const message = await sendDirectMessage('team-runtime', 'worker-1', 'worker-2', 'hello', cwd);
      expect((await listMailboxMessages('team-runtime', 'worker-2', cwd))).toHaveLength(1);
      expect(await markMessageNotified('team-runtime', 'worker-2', message.message_id, cwd)).toBe(true);
      expect(await markMessageDelivered('team-runtime', 'worker-2', message.message_id, cwd)).toBe(true);

      const dispatch = await enqueueDispatchRequest('team-runtime', {
        kind: 'mailbox',
        to_worker: 'worker-2',
        trigger_message: 'check mailbox',
      }, cwd);
      expect((await listDispatchRequests('team-runtime', cwd)).map((item) => item.request_id)).toContain(dispatch.request_id);
      expect((await readDispatchRequest('team-runtime', dispatch.request_id, cwd))?.status).toBe('pending');
      expect((await markDispatchRequestNotified('team-runtime', dispatch.request_id, cwd))?.status).toBe('notified');
      expect((await markDispatchRequestDelivered('team-runtime', dispatch.request_id, cwd))?.status).toBe('delivered');
      expect((await transitionDispatchRequest('team-runtime', dispatch.request_id, 'failed', { last_reason: 'smoke' }, cwd))?.status).toBe('failed');

      await updateWorkerHeartbeat('team-runtime', 'worker-1', { alive: true, last_turn_at: new Date().toISOString(), turn_count: 1, pid: process.pid }, cwd);
      await writeWorkerStatus('team-runtime', 'worker-1', { state: 'idle', updated_at: new Date().toISOString() }, cwd);

      await writeMonitorSnapshot('team-runtime', {
        taskStatusById: {},
        workerAliveByName: { 'worker-1': true },
        workerStateByName: { 'worker-1': 'idle' },
        workerTurnCountByName: { 'worker-1': 1 },
        workerTaskIdByName: { 'worker-1': '' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, cwd);
      expect((await readMonitorSnapshot('team-runtime', cwd))?.workerStateByName['worker-1']).toBe('idle');

      await writeTeamPhase('team-runtime', {
        current_phase: 'executing',
        max_fix_attempts: 2,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      }, cwd);
      expect((await readTeamPhase('team-runtime', cwd))?.current_phase).toBe('executing');

      expect(JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', 'team-runtime', 'config.json'), 'utf-8')).name).toBe('team-runtime');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
