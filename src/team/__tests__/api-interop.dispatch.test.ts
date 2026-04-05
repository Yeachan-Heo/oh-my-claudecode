import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { executeTeamApiOperation } from '../api-interop.js';
import { listDispatchRequests } from '../dispatch-queue.js';

describe('team api dispatch-aware messaging', () => {
  let cwd: string;
  const teamName = 'dispatch-team';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-dispatch-'));
    const base = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(join(base, 'tasks'), { recursive: true });
    await mkdir(join(base, 'mailbox'), { recursive: true });
    await mkdir(join(base, 'events'), { recursive: true });
    await writeFile(join(base, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'dispatch',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      tmux_session: 'dispatch-session',
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: '2026-03-06T00:00:00.000Z',
      next_task_id: 2,
    }, null, 2));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('persists leader-fixed messages and leaves a durable pending dispatch request when the leader pane is absent', async () => {
    const result = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'worker-1',
      to_worker: 'leader-fixed',
      body: 'ACK: worker-1 initialized',
    }, cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.data as { message?: { body?: string; message_id?: string } };
    expect(data.message?.body).toBe('ACK: worker-1 initialized');
    expect(typeof data.message?.message_id).toBe('string');

    const mailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
    expect(existsSync(mailboxPath)).toBe(true);
    const mailbox = JSON.parse(await readFile(mailboxPath, 'utf-8')) as {
      messages: Array<{ message_id: string; body: string; notified_at?: string }>;
    };
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]?.body).toBe('ACK: worker-1 initialized');
    expect(mailbox.messages[0]?.notified_at).toBeUndefined();

    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('pending');
    expect(requests[0]?.message_id).toBe(data.message?.message_id);
    expect(requests[0]?.last_reason).toBe('leader_pane_missing_deferred');
  });

  it('updates delivered and notified markers on the same canonical mailbox record', async () => {
    const sendResult = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'leader-fixed',
      to_worker: 'worker-1',
      body: 'Please continue',
    }, cwd);

    expect(sendResult.ok).toBe(true);
    if (!sendResult.ok) return;

    const messageId = (sendResult.data as { message?: { message_id?: string } }).message?.message_id;
    expect(typeof messageId).toBe('string');

    const delivered = await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: teamName,
      worker: 'worker-1',
      message_id: messageId,
    }, cwd);
    expect(delivered.ok).toBe(true);

    const notified = await executeTeamApiOperation('mailbox-mark-notified', {
      team_name: teamName,
      worker: 'worker-1',
      message_id: messageId,
    }, cwd);
    expect(notified.ok).toBe(true);

    const mailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.json');
    const mailbox = JSON.parse(await readFile(mailboxPath, 'utf-8')) as {
      messages: Array<{ message_id: string; delivered_at?: string; notified_at?: string }>;
    };
    const message = mailbox.messages.find((entry) => entry.message_id === messageId);
    expect(typeof message?.delivered_at).toBe('string');
    expect(typeof message?.notified_at).toBe('string');

    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message_id).toBe(messageId);
    expect(requests[0]?.status).toBe('delivered');
    expect(typeof requests[0]?.notified_at).toBe('string');
    expect(typeof requests[0]?.delivered_at).toBe('string');
  });

  it('uses OMC_TEAM_STATE_ROOT placeholder in mailbox triggers for worktree-backed workers', async () => {
    const configPath = join(cwd, '.omc', 'state', 'team', teamName, 'config.json');
    await writeFile(configPath, JSON.stringify({
      name: teamName,
      task: 'dispatch',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      tmux_session: 'dispatch-session',
      workers: [{
        name: 'worker-1',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        worktree_path: join(cwd, '.omc', 'worktrees', teamName, 'worker-1'),
      }],
      created_at: '2026-03-06T00:00:00.000Z',
      next_task_id: 2,
    }, null, 2));

    const sendResult = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'leader-fixed',
      to_worker: 'worker-1',
      body: 'Please continue',
    }, cwd);

    expect(sendResult.ok).toBe(true);

    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.trigger_message).toContain('$OMC_TEAM_STATE_ROOT/team/dispatch-team/mailbox/worker-1.json');
    expect(requests[0]?.trigger_message).toContain('report progress');
  });


  it('routes mailbox notifications using config workers when manifest workers are stale', async () => {
    const base = join(cwd, '.omc', 'state', 'team', teamName);
    await writeFile(join(base, 'manifest.json'), JSON.stringify({
      schema_version: 2,
      name: teamName,
      task: 'dispatch',
      worker_count: 0,
      workers: [],
      created_at: '2026-03-06T00:00:00.000Z',
      team_state_root: base,
    }, null, 2));

    const sendResult = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'leader-fixed',
      to_worker: 'worker-1',
      body: 'Please continue',
    }, cwd);

    expect(sendResult.ok).toBe(true);
    if (!sendResult.ok) return;
    const messageId = (sendResult.data as { message?: { message_id?: string } }).message?.message_id;
    expect(typeof messageId).toBe('string');

    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message_id).toBe(messageId);
  });

  it('uses the canonical worker pane when duplicate worker records exist', async () => {
    const configPath = join(cwd, '.omc', 'state', 'team', teamName, 'config.json');
    await writeFile(configPath, JSON.stringify({
      name: teamName,
      task: 'dispatch',
      agent_type: 'executor',
      worker_count: 2,
      max_workers: 20,
      tmux_session: 'dispatch-session',
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-1', index: 0, role: 'executor', assigned_tasks: [], pane_id: '%9' },
      ],
      created_at: '2026-03-06T00:00:00.000Z',
      next_task_id: 2,
      leader_pane_id: '%0',
    }, null, 2));

    const result = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'leader-fixed',
      to_worker: 'worker-1',
      body: 'Continue',
    }, cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messageId = (result.data as { message?: { message_id?: string } }).message?.message_id;
    expect(typeof messageId).toBe('string');
    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message_id).toBe(messageId);
    expect(requests[0]?.pane_id).toBe('%9');
    expect(['pending', 'notified']).toContain(requests[0]?.status);
  });
});
