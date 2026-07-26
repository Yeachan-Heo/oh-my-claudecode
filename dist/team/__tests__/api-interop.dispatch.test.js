import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const tmuxUtilsMocks = vi.hoisted(() => ({
    tmuxExecAsync: vi.fn(async (_args) => ({ stdout: '', stderr: '' })),
    tmuxCmdAsync: vi.fn(async (_args) => ({ stdout: '0\n', stderr: '' })),
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
    tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
}));
import { executeTeamApiOperation } from '../api-interop.js';
import { listDispatchRequests } from '../dispatch-queue.js';
function mockOwnedTmuxPanes(...paneIds) {
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args) => {
        if (args[0] === 'list-panes')
            return { stdout: `${paneIds.join('\n')}\n`, stderr: '' };
        if (args[0] === 'display-message')
            return { stdout: '0\n', stderr: '' };
        if (args[0] === 'capture-pane')
            return { stdout: '❯\n', stderr: '' };
        return { stdout: '', stderr: '' };
    });
}
describe('team api dispatch-aware messaging', () => {
    let cwd;
    const teamName = 'dispatch-team';
    beforeEach(async () => {
        tmuxUtilsMocks.tmuxExecAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
        tmuxUtilsMocks.tmuxCmdAsync.mockReset().mockResolvedValue({ stdout: '0\n', stderr: '' });
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
    it('returns the top-level operation failure for an unknown broadcast team', async () => {
        const result = await executeTeamApiOperation('broadcast', {
            team_name: 'unknown-team',
            from_worker: 'leader-fixed',
            body: 'Unreachable broadcast',
        }, cwd);
        expect(result).toEqual({
            ok: false,
            operation: 'broadcast',
            error: { code: 'operation_failed', message: 'Team unknown-team not found' },
        });
    });
    it('persists leader-fixed messages and leaves a durable pending dispatch request when the leader pane is absent', async () => {
        const result = await executeTeamApiOperation('send-message', {
            team_name: teamName,
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'ACK: worker-1 initialized',
        }, cwd);
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        const data = result.data;
        expect(data.message?.body).toBe('ACK: worker-1 initialized');
        expect(typeof data.message?.message_id).toBe('string');
        const mailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
        expect(existsSync(mailboxPath)).toBe(true);
        const mailbox = JSON.parse(await readFile(mailboxPath, 'utf-8'));
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
        if (!sendResult.ok)
            return;
        const messageId = sendResult.data.message?.message_id;
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
        const mailbox = JSON.parse(await readFile(mailboxPath, 'utf-8'));
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
        expect(requests[0]?.trigger_message).toContain('$OMC_TEAM_STATE_ROOT/mailbox/worker-1.json');
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
        if (!sendResult.ok)
            return;
        const messageId = sendResult.data.message?.message_id;
        expect(typeof messageId).toBe('string');
        const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.message_id).toBe(messageId);
    });
    it('notifies an exactly owned worker pane and commits both replay markers', async () => {
        const configPath = join(cwd, '.omc', 'state', 'team', teamName, 'config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        await writeFile(configPath, JSON.stringify({
            ...config,
            leader_pane_id: '%0',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%9' }],
        }, null, 2));
        mockOwnedTmuxPanes('%0', '%9');
        const result = await executeTeamApiOperation('send-message', {
            team_name: teamName,
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'Continue with the task',
        }, cwd);
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        const outcome = result.data.notification_outcome;
        expect(outcome.reason).toBe('worker_pane_notified');
        const mailbox = JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.json'), 'utf8'));
        expect(mailbox.messages.find((message) => message.message_id === outcome.message_id)?.notified_at).toEqual(expect.any(String));
        const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ request_id: outcome.request_id, message_id: outcome.message_id, status: 'notified' });
        expect(tmuxUtilsMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'send-keys')).toBe(true);
    });
    it('notifies an exactly owned leader pane and commits both replay markers', async () => {
        const configPath = join(cwd, '.omc', 'state', 'team', teamName, 'config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        await writeFile(configPath, JSON.stringify({ ...config, leader_pane_id: '%0' }, null, 2));
        mockOwnedTmuxPanes('%0');
        const result = await executeTeamApiOperation('send-message', {
            team_name: teamName,
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'Worker progress report',
        }, cwd);
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        const outcome = result.data.notification_outcome;
        expect(outcome.reason).toBe('leader_pane_notified');
        const mailbox = JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'leader-fixed.json'), 'utf8'));
        expect(mailbox.messages.find((message) => message.message_id === outcome.message_id)?.notified_at).toEqual(expect.any(String));
        const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ request_id: outcome.request_id, message_id: outcome.message_id, status: 'notified' });
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
        if (!result.ok)
            return;
        const messageId = result.data.message?.message_id;
        expect(typeof messageId).toBe('string');
        const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.message_id).toBe(messageId);
        expect(requests[0]?.pane_id).toBe('%9');
        expect(['pending', 'notified']).toContain(requests[0]?.status);
        expect(tmuxUtilsMocks.tmuxExecAsync).toHaveBeenCalledWith([
            'list-panes', '-t', 'dispatch-session', '-F', '#{pane_id}',
        ]);
        expect(tmuxUtilsMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'send-keys')).toBe(false);
    });
});
//# sourceMappingURL=api-interop.dispatch.test.js.map