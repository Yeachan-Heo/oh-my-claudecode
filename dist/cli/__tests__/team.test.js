import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    killWorkerPanes: vi.fn(),
    killTeamSession: vi.fn(),
    resumeTeam: vi.fn(),
    monitorTeam: vi.fn(),
    shutdownTeam: vi.fn(),
    isRuntimeV2Enabled: vi.fn(() => false),
    monitorTeamV2: vi.fn(),
    shutdownTeamV2: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        spawn: mocks.spawn,
    };
});
vi.mock('../../team/tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        killWorkerPanes: mocks.killWorkerPanes,
        killTeamSession: mocks.killTeamSession,
    };
});
vi.mock('../../team/runtime-v2.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isRuntimeV2Enabled: mocks.isRuntimeV2Enabled,
        monitorTeamV2: mocks.monitorTeamV2,
        shutdownTeamV2: mocks.shutdownTeamV2,
    };
});
vi.mock('../../team/runtime.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        resumeTeam: mocks.resumeTeam,
        monitorTeam: mocks.monitorTeam,
        shutdownTeam: mocks.shutdownTeam,
    };
});
describe('team cli', () => {
    let jobsDir;
    beforeEach(() => {
        jobsDir = mkdtempSync(join(tmpdir(), 'omc-team-cli-jobs-'));
        process.env.OMC_JOBS_DIR = jobsDir;
        process.env.OMC_RUNTIME_CLI_PATH = '/tmp/runtime-cli.cjs';
        mocks.spawn.mockReset();
        mocks.killWorkerPanes.mockReset();
        mocks.killTeamSession.mockReset();
        mocks.resumeTeam.mockReset();
        mocks.monitorTeam.mockReset();
        mocks.shutdownTeam.mockReset();
        mocks.isRuntimeV2Enabled.mockReset();
        mocks.isRuntimeV2Enabled.mockReturnValue(false);
        mocks.monitorTeamV2.mockReset();
        mocks.shutdownTeamV2.mockReset();
    });
    afterEach(() => {
        delete process.env.OMC_JOBS_DIR;
        delete process.env.OMC_RUNTIME_CLI_PATH;
        rmSync(jobsDir, { recursive: true, force: true });
    });
    it('startTeamJob starts runtime-cli and persists running job', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        mocks.spawn.mockReturnValue({
            pid: 4242,
            stdin: { write, end },
            unref,
        });
        const { startTeamJob } = await import('../team.js');
        const result = await startTeamJob({
            teamName: 'mvp-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: '/tmp/project',
        });
        expect(result.status).toBe('running');
        expect(result.jobId).toMatch(/^omc-[a-z0-9]{1,12}$/);
        expect(result.pid).toBe(4242);
        expect(mocks.spawn).toHaveBeenCalledWith('node', ['/tmp/runtime-cli.cjs'], expect.objectContaining({
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        }));
        expect(write).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledTimes(1);
        const savedJob = JSON.parse(readFileSync(join(jobsDir, `${result.jobId}.json`), 'utf-8'));
        expect(savedJob.status).toBe('running');
        expect(savedJob.pid).toBe(4242);
    });
    it('teamCommand start --json outputs valid JSON envelope', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.spawn.mockReturnValue({
            pid: 7777,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'codex', '--task', 'review auth flow', '--json']);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        // Verify stdin payload sent to runtime-cli
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.agentTypes).toEqual(['codex']);
        expect(stdinPayload.tasks).toHaveLength(1);
        expect(stdinPayload.tasks[0].description).toBe('review auth flow');
        expect(stdinPayload.newWindow).toBeUndefined();
        // Verify --json causes structured JSON output
        expect(logSpy).toHaveBeenCalledTimes(1);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.jobId).toMatch(/^omc-[a-z0-9]{1,12}$/);
        expect(output.status).toBe('running');
        expect(output.pid).toBe(7777);
        logSpy.mockRestore();
    });
    it('teamCommand start forwards --new-window to runtime-cli payload', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.spawn.mockReturnValue({
            pid: 8787,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'codex', '--task', 'review auth flow', '--new-window', '--json']);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.newWindow).toBe(true);
        logSpy.mockRestore();
    });
    it('teamCommand start --json with --count expands agent types', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.spawn.mockReturnValue({
            pid: 8888,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand([
            'start', '--agent', 'gemini', '--count', '3',
            '--task', 'lint all modules', '--name', 'lint-team', '--json',
        ]);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.teamName).toBe('lint-team');
        expect(stdinPayload.agentTypes).toEqual(['gemini', 'gemini', 'gemini']);
        expect(stdinPayload.tasks).toHaveLength(3);
        expect(stdinPayload.tasks.every((t) => t.description === 'lint all modules')).toBe(true);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.status).toBe('running');
        logSpy.mockRestore();
    });
    it('teamCommand start without --json outputs non-JSON', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.spawn.mockReturnValue({
            pid: 9999,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'claude', '--task', 'do stuff']);
        expect(logSpy).toHaveBeenCalledTimes(1);
        // Without --json, output is a raw object (not JSON-stringified)
        const rawOutput = logSpy.mock.calls[0][0];
        expect(typeof rawOutput).toBe('object');
        expect(rawOutput.status).toBe('running');
        logSpy.mockRestore();
    });
    it('getTeamJobStatus converges to result artifact state', async () => {
        const { getTeamJobStatus } = await import('../team.js');
        const jobId = 'omc-abc123';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now() - 2_000,
            teamName: 'demo',
            cwd: '/tmp/demo',
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            teamName: 'demo',
            taskResults: [],
        }));
        const status = await getTeamJobStatus(jobId);
        expect(status.status).toBe('completed');
        expect(status.result).toEqual(expect.objectContaining({ status: 'completed' }));
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
    });
    it('waitForTeamJob times out with running status', async () => {
        const { waitForTeamJob } = await import('../team.js');
        const jobId = 'omc-timeout1';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo',
            cwd: '/tmp/demo',
        }));
        const result = await waitForTeamJob(jobId, { timeoutMs: 10 });
        expect(result.status).toBe('running');
        expect(result.timedOut).toBe(true);
        expect(result.error).toContain('Timed out waiting for job');
    });
    it('cleanupTeamJob kills worker panes and clears team state root', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanup1';
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-cleanup-'));
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({
            paneIds: ['%11', '%12'],
            leaderPaneId: '%10',
            sessionName: 'leader-session:0',
            ownsWindow: false,
        }));
        const result = await cleanupTeamJob(jobId, 1234);
        expect(result.message).toContain('Cleaned up 2 worker pane(s)');
        expect(mocks.killWorkerPanes).toHaveBeenCalledWith({
            paneIds: ['%11', '%12'],
            leaderPaneId: '%10',
            teamName: 'demo-team',
            cwd,
            graceMs: 1234,
        });
        expect(mocks.killTeamSession).not.toHaveBeenCalled();
        expect(existsSync(stateRoot)).toBe(false);
        rmSync(cwd, { recursive: true, force: true });
    });
    it('cleanupTeamJob removes a dedicated team tmux window when recorded', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanup2';
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-window-cleanup-'));
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({
            paneIds: ['%11', '%12'],
            leaderPaneId: '%10',
            sessionName: 'leader-session:3',
            ownsWindow: true,
        }));
        const result = await cleanupTeamJob(jobId, 1234);
        expect(result.message).toContain('Cleaned up team tmux window');
        expect(mocks.killWorkerPanes).not.toHaveBeenCalled();
        expect(mocks.killTeamSession).toHaveBeenCalledWith('leader-session:3', ['%11', '%12'], '%10', { sessionMode: 'dedicated-window' });
        rmSync(cwd, { recursive: true, force: true });
    });
    it('team status uses runtime-v2 snapshot when enabled', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.isRuntimeV2Enabled.mockReturnValue(true);
        mocks.monitorTeamV2.mockResolvedValue({
            teamName: 'demo-team',
            phase: 'team-exec',
            workers: [],
            tasks: { total: 1, pending: 0, blocked: 0, in_progress: 1, completed: 0, failed: 0, items: [] },
            taskCounts: { pending: 0, inProgress: 1, completed: 0, failed: 0 },
            deadWorkers: [],
            nonReportingWorkers: [],
            recommendations: [],
            allTasksTerminal: false,
            performance: { total_ms: 1, list_tasks_ms: 1, worker_scan_ms: 0, mailbox_delivery_ms: 0, updated_at: new Date().toISOString() },
            monitorPerformance: { listTasksMs: 0, workerScanMs: 0, totalMs: 0 },
        });
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-v2-status-'));
        const root = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'demo-session:0',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1' }],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        await teamCommand(['status', 'demo-team', '--json', '--cwd', cwd]);
        expect(mocks.monitorTeamV2).toHaveBeenCalledWith('demo-team', cwd);
        expect(mocks.resumeTeam).not.toHaveBeenCalled();
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.running).toBe(true);
        expect(payload.snapshot.phase).toBe('team-exec');
        expect(payload.workerPaneIds).toEqual(['%1']);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team status supports team-name target via runtime snapshot', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.resumeTeam.mockResolvedValue({
            teamName: 'demo-team',
            sessionName: 'omc-team-demo:0',
            leaderPaneId: '%0',
            config: { teamName: 'demo-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
            workerNames: ['worker-1'],
            workerPaneIds: ['%1'],
            activeWorkers: new Map(),
            cwd: '/tmp/demo',
        });
        mocks.monitorTeam.mockResolvedValue({
            teamName: 'demo-team',
            phase: 'executing',
            workers: [],
            taskCounts: { pending: 0, inProgress: 1, completed: 0, failed: 0 },
            deadWorkers: [],
            monitorPerformance: { listTasksMs: 0, workerScanMs: 0, totalMs: 0 },
        });
        await teamCommand(['status', 'demo-team', '--json']);
        expect(mocks.resumeTeam).toHaveBeenCalledWith('demo-team', process.cwd());
        expect(mocks.monitorTeam).toHaveBeenCalled();
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.running).toBe(true);
        expect(payload.snapshot.phase).toBe('executing');
        logSpy.mockRestore();
    });
    it('team resume invokes runtime resumeTeam', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.resumeTeam.mockResolvedValue({
            teamName: 'alpha-team',
            sessionName: 'omc-team-alpha:0',
            leaderPaneId: '%0',
            config: { teamName: 'alpha-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
            workerNames: ['worker-1'],
            workerPaneIds: ['%1'],
            activeWorkers: new Map([['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }]]),
            cwd: '/tmp/demo',
        });
        await teamCommand(['resume', 'alpha-team', '--json']);
        expect(mocks.resumeTeam).toHaveBeenCalledWith('alpha-team', process.cwd());
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.resumed).toBe(true);
        expect(payload.activeWorkers).toBe(1);
        logSpy.mockRestore();
    });
    it('team shutdown uses runtime-v2 shutdown when enabled', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.isRuntimeV2Enabled.mockReturnValue(true);
        mocks.shutdownTeamV2.mockResolvedValue(undefined);
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-v2-shutdown-'));
        const root = join(cwd, '.omc', 'state', 'team', 'beta-team');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'beta-team',
            task: 'beta',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'beta-session:0',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1' }],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        await teamCommand(['shutdown', 'beta-team', '--force', '--json', '--cwd', cwd]);
        expect(mocks.shutdownTeamV2).toHaveBeenCalledWith('beta-team', cwd, { force: true });
        expect(mocks.resumeTeam).not.toHaveBeenCalled();
        expect(mocks.shutdownTeam).not.toHaveBeenCalled();
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.shutdown).toBe(true);
        expect(payload.forced).toBe(true);
        expect(payload.sessionFound).toBe(true);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team shutdown supports --force and calls runtime shutdown', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.resumeTeam.mockResolvedValue({
            teamName: 'beta-team',
            sessionName: 'omc-team-beta:0',
            leaderPaneId: '%0',
            config: { teamName: 'beta-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
            workerNames: ['worker-1'],
            workerPaneIds: ['%1'],
            activeWorkers: new Map(),
            cwd: '/tmp/demo',
        });
        await teamCommand(['shutdown', 'beta-team', '--force', '--json']);
        expect(mocks.shutdownTeam).toHaveBeenCalledWith('beta-team', 'omc-team-beta:0', '/tmp/demo', 0, ['%1'], '%0', undefined);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.shutdown).toBe(true);
        expect(payload.forced).toBe(true);
        logSpy.mockRestore();
    });
    it('legacy shorthand start alias supports optional ralph token', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.spawn.mockReturnValue({
            pid: 5151,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['ralph', '2:codex', 'ship', 'feature', '--json']);
        expect(write).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(write.mock.calls[0][0]);
        expect(payload.agentTypes).toEqual(['codex', 'codex']);
        expect(payload.tasks[0].subject).toContain('Ralph');
        expect(payload.tasks[0].description).toBe('ship feature');
        const out = JSON.parse(logSpy.mock.calls[0][0]);
        expect(out.status).toBe('running');
        expect(out.pid).toBe(5151);
        logSpy.mockRestore();
    });
    it('team api legacy facade delegates send-message to canonical mailbox state', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-send-'));
        const root = join(cwd, '.omc', 'state', 'team', 'api-team');
        mkdirSync(join(root, 'tasks'), { recursive: true });
        mkdirSync(join(root, 'mailbox'), { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'api-team',
            task: 'api',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'legacy-session',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        await teamCommand([
            'api',
            'send-message',
            '--input',
            JSON.stringify({ teamName: 'api-team', fromWorker: 'worker-1', toWorker: 'leader-fixed', body: 'ACK' }),
            '--json',
            '--cwd',
            cwd,
        ]);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.ok).toBe(true);
        expect(payload.data.message.body).toBe('ACK');
        expect(payload.data.message.to_worker).toBe('leader-fixed');
        const mailbox = JSON.parse(readFileSync(join(root, 'mailbox', 'leader-fixed.json'), 'utf-8'));
        expect(mailbox.messages).toHaveLength(1);
        expect(mailbox.messages[0]?.body).toBe('ACK');
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team api legacy facade supports mailbox-mark-notified through canonical semantics', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-notified-'));
        const root = join(cwd, '.omc', 'state', 'team', 'api-team');
        mkdirSync(join(root, 'mailbox'), { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'api-team',
            task: 'api',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'legacy-session',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        writeFileSync(join(root, 'mailbox', 'worker-1.json'), JSON.stringify({
            worker: 'worker-1',
            messages: [{
                    message_id: 'msg-1',
                    from_worker: 'leader-fixed',
                    to_worker: 'worker-1',
                    body: 'hello',
                    created_at: new Date().toISOString(),
                }],
        }));
        await teamCommand([
            'api',
            'mailbox-mark-notified',
            '--input',
            JSON.stringify({ teamName: 'api-team', workerName: 'worker-1', messageId: 'msg-1' }),
            '--json',
            '--cwd',
            cwd,
        ]);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.ok).toBe(true);
        expect(payload.data.notified).toBe(true);
        const mailbox = JSON.parse(readFileSync(join(root, 'mailbox', 'worker-1.json'), 'utf-8'));
        expect(typeof mailbox.messages[0]?.notified_at).toBe('string');
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team api supports list-tasks and read-config', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-api-'));
        const root = join(cwd, '.omc', 'state', 'team', 'api-team');
        mkdirSync(join(root, 'tasks'), { recursive: true });
        writeFileSync(join(root, 'tasks', 'task-1.json'), JSON.stringify({
            id: '1',
            subject: 'Legacy facade task',
            description: 'canonical task fixture',
            status: 'pending',
            created_at: new Date().toISOString(),
        }));
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'api-team',
            task: 'api',
            agent_type: 'executor',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            tmux_session: 'legacy-session',
            next_task_id: 2,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        await teamCommand(['api', 'list-tasks', '--input', JSON.stringify({ teamName: 'api-team' }), '--json', '--cwd', cwd]);
        const listPayload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(listPayload.ok).toBe(true);
        expect(listPayload.data.tasks[0].id).toBe('1');
        await teamCommand(['api', 'read-config', '--input', JSON.stringify({ teamName: 'api-team' }), '--json', '--cwd', cwd]);
        const configPayload = JSON.parse(logSpy.mock.calls[1][0]);
        expect(configPayload.ok).toBe(true);
        expect(configPayload.data.config.worker_count).toBe(1);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team api returns structured JSON envelope for unsupported operation', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await teamCommand(['api', 'unknown-op', '--json', '--input', JSON.stringify({ teamName: 'demo-team' })]);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.ok).toBe(false);
        expect(payload.error.code).toBe('UNSUPPORTED_OPERATION');
        logSpy.mockRestore();
    });
});
//# sourceMappingURL=team.test.js.map