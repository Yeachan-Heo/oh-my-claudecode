import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../../team/git-worktree.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { absPath, canonicalTeamStatePath, TeamPaths } from '../../team/state-paths.js';
import { currentStrictProcessStartIdentity } from '../../team/team-owner-epoch.js';
import { withProcessIdentityFileLockSync } from '../../team/process-identity-lock.js';
import { activateTeamInstanceUnderLock, createTeamInstanceBinding, reserveTeamInstanceUnderLock, withTeamInstanceLifecycleLock, } from '../../team/team-instance.js';
const tmuxMocks = vi.hoisted(() => ({
    killWorkerPanes: vi.fn(async () => undefined),
    killTeamSession: vi.fn(async () => undefined),
    observeTmuxServerIdentity: vi.fn(async () => 'matching'),
    isWorkerAlive: vi.fn(async () => false),
    getWorkerLiveness: vi.fn(async () => 'dead'),
    captureOwnedTeamPane: vi.fn(async () => ''),
    sendToWorker: vi.fn(async () => false),
}));
const childMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}));
const serverMocks = vi.hoisted(() => ({
    handlers: [],
}));
const runtimeMocks = vi.hoisted(() => ({
    isRuntimeV2Enabled: vi.fn(() => true),
    shutdownTeamV2: vi.fn(async (..._args) => ({ outcome: 'cleaned' })),
    actualShutdownTeamV2: undefined,
    resumeTeam: vi.fn(),
    shutdownTeam: vi.fn(),
}));
const monitorMocks = vi.hoisted(() => ({
    readTeamConfig: vi.fn(),
    actualReadTeamConfig: undefined,
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        spawn: childMocks.spawn,
    };
});
vi.mock('@modelcontextprotocol/sdk/server/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    class CapturingServer {
        setRequestHandler(_schema, handler) {
            serverMocks.handlers.push(handler);
        }
        async connect(_transport) {
            return undefined;
        }
    }
    return {
        ...actual,
        Server: CapturingServer,
    };
});
vi.mock('../../team/tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        killWorkerPanes: tmuxMocks.killWorkerPanes,
        killTeamSession: tmuxMocks.killTeamSession,
        observeTmuxServerIdentity: tmuxMocks.observeTmuxServerIdentity,
        isWorkerAlive: tmuxMocks.isWorkerAlive,
        getWorkerLiveness: tmuxMocks.getWorkerLiveness,
        captureOwnedTeamPane: tmuxMocks.captureOwnedTeamPane,
        sendToWorker: tmuxMocks.sendToWorker,
    };
});
vi.mock('../../team/runtime-v2.js', async (importOriginal) => {
    const actual = await importOriginal();
    runtimeMocks.actualShutdownTeamV2 = actual.shutdownTeamV2;
    return {
        ...actual,
        isRuntimeV2Enabled: runtimeMocks.isRuntimeV2Enabled,
        shutdownTeamV2: runtimeMocks.shutdownTeamV2,
    };
});
vi.mock('../../team/runtime.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        resumeTeam: runtimeMocks.resumeTeam,
        shutdownTeam: runtimeMocks.shutdownTeam,
    };
});
vi.mock('../../team/monitor.js', async (importOriginal) => {
    const actual = await importOriginal();
    monitorMocks.actualReadTeamConfig = actual.readTeamConfig;
    monitorMocks.readTeamConfig.mockImplementation(actual.readTeamConfig);
    return {
        ...actual,
        readTeamConfig: monitorMocks.readTeamConfig,
    };
});
const originalEnv = { ...process.env };
const originalOmcStateDir = process.env.OMC_STATE_DIR;
const INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_INSTANCE_ID = '66666666-6666-4666-8666-666666666666';
const capturedTmuxProcessIdentity = (process.platform === 'darwin' || process.platform === 'linux')
    ? currentStrictProcessStartIdentity()
    : null;
const capturedTmuxServerIdentity = capturedTmuxProcessIdentity
    ? {
        socket_path: '/tmp/omc-team-server-receipt.sock',
        server_pid: process.pid,
        process_started_at: capturedTmuxProcessIdentity,
    }
    : undefined;
function paneArtifact(instanceId, paneIds, leaderPaneId = '%1', sessionName = 'team-one:0') {
    return {
        instanceId,
        paneIds,
        leaderPaneId,
        sessionName,
        ownsWindow: false,
        workers: paneIds.map((paneId, index) => ({
            workerName: `worker-${index + 1}`,
            paneId,
            launchAttemptId: `attempt-${index + 1}`,
        })),
    };
}
function jobRecord(teamName, cwd, instanceId = INSTANCE_ID) {
    return { status: 'running', startedAt: Date.now(), cwd, teamName, instanceId };
}
function parseResponseText(text) {
    return JSON.parse(text);
}
function boundedSignal(signal, timeoutMs) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        signal.then(() => {
            clearTimeout(timer);
            resolve(true);
        }, () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
const NUDGE_SERVER_IDENTITY = {
    socket_path: '/tmp/omc-idle-nudge-custom.sock',
    server_pid: process.pid,
    process_started_at: capturedTmuxProcessIdentity ?? 'test-process',
};
function buildNudgeConfig(binding, paneId, leaderPaneId, sessionName, serverIdentity) {
    const worker = {
        name: 'worker-1',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: paneId,
        worker_cli: 'claude',
        launch_attempt_id: 'attempt-1',
        launch_descriptor: {
            schema_version: 1,
            provider: 'claude',
            model: null,
            binary: '/usr/bin/claude',
            args: [],
        },
    };
    return {
        name: binding.team_name,
        instance_id: binding.instance_id,
        task: 'idle nudge integration',
        agent_type: 'claude',
        worker_launch_mode: 'interactive',
        worker_count: 1,
        max_workers: 20,
        workers: [worker],
        created_at: new Date().toISOString(),
        tmux_session: sessionName,
        ...(serverIdentity ? { tmux_server_identity: serverIdentity } : {}),
        next_task_id: 1,
        leader_cwd: binding.cwd,
        team_state_root: binding.state_root,
        leader_pane_id: leaderPaneId,
        hud_pane_id: null,
        resize_hook_name: null,
        resize_hook_target: null,
        state_revision: 0,
        lifecycle_state: 'active',
    };
}
async function createActiveNudgeTeam(teamName, cwd, instanceId, provider = 'tmux', serverIdentity = NUDGE_SERVER_IDENTITY) {
    mkdirSync(cwd, { recursive: true });
    const binding = createTeamInstanceBinding({ teamName, cwd, instanceId });
    const paneId = provider === 'cmux' ? 'surface-worker-1' : '%2';
    const leaderPaneId = provider === 'cmux' ? 'surface-leader' : '%1';
    const sessionName = provider === 'cmux' ? 'cmux:idle-nudge' : `${teamName}:0`;
    const effectiveServerIdentity = provider === 'tmux' ? serverIdentity : undefined;
    const config = buildNudgeConfig(binding, paneId, leaderPaneId, sessionName, effectiveServerIdentity);
    await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
        await reserveTeamInstanceUnderLock({ teamName, cwd, instanceId });
        mkdirSync(binding.state_root, { recursive: true });
        writeFileSync(join(binding.state_root, 'config.json'), JSON.stringify(config), 'utf-8');
        await activateTeamInstanceUnderLock(binding);
    });
    return {
        binding,
        config,
        paneId,
        leaderPaneId,
        sessionName,
        ...(effectiveServerIdentity ? { serverIdentity: effectiveServerIdentity } : {}),
    };
}
async function createReplacementNudgeFixture(fixture, instanceId) {
    const binding = createTeamInstanceBinding({
        teamName: fixture.binding.team_name,
        cwd: fixture.binding.cwd,
        instanceId,
    });
    const config = buildNudgeConfig(binding, fixture.paneId, fixture.leaderPaneId, fixture.sessionName, fixture.serverIdentity);
    await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
        rmSync(fixture.binding.state_root, { recursive: true, force: true });
        rmSync(absPath(fixture.binding.cwd, TeamPaths.teamInstanceReservation(fixture.binding.workspace_hash, fixture.binding.team_name)), { force: true });
        await reserveTeamInstanceUnderLock({
            teamName: binding.team_name,
            cwd: binding.cwd,
            instanceId,
        });
        mkdirSync(binding.state_root, { recursive: true });
        writeFileSync(join(binding.state_root, 'config.json'), JSON.stringify(config), 'utf-8');
        await activateTeamInstanceUnderLock(binding);
    });
    return {
        binding,
        config,
        paneId: fixture.paneId,
        leaderPaneId: fixture.leaderPaneId,
        sessionName: fixture.sessionName,
        ...(fixture.serverIdentity ? { serverIdentity: fixture.serverIdentity } : {}),
    };
}
async function importTeamServerWithJobsDir(jobsDir) {
    process.env.OMC_TEAM_SERVER_DISABLE_AUTOSTART = '1';
    process.env.NODE_ENV = 'test';
    process.env.OMC_JOBS_DIR = jobsDir;
    serverMocks.handlers.length = 0;
    childMocks.spawn.mockReset();
    vi.resetModules();
    return import('../team-server.js');
}
function callCapturedTool(arguments_, name) {
    const handler = serverMocks.handlers.at(-1);
    if (!handler)
        throw new Error('team server call handler was not registered');
    return handler({ params: { name, arguments: arguments_ } });
}
describe('team-server artifact convergence + scoped cleanup', () => {
    let testRoot;
    let jobsDir;
    let previousHome;
    let previousUserProfile;
    const teamStateDir = (cwd, teamName) => join(getOmcRoot(cwd), 'state', 'team', teamName);
    beforeEach(() => {
        // mkdtempSync guarantees per-test uniqueness; Date.now() can collide
        // across fast beforeEach calls and retain a previous reservation.
        testRoot = mkdtempSync(join(tmpdir(), `omc-team-server-test-${process.pid}-`));
        jobsDir = join(testRoot, 'jobs');
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = testRoot;
        process.env.USERPROFILE = testRoot;
        // Node's homedir() can remain process-cached after HOME changes, so
        // unsetting this variable would still anchor non-git state in the real
        // user home. Keep the canonical state root under this test directory.
        process.env.OMC_STATE_DIR = join(testRoot, '.omc-state');
        mkdirSync(jobsDir, { recursive: true });
    });
    afterEach(() => {
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        if (originalOmcStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = originalOmcStateDir;
        rmSync(testRoot, { recursive: true, force: true });
        process.env = { ...originalEnv };
        vi.clearAllMocks();
        tmuxMocks.killWorkerPanes.mockResolvedValue(undefined);
        tmuxMocks.killTeamSession.mockResolvedValue(undefined);
        tmuxMocks.observeTmuxServerIdentity.mockResolvedValue('matching');
        tmuxMocks.isWorkerAlive.mockResolvedValue(false);
        tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');
        tmuxMocks.captureOwnedTeamPane.mockReset();
        tmuxMocks.captureOwnedTeamPane.mockResolvedValue('');
        tmuxMocks.sendToWorker.mockReset();
        tmuxMocks.sendToWorker.mockResolvedValue(false);
        runtimeMocks.isRuntimeV2Enabled.mockReset();
        runtimeMocks.isRuntimeV2Enabled.mockReturnValue(true);
        runtimeMocks.shutdownTeamV2.mockReset();
        runtimeMocks.shutdownTeamV2.mockResolvedValue({ outcome: 'cleaned' });
        runtimeMocks.resumeTeam.mockReset();
        runtimeMocks.shutdownTeam.mockReset();
        monitorMocks.readTeamConfig.mockReset();
        if (monitorMocks.actualReadTeamConfig) {
            monitorMocks.readTeamConfig.mockImplementation(monitorMocks.actualReadTeamConfig);
        }
    });
    it('handleStatus converges to terminal artifact before pid liveness', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art1';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({ ...jobRecord('artifact-team', '/tmp/artifact-team'), pid: 999999 }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({ status: 'completed', instanceId: INSTANCE_ID, teamName: 'artifact-team', taskResults: [] }), 'utf-8');
        const response = await handleStatus({ job_id: jobId });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.status).toBe('completed');
        expect(payload.result).toMatchObject({ status: 'completed', teamName: 'artifact-team' });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
    });
    it('reloads a changed durable PID at the lock boundary and never resurrects a removed job', async () => {
        const { handleStatus, handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artpidboundary';
        const jobPath = join(jobsDir, `${jobId}.json`);
        // Mutate only between public calls; each read/convergence section owns the lock.
        writeFileSync(jobPath, JSON.stringify({
            ...jobRecord('artifact-team', '/tmp/artifact-team'),
            pid: process.pid,
        }), 'utf-8');
        const running = await handleStatus({ job_id: jobId });
        expect(parseResponseText(running.content[0].text).status).toBe('running');
        writeFileSync(jobPath, JSON.stringify({
            ...jobRecord('artifact-team', '/tmp/artifact-team'),
            pid: 999999,
        }), 'utf-8');
        const dead = await handleStatus({ job_id: jobId });
        const deadPayload = parseResponseText(dead.content[0].text);
        expect(deadPayload.status).toBe('failed');
        expect(deadPayload.stderr).toBe('Process no longer alive (MCP restart?)');
        expect(deadPayload.result).toEqual({ error: 'Process no longer alive (MCP restart?)' });
        expect(deadPayload.error).toBeUndefined();
        const waited = await handleWait({ job_id: jobId, timeout_ms: 2_000 });
        const waitedPayload = parseResponseText(waited.content[0].text);
        expect(waitedPayload.status).toBe('failed');
        expect(waitedPayload.stderr).toBe('Process no longer alive (MCP restart?)');
        expect(waitedPayload.result).toEqual({ error: 'Process no longer alive (MCP restart?)' });
        expect(waitedPayload.error).toBeUndefined();
        rmSync(jobPath, { force: true });
        const missingStatus = await handleStatus({ job_id: jobId });
        expect(parseResponseText(missingStatus.content[0].text)).toEqual({ error: `No job found: ${jobId}` });
        const missing = await handleWait({ job_id: jobId, timeout_ms: 0 });
        expect(parseResponseText(missing.content[0].text)).toEqual({ error: `No job found: ${jobId}` });
        expect(existsSync(jobPath)).toBe(false);
    });
    it('repairs a failed durable job when a later matching completed artifact arrives', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artlatecompleted';
        const resultArtifact = JSON.stringify({
            status: 'completed',
            teamName: 'artifact-team',
            instanceId: INSTANCE_ID,
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('artifact-team', '/tmp/artifact-team'),
            status: 'failed',
            stderr: 'transient close failure',
            result: JSON.stringify({ error: 'terminal_result_evidence_missing' }),
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), resultArtifact, 'utf-8');
        const response = await handleStatus({ job_id: jobId });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('completed');
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.result).toEqual(JSON.parse(resultArtifact));
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
        expect(persisted.result).toBe(resultArtifact);
        expect(persisted.stderr).toBe('transient close failure');
    });
    it('handleWait deterministically fails on parse-failed artifact and persists failure', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art2';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({ ...jobRecord('artifact-team', '/tmp/artifact-team'), pid: process.pid }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), '{not-json', 'utf-8');
        const response = await handleWait({ job_id: jobId, timeout_ms: 2000 });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('failed');
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.result).toMatchObject({
            error: { code: 'RESULT_ARTIFACT_PARSE_FAILED' },
        });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('failed');
    });
    it('handleWait with zero timeout returns a durable missing-job response without creating a file', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-waitmissing';
        const response = await handleWait({ job_id: jobId, timeout_ms: 0 });
        expect(parseResponseText(response.content[0].text)).toEqual({ error: `No job found: ${jobId}` });
        expect(readdirSync(jobsDir)).toEqual([]);
    });
    it('handleWait with zero timeout returns a matching terminal artifact instead of a running timeout', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-waitdone';
        const resultArtifact = JSON.stringify({
            status: 'completed',
            teamName: 'artifact-team',
            instanceId: INSTANCE_ID,
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('artifact-team', '/tmp/artifact-team')), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), resultArtifact, 'utf-8');
        const response = await handleWait({ job_id: jobId, timeout_ms: 0 });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('completed');
        expect(payload.status).not.toBe('running');
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.result).toEqual(JSON.parse(resultArtifact));
        expect(payload.error).toBeUndefined();
    });
    it('handleStatus rejects a terminal result artifact from a stale team incarnation', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artstale';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('artifact-team', '/tmp/artifact-team')), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            instanceId: OTHER_INSTANCE_ID,
            teamName: 'artifact-team',
            taskResults: [],
        }), 'utf-8');
        const response = await handleStatus({ job_id: jobId });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.status).toBe('failed');
        expect(payload.stderr).toContain('identity mismatch');
        expect(payload.result).toEqual({ error: 'result_artifact_identity_mismatch' });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.instanceId).toBe(INSTANCE_ID);
        expect(persisted.status).toBe('failed');
    });
    it('handleStatus rejects a terminal artifact missing instance identity', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artmissingid';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('artifact-team', '/tmp/artifact-team')), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            teamName: 'artifact-team',
            taskResults: [],
        }), 'utf-8');
        const response = await handleStatus({ job_id: jobId });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.status).toBe('failed');
        expect(payload.result).toEqual(expect.objectContaining({
            error: expect.objectContaining({ code: 'RESULT_ARTIFACT_IDENTITY_MISSING' }),
        }));
    });
    it('handleStatus rejects a missing or corrupt persisted job instead of inferring authority', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        await expect(handleStatus({ job_id: 'omc-artmissingjob' }))
            .resolves.toMatchObject({ content: [{ text: expect.stringContaining('No job found') }] });
        writeFileSync(join(jobsDir, 'omc-artcorruptjob.json'), '{not-json', 'utf-8');
        await expect(handleStatus({ job_id: 'omc-artcorruptjob' }))
            .rejects.toThrow('Corrupt job file');
    });
    it('handleCleanup rejects missing or corrupt job authority without touching team state', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const missing = await handleCleanup({ job_id: 'omc-missingjob', grace_ms: 0 });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('not found');
        writeFileSync(join(jobsDir, 'omc-corruptjob.json'), '{not-json', 'utf-8');
        await expect(handleCleanup({ job_id: 'omc-corruptjob', grace_ms: 0 }))
            .rejects.toThrow('Corrupt job file');
        expect(runtimeMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it('handleWait preserves the original instance identity in timeout results', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-arttimeout';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('artifact-team', '/tmp/artifact-team'),
            pid: process.pid,
        }), 'utf-8');
        const response = await handleWait({ job_id: jobId, timeout_ms: 0 });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('running');
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.jobId).toBe(jobId);
    });
    it('handleWait does not send to a replacement after the original pane capture loses authority', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const teamName = 'nudge-race-team';
        const cwd = join(testRoot, 'workspace-nudge-race');
        const fixture = await createActiveNudgeTeam(teamName, cwd, INSTANCE_ID, 'tmux', NUDGE_SERVER_IDENTITY);
        const jobId = 'omc-nudgerace';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord(teamName, cwd, INSTANCE_ID)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [fixture.paneId], fixture.leaderPaneId, fixture.sessionName)), 'utf-8');
        let captureStarted;
        let releaseCapture;
        let captureReleased = false;
        const captureGate = new Promise(resolve => { captureStarted = resolve; });
        tmuxMocks.captureOwnedTeamPane.mockImplementationOnce(async (ownership) => {
            expect(ownership).toMatchObject({
                provider: 'tmux',
                providerTarget: fixture.sessionName,
                paneId: fixture.paneId,
                tmuxServerIdentity: NUDGE_SERVER_IDENTITY,
            });
            captureStarted();
            return new Promise(resolve => { releaseCapture = resolve; });
        });
        tmuxMocks.sendToWorker.mockResolvedValue(true);
        const waitPromise = handleWait({
            job_id: jobId,
            timeout_ms: 700,
            nudge_delay_ms: 0,
            nudge_max_count: 1,
        });
        const captureObserved = await boundedSignal(captureGate, 2_000);
        let replacementError;
        if (captureObserved) {
            try {
                const replacement = await createReplacementNudgeFixture(fixture, OTHER_INSTANCE_ID);
                expect(replacement.config.instance_id).toBe(OTHER_INSTANCE_ID);
            }
            catch (error) {
                replacementError = error;
            }
        }
        if (!captureReleased) {
            captureReleased = true;
            releaseCapture?.([
                'worker output from the original server',
                '',
                '> ',
            ].join('\n'));
        }
        const response = await waitPromise;
        expect(captureObserved).toBe(true);
        if (replacementError)
            throw replacementError;
        const payload = parseResponseText(response.content[0].text);
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.nudges).toBeUndefined();
        expect(tmuxMocks.sendToWorker).not.toHaveBeenCalled();
        expect(tmuxMocks.captureOwnedTeamPane).toHaveBeenCalledTimes(1);
        const replacementConfig = JSON.parse(readFileSync(join(createTeamInstanceBinding({
            teamName,
            cwd,
            instanceId: OTHER_INSTANCE_ID,
        }).state_root, 'config.json'), 'utf-8'));
        expect(replacementConfig.instance_id).toBe(OTHER_INSTANCE_ID);
        const replacementBinding = createTeamInstanceBinding({
            teamName,
            cwd,
            instanceId: OTHER_INSTANCE_ID,
        });
        const replacementReservation = JSON.parse(readFileSync(absPath(cwd, TeamPaths.teamInstanceReservation(replacementBinding.workspace_hash, teamName)), 'utf-8'));
        expect(replacementReservation).toMatchObject({
            phase: 'active',
            instance_id: OTHER_INSTANCE_ID,
        });
    });
    it('handleWait retains the original lifecycle lock across deferred tmux input', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const teamName = 'nudge-lock-team';
        const cwd = join(testRoot, 'workspace-nudge-lock');
        const fixture = await createActiveNudgeTeam(teamName, cwd, INSTANCE_ID, 'tmux', NUDGE_SERVER_IDENTITY);
        const jobId = 'omc-nudgelock';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord(teamName, cwd, INSTANCE_ID)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [fixture.paneId], fixture.leaderPaneId, fixture.sessionName)), 'utf-8');
        tmuxMocks.captureOwnedTeamPane.mockResolvedValue([
            'worker output from the original server',
            '',
            '> ',
        ].join('\n'));
        let sendStarted;
        let releaseSend;
        const sendGate = new Promise(resolve => { sendStarted = resolve; });
        tmuxMocks.sendToWorker.mockImplementationOnce(async (...args) => {
            expect(args).toEqual([
                fixture.sessionName,
                fixture.paneId,
                expect.any(String),
                NUDGE_SERVER_IDENTITY,
            ]);
            return new Promise(resolve => {
                releaseSend = resolve;
                sendStarted();
            });
        });
        const waitPromise = handleWait({
            job_id: jobId,
            timeout_ms: 700,
            nudge_delay_ms: 0,
            nudge_max_count: 1,
        });
        let competingEntered = false;
        let competing;
        const sendObserved = await boundedSignal(sendGate, 2_000);
        let competingWasBlocked = false;
        let competingSetupError;
        try {
            if (sendObserved) {
                competing = withTeamInstanceLifecycleLock(fixture.binding.cwd, fixture.binding.team_name, async () => {
                    competingEntered = true;
                });
                await new Promise(resolve => setTimeout(resolve, 30));
                competingWasBlocked = !competingEntered;
            }
        }
        catch (error) {
            competingSetupError = error;
        }
        finally {
            releaseSend?.(true);
        }
        await waitPromise;
        await competing;
        expect(sendObserved).toBe(true);
        if (competingSetupError)
            throw competingSetupError;
        expect(competingWasBlocked).toBe(true);
        // The competing lock callback is queued until the original nudge effect
        // completes; it must have entered by the time the wait releases.
        expect(competingEntered).toBe(true);
        expect(tmuxMocks.captureOwnedTeamPane).toHaveBeenCalledWith(expect.objectContaining({
            providerTarget: fixture.sessionName,
            tmuxServerIdentity: NUDGE_SERVER_IDENTITY,
        }));
        expect(tmuxMocks.sendToWorker).toHaveBeenCalledWith(fixture.sessionName, fixture.paneId, expect.any(String), NUDGE_SERVER_IDENTITY);
    });
    it('handleWait rechecks the durable job under its lock immediately before input', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const teamName = 'nudge-job-loss-team';
        const cwd = join(testRoot, 'workspace-nudge-job-loss');
        const fixture = await createActiveNudgeTeam(teamName, cwd, INSTANCE_ID, 'tmux', NUDGE_SERVER_IDENTITY);
        const jobId = 'omc-nudgejobloss';
        const jobPath = join(jobsDir, `${jobId}.json`);
        writeFileSync(jobPath, JSON.stringify(jobRecord(teamName, cwd, INSTANCE_ID)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [fixture.paneId], fixture.leaderPaneId, fixture.sessionName)), 'utf-8');
        tmuxMocks.captureOwnedTeamPane.mockResolvedValue([
            'worker output from the original server',
            '',
            '> ',
        ].join('\n'));
        tmuxMocks.sendToWorker.mockResolvedValue(true);
        const originalReadTeamConfig = monitorMocks.actualReadTeamConfig;
        expect(originalReadTeamConfig).toBeDefined();
        let matchingConfigReads = 0;
        monitorMocks.readTeamConfig.mockImplementation(async (readTeamName, readCwd) => {
            const config = await originalReadTeamConfig(readTeamName, readCwd);
            if (readTeamName === teamName && readCwd === cwd) {
                matchingConfigReads++;
                if (matchingConfigReads === 2) {
                    // Simulate terminalization/removal by a cooperating writer that
                    // owns the durable job lock, not by mutating the file concurrently.
                    withProcessIdentityFileLockSync(join(jobsDir, `.${jobId}.lock`), () => rmSync(jobPath, { force: true }));
                }
            }
            return config;
        });
        const response = await handleWait({
            job_id: jobId,
            timeout_ms: 700,
            nudge_delay_ms: 0,
            nudge_max_count: 1,
        });
        const payload = parseResponseText(response.content[0].text);
        expect(matchingConfigReads).toBeGreaterThanOrEqual(2);
        expect(payload).toEqual({ error: `No job found: ${jobId}` });
        expect(tmuxMocks.sendToWorker).not.toHaveBeenCalled();
        expect(existsSync(jobPath)).toBe(false);
    });
    it('handleWait nudges a CMUX worker with instance identity and no fabricated tmux identity', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const teamName = 'nudge-cmux-team';
        const cwd = join(testRoot, 'workspace-nudge-cmux');
        const fixture = await createActiveNudgeTeam(teamName, cwd, INSTANCE_ID, 'cmux');
        const jobId = 'omc-nudgecmux';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord(teamName, cwd, INSTANCE_ID)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [fixture.paneId], fixture.leaderPaneId, fixture.sessionName)), 'utf-8');
        tmuxMocks.captureOwnedTeamPane.mockResolvedValue([
            'worker output from cmux',
            '',
            '> ',
        ].join('\n'));
        tmuxMocks.sendToWorker.mockResolvedValue(true);
        const response = await handleWait({
            job_id: jobId,
            timeout_ms: 700,
            nudge_delay_ms: 0,
            nudge_max_count: 1,
        });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.instanceId).toBe(INSTANCE_ID);
        expect(payload.nudges).toBeDefined();
        expect(tmuxMocks.captureOwnedTeamPane).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'cmux',
            providerTarget: fixture.sessionName,
            paneId: fixture.paneId,
        }));
        expect(tmuxMocks.captureOwnedTeamPane.mock.calls[0]?.[0]).not.toHaveProperty('tmuxServerIdentity');
        expect(tmuxMocks.sendToWorker).toHaveBeenCalledWith(fixture.sessionName, fixture.paneId, expect.any(String));
        expect(tmuxMocks.sendToWorker.mock.calls[0]).toHaveLength(3);
    });
    it('does not let child close overwrite a terminal artifact converged first', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        let closeHandler;
        let stdoutHandler;
        let stderrHandler;
        const child = {
            pid: 4321,
            stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
            stdout: {
                on: vi.fn((event, handler) => {
                    if (event === 'data')
                        stdoutHandler = handler;
                }),
            },
            stderr: {
                on: vi.fn((event, handler) => {
                    if (event === 'data')
                        stderrHandler = handler;
                }),
            },
            on: vi.fn((event, handler) => {
                if (event === 'close')
                    closeHandler = handler;
            }),
            kill: vi.fn(),
        };
        childMocks.spawn.mockReturnValue(child);
        const startResponse = await callCapturedTool({
            teamName: 'artifact-race-team',
            agentTypes: ['claude'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: join(testRoot, 'artifact-race-workspace'),
        }, 'omc_run_team_start');
        const startPayload = parseResponseText(startResponse.content[0].text);
        const jobId = String(startPayload.jobId);
        const instanceId = String(startPayload.instanceId);
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            instanceId,
            teamName: 'artifact-race-team',
            taskResults: [],
        }), 'utf-8');
        const converged = await handleStatus({ job_id: jobId });
        expect(parseResponseText(converged.content[0].text).status).toBe('completed');
        const before = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(closeHandler).toBeDefined();
        expect(stdoutHandler).toBeDefined();
        expect(stderrHandler).toBeDefined();
        stdoutHandler(Buffer.from(JSON.stringify({
            status: 'failed',
            instanceId: OTHER_INSTANCE_ID,
            teamName: 'artifact-race-team',
            taskResults: [],
        })));
        stderrHandler(Buffer.from('late close stderr'));
        closeHandler(1);
        const after = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(after).toEqual(before);
    });
    it('marks a code-zero child with empty stdout failed without terminal proof', async () => {
        await importTeamServerWithJobsDir(jobsDir);
        let closeHandler;
        const child = {
            pid: 4322,
            stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn((event, handler) => {
                if (event === 'close')
                    closeHandler = handler;
            }),
            kill: vi.fn(),
        };
        childMocks.spawn.mockReturnValue(child);
        const startResponse = await callCapturedTool({
            teamName: 'empty-output-team',
            agentTypes: ['claude'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: join(testRoot, 'empty-output-workspace'),
        }, 'omc_run_team_start');
        const startPayload = parseResponseText(startResponse.content[0].text);
        const jobId = String(startPayload.jobId);
        expect(closeHandler).toBeDefined();
        closeHandler(0);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.stderr).toBe('terminal_result_evidence_missing');
    });
    it('does not resurrect a cached job after its durable authority file disappears', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        childMocks.spawn.mockReturnValue({
            pid: 4323,
            stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
        });
        const startResponse = await callCapturedTool({
            teamName: 'durable-authority-team',
            agentTypes: ['claude'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: join(testRoot, 'durable-authority-workspace'),
        }, 'omc_run_team_start');
        const startPayload = parseResponseText(startResponse.content[0].text);
        const jobId = String(startPayload.jobId);
        const jobPath = join(jobsDir, `${jobId}.json`);
        expect(existsSync(jobPath)).toBe(true);
        rmSync(jobPath, { force: true });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('not found');
        expect(existsSync(jobPath)).toBe(false);
        expect(runtimeMocks.shutdownTeamV2).not.toHaveBeenCalled();
    });
    it.each(['replacement', 'removal'])('does not overwrite a durable job %s that changes before synchronous MCP spawn throws', async (mode) => {
        await importTeamServerWithJobsDir(jobsDir);
        let spawnJobsDir;
        childMocks.spawn.mockImplementationOnce((_command, _args, options) => {
            const effectiveJobsDir = options?.env?.OMC_JOBS_DIR ?? process.env.OMC_JOBS_DIR ?? jobsDir;
            expect(effectiveJobsDir).toBe(jobsDir);
            spawnJobsDir = effectiveJobsDir;
            const jobId = options?.env?.OMC_JOB_ID;
            if (!jobId)
                throw new Error('spawn job identity is missing');
            const jobName = `${jobId}.json`;
            const jobPath = join(effectiveJobsDir, jobName);
            if (mode === 'replacement') {
                writeFileSync(jobPath, JSON.stringify({
                    status: 'running',
                    startedAt: Date.now(),
                    teamName: 'sync-mcp-spawn-team',
                    cwd: join(testRoot, 'sync-mcp-spawn-workspace'),
                    instanceId: OTHER_INSTANCE_ID,
                    stderr: 'replacement owner',
                }), 'utf-8');
            }
            else {
                rmSync(jobPath, { force: true });
            }
            throw new Error('synchronous MCP spawn failure');
        });
        const response = await callCapturedTool({
            teamName: 'sync-mcp-spawn-team',
            agentTypes: ['claude'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: join(testRoot, 'sync-mcp-spawn-workspace'),
        }, 'omc_run_team_start');
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('synchronous MCP spawn failure');
        const durableJobsDir = spawnJobsDir ?? jobsDir;
        const files = readdirSync(durableJobsDir).filter(name => name.endsWith('.json'));
        if (mode === 'replacement') {
            expect(files).toHaveLength(1);
            const saved = JSON.parse(readFileSync(join(durableJobsDir, files[0]), 'utf-8'));
            expect(saved.instanceId).toBe(OTHER_INSTANCE_ID);
            expect(saved.stderr).toBe('replacement owner');
        }
        else {
            expect(files).toEqual([]);
        }
    });
    it('merges current status and result fields after deferred cleanup succeeds', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-deferredstatus';
        const cwd = join(testRoot, 'workspace-deferred-status');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])), 'utf-8');
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = handleCleanup({ job_id: jobId, grace_ms: 0 });
        const cleanupSettled = cleanupPromise.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
        const entered = await Promise.race([
            called.then(() => 'entered'),
            cleanupSettled.then(() => 'settled'),
        ]);
        expect(entered).toBe('entered');
        const result = JSON.stringify({
            status: 'completed',
            instanceId: INSTANCE_ID,
            teamName: 'team-one',
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('team-one', cwd),
            status: 'completed',
            result,
            stderr: 'terminal result published while cleanup waited',
            pid: 9876,
        }), 'utf-8');
        release({ outcome: 'cleaned' });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
        expect(persisted.result).toBe(result);
        expect(persisted.stderr).toBe('terminal result published while cleanup waited');
        expect(persisted.pid).toBe(9876);
        expect(persisted.cleanedUpAt).toEqual(expect.any(String));
        expect(existsSync(teamDir)).toBe(true);
    });
    it('does not regress a newer cleanup blocked reason during deferred failure publication', async () => {
        const { handleCleanup, handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-deferredreason';
        const cwd = join(testRoot, 'workspace-deferred-reason');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('team-one', cwd),
            cleanupBlockedAt: '2026-01-01T00:00:00.000Z',
            cleanupBlockedReason: 'R1',
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])), 'utf-8');
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = handleCleanup({ job_id: jobId, grace_ms: 0 });
        const cleanupSettled = cleanupPromise.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
        const entered = await Promise.race([
            called.then(() => 'entered'),
            cleanupSettled.then(() => 'settled'),
        ]);
        expect(entered).toBe('entered');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('team-one', cwd),
            cleanupBlockedAt: '2026-02-02T00:00:00.000Z',
            cleanupBlockedReason: 'R2',
        }), 'utf-8');
        expect(parseResponseText((await handleStatus({ job_id: jobId })).content[0].text).status).toBe('running');
        release({ outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['worker-1'] });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanupBlockedReason).toBe('R2');
        expect(saved.cleanedUpAt).toBeUndefined();
        expect(existsSync(teamDir)).toBe(true);
    });
    it('never erases a cleanup marker written by another deferred cleanup', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-deferredcleaned';
        const cwd = join(testRoot, 'workspace-deferred-cleaned');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])), 'utf-8');
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = handleCleanup({ job_id: jobId, grace_ms: 0 });
        const cleanupSettled = cleanupPromise.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
        const entered = await Promise.race([
            called.then(() => 'entered'),
            cleanupSettled.then(() => 'settled'),
        ]);
        expect(entered).toBe('entered');
        const cleanupAt = '2026-02-03T04:05:06.000Z';
        const result = JSON.stringify({
            status: 'failed',
            instanceId: INSTANCE_ID,
            teamName: 'team-one',
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            ...jobRecord('team-one', cwd),
            status: 'failed',
            result,
            stderr: 'another cleanup completed',
            cleanedUpAt: cleanupAt,
        }), 'utf-8');
        release({ outcome: 'cleaned' });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBe(cleanupAt);
        expect(persisted.result).toBe(result);
        expect(persisted.stderr).toBe('another cleanup completed');
        expect(existsSync(teamDir)).toBe(true);
    });
    it('handleCleanup removes only scoped .omc/state/team/<teamName> directory', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art3';
        const cwd = join(testRoot, 'workspace');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
        const teamOneDir = teamStateDir(cwd, 'team-one');
        const teamTwoDir = teamStateDir(cwd, 'team-two');
        mkdirSync(teamOneDir, { recursive: true });
        mkdirSync(teamTwoDir, { recursive: true });
        writeFileSync(join(teamOneDir, 'a.json'), '{}', 'utf-8');
        writeFileSync(join(teamTwoDir, 'b.json'), '{}', 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async (_teamName, _cwd, options) => {
            expect(options).toMatchObject({ instanceId: INSTANCE_ID, force: true, timeoutMs: 0 });
            rmSync(teamOneDir, { recursive: true, force: true });
            return { outcome: 'cleaned' };
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain(`Cleaned up team instance ${INSTANCE_ID}`);
        expect(existsSync(teamOneDir)).toBe(false);
        expect(existsSync(teamTwoDir)).toBe(true);
    });
    it('handleCleanup preserves state when runtime reports worker panes alive', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art5';
        const cwd = join(testRoot, 'workspace-live-pane');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'worker_panes_alive',
            workers: ['worker-1'],
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_worker_panes_alive:worker-1');
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_worker_panes_alive:worker-1');
    });
    it('handleCleanup preserves state when runtime cannot prove pane liveness', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art9';
        const cwd = join(testRoot, 'workspace-unknown-probe');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%9'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'worker_pane_liveness_unknown',
            workers: ['worker-1'],
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_worker_pane_liveness_unknown:worker-1');
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_worker_pane_liveness_unknown:worker-1');
    });
    it('handleCleanup preserves team state when dirty worktree cleanup is preserved', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art6';
        const cwd = join(testRoot, 'workspace-dirty-worktree');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
        writeFileSync(join(cwd, 'README.md'), 'hello\n', 'utf-8');
        execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        const worktree = createWorkerWorktree('team-one', 'worker1', cwd);
        writeFileSync(join(worktree.path, 'dirty.txt'), 'uncommitted\n', 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'worktrees_preserved',
            workers: ['worker-1'],
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_worktrees_preserved:worker-1');
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_worktrees_preserved:worker-1');
    });
    it('handleCleanup preserves state when pane evidence is missing and config still has workers', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art7';
        const cwd = join(testRoot, 'workspace-unknown-liveness');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(teamDir, 'config.json'), JSON.stringify({
            name: 'team-one',
            instance_id: INSTANCE_ID,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            tmux_session: 'team-one-session:0',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('cleanup_panes_evidence_missing');
        expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('cleanup_panes_evidence_missing');
    });
    it('handleCleanup preserves state when pane evidence is corrupt', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artcorruptpanes';
        const cwd = join(testRoot, 'workspace-corrupt-panes');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({
            instanceId: INSTANCE_ID,
            paneIds: ['%2'],
            leaderPaneId: '%1',
            workers: [{ workerName: 'worker-1', paneId: '%2' }],
        }), 'utf-8');
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('cleanup_panes_evidence_corrupt');
        expect(runtimeMocks.shutdownTeamV2).not.toHaveBeenCalled();
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('cleanup_panes_evidence_corrupt');
    });
    it('handleCleanup remains v2-bound when a same-name replacement cannot be proven', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-artreplacement';
        const cwd = join(testRoot, 'workspace-replacement');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.isRuntimeV2Enabled.mockReturnValue(false);
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'provider_cleanup_unverified',
            workers: ['replacement'],
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_provider_cleanup_unverified:replacement');
        expect(runtimeMocks.shutdownTeamV2).toHaveBeenCalledWith('team-one', cwd, {
            instanceId: INSTANCE_ID,
            force: true,
            timeoutMs: 0,
        });
        expect(runtimeMocks.shutdownTeam).not.toHaveBeenCalled();
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_provider_cleanup_unverified:replacement');
    });
    it('handleCleanup preserves state when runtime shutdown fails and leaves cleanup unmarked', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-shutdownfailed';
        const cwd = join(testRoot, 'workspace-shutdown-failed');
        const teamDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'failed',
            reason: 'state_cleanup_failed',
            detail: 'cleanup receipt unavailable',
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_state_cleanup_failed:cleanup receipt unavailable');
        expect(existsSync(teamDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_state_cleanup_failed:cleanup receipt unavailable');
    });
    it('handleCleanup preserves team state when only a worktree-root AGENTS backup remains', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art8';
        const cwd = join(testRoot, 'workspace-backup-only');
        const teamDir = teamStateDir(cwd, 'team-one');
        const backupPath = join(teamDir, 'workers', 'worker-1', 'worktree-root-agents.json');
        mkdirSync(join(teamDir, 'workers', 'worker-1'), { recursive: true });
        writeFileSync(backupPath, JSON.stringify({
            worktreePath: join(cwd, '.omc', 'team', 'team-one', 'worktrees', 'worker-1'),
            hadOriginal: true,
            originalContent: 'original',
            installedContent: 'managed',
            installedAt: new Date().toISOString(),
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'worktrees_preserved',
            workers: ['worker-1'],
        });
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_worktrees_preserved:worker-1');
        expect(existsSync(teamDir)).toBe(true);
        expect(existsSync(backupPath)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toBe('team_shutdown_worktrees_preserved:worker-1');
    });
    it('handleCleanup also removes dormant scoped team worktrees when present', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art4';
        const cwd = join(testRoot, 'workspace-worktree');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
        writeFileSync(join(cwd, 'README.md'), 'hello\n', 'utf-8');
        execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
        const teamOneDir = teamStateDir(cwd, 'team-one');
        mkdirSync(teamOneDir, { recursive: true });
        const worktree = createWorkerWorktree('team-one', 'worker1', cwd);
        expect(existsSync(worktree.path)).toBe(true);
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord('team-one', cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%2'])), 'utf-8');
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async (_teamName, _cwd, options) => {
            expect(options).toMatchObject({ instanceId: INSTANCE_ID, force: true, timeoutMs: 0 });
            rmSync(teamOneDir, { recursive: true, force: true });
            rmSync(worktree.path, { recursive: true, force: true });
            return { outcome: 'cleaned' };
        });
        await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(existsSync(worktree.path)).toBe(false);
        expect(existsSync(teamOneDir)).toBe(false);
    });
    it.skipIf(!capturedTmuxServerIdentity)('uses the real instance reservation and cleanup receipt protocol for an empty team', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const { createTeamInstanceBinding, reserveTeamInstance, activateTeamInstanceUnderLock, withTeamInstanceLifecycleLock } = await import('../../team/team-instance.js');
        const { absPath, TeamPaths } = await import('../../team/state-paths.js');
        const teamName = 'receipt-team';
        const cwd = join(testRoot, 'workspace-receipt');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
        const binding = createTeamInstanceBinding({ teamName, cwd, instanceId: INSTANCE_ID });
        const reservation = await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
        const stateDir = teamStateDir(cwd, teamName);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
            name: teamName,
            instance_id: INSTANCE_ID,
            task: 'receipt test',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            tmux_server_identity: capturedTmuxServerIdentity,
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
            state_revision: 0,
            lifecycle_state: 'active',
        }), 'utf-8');
        await withTeamInstanceLifecycleLock(cwd, teamName, () => activateTeamInstanceUnderLock(binding));
        const jobId = 'omc-artreceipt';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord(teamName, cwd)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])), 'utf-8');
        const actualShutdown = runtimeMocks.actualShutdownTeamV2;
        expect(actualShutdown).toBeDefined();
        runtimeMocks.shutdownTeamV2.mockImplementationOnce(async (team, root, options) => (await actualShutdown(String(team), String(root), options)));
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain(`Cleaned up team instance ${INSTANCE_ID}`);
        expect(existsSync(stateDir)).toBe(false);
        expect(existsSync(reservation.reservation_path)).toBe(false);
        const receiptPath = absPath(cwd, TeamPaths.teamInstanceCleanupReceipt(reservation.workspace_hash, teamName, INSTANCE_ID));
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf-8'));
        expect(receipt.instance_id).toBe(INSTANCE_ID);
        expect(receipt.phase).toBe('completed');
        const retry = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(retry.content[0].text).toContain(`Already cleaned up job ${jobId}`);
    });
    it.skipIf(!capturedTmuxServerIdentity)('preserves state when the real cleanup receipt is corrupt', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const { createTeamInstanceBinding, reserveTeamInstance, activateTeamInstanceUnderLock, withTeamInstanceLifecycleLock } = await import('../../team/team-instance.js');
        const { TeamPaths } = await import('../../team/state-paths.js');
        const teamName = 'receipt-corrupt-team';
        const cwd = join(testRoot, 'workspace-corrupt-receipt');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
        const binding = createTeamInstanceBinding({ teamName, cwd, instanceId: OTHER_INSTANCE_ID });
        await reserveTeamInstance({ teamName, cwd, instanceId: OTHER_INSTANCE_ID });
        const stateDir = teamStateDir(cwd, teamName);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
            name: teamName,
            instance_id: OTHER_INSTANCE_ID,
            task: 'corrupt receipt test',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            tmux_server_identity: capturedTmuxServerIdentity,
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
            state_revision: 0,
            lifecycle_state: 'active',
        }), 'utf-8');
        await withTeamInstanceLifecycleLock(cwd, teamName, () => activateTeamInstanceUnderLock(binding));
        const cleanupPath = canonicalTeamStatePath(cwd, TeamPaths.teamInstanceCleanupReceipt(binding.workspace_hash, teamName, OTHER_INSTANCE_ID));
        const cleanupRoot = dirname(cleanupPath);
        mkdirSync(cleanupRoot, { recursive: true });
        writeFileSync(cleanupPath, '{not-json', 'utf-8');
        const jobId = 'omc-corruptreceipt';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify(jobRecord(teamName, cwd, OTHER_INSTANCE_ID)), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(OTHER_INSTANCE_ID, [])), 'utf-8');
        const actualShutdown = runtimeMocks.actualShutdownTeamV2;
        expect(actualShutdown).toBeDefined();
        runtimeMocks.shutdownTeamV2.mockImplementation(async (team, root, options) => (await actualShutdown(String(team), String(root), options)));
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team_shutdown_state_cleanup_failed:invalid_team_instance_cleanup_receipt');
        expect(existsSync(stateDir)).toBe(true);
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.cleanedUpAt).toBeUndefined();
        expect(persisted.cleanupBlockedReason).toContain('team_shutdown_state_cleanup_failed');
        rmSync(cleanupPath, { force: true });
        const retry = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(retry.content[0].text).toContain('team_shutdown_state_cleanup_failed:cleanup_receipt_missing');
        expect(existsSync(stateDir)).toBe(true);
    });
});
//# sourceMappingURL=team-server-artifact-convergence.test.js.map