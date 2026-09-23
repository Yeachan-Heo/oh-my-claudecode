import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { canonicalizeTeamConfigWorkers } from '../../team/worker-canonicalization.js';
const projectDirs = [];
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
function paneArtifact(instanceId, paneIds, leaderPaneId = '%10', sessionName = 'leader-session:0', ownsWindow = false) {
    return {
        instanceId,
        paneIds,
        leaderPaneId,
        sessionName,
        ownsWindow,
        workers: paneIds.map((paneId, index) => ({
            workerName: `worker-${index + 1}`,
            paneId,
            launchAttemptId: `attempt-${index + 1}`,
        })),
    };
}
function makeProject(prefix) {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    projectDirs.push(cwd);
    return cwd;
}
const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    killWorkerPanes: vi.fn(),
    killTeamSession: vi.fn(),
    isWorkerAlive: vi.fn(),
    getWorkerLiveness: vi.fn(),
    resumeTeam: vi.fn(),
    monitorTeam: vi.fn(),
    shutdownTeam: vi.fn(),
    isRuntimeV2Enabled: vi.fn(() => true),
    monitorTeamV2: vi.fn(),
    shutdownTeamV2: vi.fn(),
    cleanupTeamWorktrees: vi.fn(),
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
        isWorkerAlive: mocks.isWorkerAlive,
        getWorkerLiveness: mocks.getWorkerLiveness,
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
vi.mock('../../team/git-worktree.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        cleanupTeamWorktrees: mocks.cleanupTeamWorktrees,
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
        mocks.isWorkerAlive.mockReset();
        mocks.isWorkerAlive.mockResolvedValue(false);
        mocks.getWorkerLiveness.mockReset();
        mocks.getWorkerLiveness.mockResolvedValue('dead');
        mocks.resumeTeam.mockReset();
        mocks.monitorTeam.mockReset();
        mocks.shutdownTeam.mockReset();
        mocks.shutdownTeam.mockResolvedValue(true);
        mocks.isRuntimeV2Enabled.mockReset();
        mocks.isRuntimeV2Enabled.mockReturnValue(true);
        mocks.monitorTeamV2.mockReset();
        mocks.shutdownTeamV2.mockReset();
        mocks.shutdownTeamV2.mockResolvedValue({ outcome: 'cleaned' });
        mocks.cleanupTeamWorktrees.mockReset();
        mocks.cleanupTeamWorktrees.mockReturnValue({ removed: [], preserved: [] });
    });
    afterEach(() => {
        delete process.env.OMC_JOBS_DIR;
        delete process.env.OMC_RUNTIME_CLI_PATH;
        rmSync(jobsDir, { recursive: true, force: true });
        for (const projectDir of projectDirs.splice(0))
            rmSync(projectDir, { recursive: true, force: true });
    });
    it('startTeamJob starts runtime-cli and persists running job', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        mocks.spawn.mockImplementation(() => {
            const jobFiles = readdirSync(jobsDir).filter(name => name.endsWith('.json'));
            expect(jobFiles).toHaveLength(1);
            const preChildJob = JSON.parse(readFileSync(join(jobsDir, jobFiles[0]), 'utf-8'));
            expect(preChildJob.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
            return {
                pid: 4242,
                stdin: { write, end },
                unref,
            };
        });
        const { startTeamJob } = await import('../team.js');
        const result = await startTeamJob({
            teamName: 'mvp-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-start-project-'),
        });
        expect(result.status).toBe('running');
        expect(result.jobId).toMatch(/^omc-[a-z0-9]{1,16}$/);
        expect(result.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(result.pid).toBe(4242);
        expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, ['/tmp/runtime-cli.cjs'], expect.objectContaining({
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        }));
        expect(write).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(write.mock.calls[0][0]);
        expect(payload.instanceId).toBe(result.instanceId);
        const savedJob = JSON.parse(readFileSync(join(jobsDir, `${result.jobId}.json`), 'utf-8'));
        expect(savedJob.status).toBe('running');
        expect(savedJob.pid).toBe(4242);
        expect(savedJob.instanceId).toBe(result.instanceId);
    });
    it('marks a running job failed when the detached child emits an async error', async () => {
        const childErrorHandlers = [];
        const child = {
            pid: 4243,
            on: vi.fn((event, handler) => {
                if (event === 'error')
                    childErrorHandlers.push(handler);
                return undefined;
            }),
            stdin: {
                write: vi.fn(),
                end: vi.fn(),
                on: vi.fn(),
            },
            kill: vi.fn(),
            unref: vi.fn(),
        };
        mocks.spawn.mockReturnValue(child);
        const { startTeamJob } = await import('../team.js');
        const result = await startTeamJob({
            teamName: 'child-error-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-child-error-'),
        });
        expect(childErrorHandlers).toHaveLength(1);
        childErrorHandlers[0](new Error('child exited unexpectedly'));
        const saved = JSON.parse(readFileSync(join(jobsDir, `${result.jobId}.json`), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.instanceId).toBe(result.instanceId);
        expect(saved.stderr).toBe('spawn error: child exited unexpectedly');
    });
    it.each(['replacement', 'removal'])('does not overwrite a durable job %s that changes before synchronous spawn throws', async (mode) => {
        const cwd = makeProject(`omc-team-cli-sync-spawn-${mode}-`);
        mocks.spawn.mockImplementation(() => {
            const jobPath = join(jobsDir, readdirSync(jobsDir).find(name => name.endsWith('.json')));
            if (mode === 'replacement') {
                writeFileSync(jobPath, JSON.stringify({
                    status: 'running',
                    startedAt: Date.now(),
                    teamName: 'sync-spawn-team',
                    cwd,
                    instanceId: OTHER_INSTANCE_ID,
                    stderr: 'replacement owner',
                }), 'utf-8');
            }
            else {
                rmSync(jobPath, { force: true });
            }
            throw new Error('synchronous spawn failure');
        });
        const { startTeamJob } = await import('../team.js');
        await expect(startTeamJob({
            teamName: 'sync-spawn-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd,
        })).rejects.toThrow('synchronous spawn failure');
        const files = readdirSync(jobsDir).filter(name => name.endsWith('.json'));
        if (mode === 'replacement') {
            expect(files).toHaveLength(1);
            const saved = JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf-8'));
            expect(saved.instanceId).toBe(OTHER_INSTANCE_ID);
            expect(saved.stderr).toBe('replacement owner');
            expect(saved.status).toBe('running');
        }
        else {
            expect(files).toEqual([]);
        }
    });
    it.each([
        ['foreign', { status: 'running', instanceId: OTHER_INSTANCE_ID }],
        ['terminal', { status: 'completed', instanceId: INSTANCE_ID }],
        ['cleaned', { status: 'running', instanceId: INSTANCE_ID, cleanedUpAt: '2026-01-01T00:00:00.000Z' }],
    ])('does not overwrite a %s job when its child later emits an error', async (_kind, replacement) => {
        const childErrorHandlers = [];
        const child = {
            pid: 4244,
            on: vi.fn((event, handler) => {
                if (event === 'error')
                    childErrorHandlers.push(handler);
                return undefined;
            }),
            stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
            kill: vi.fn(),
            unref: vi.fn(),
        };
        mocks.spawn.mockReturnValue(child);
        const { startTeamJob } = await import('../team.js');
        const result = await startTeamJob({
            teamName: 'child-fence-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject(`omc-team-cli-child-fence-${_kind}-`),
        });
        const jobPath = join(jobsDir, `${result.jobId}.json`);
        const initial = JSON.parse(readFileSync(jobPath, 'utf-8'));
        writeFileSync(jobPath, JSON.stringify({ ...initial, ...replacement }), 'utf-8');
        childErrorHandlers[0](new Error('late child error'));
        const saved = JSON.parse(readFileSync(jobPath, 'utf-8'));
        expect(saved.status).toBe(replacement.status);
        expect(saved.instanceId).toBe(replacement.instanceId);
        expect(saved.cleanedUpAt).toBe('cleanedUpAt' in replacement ? replacement.cleanedUpAt : undefined);
        expect(saved.stderr).toBe(initial.stderr);
    });
    it('fails closed when runtime-cli stdin is unavailable and preserves the job failure diagnostic', async () => {
        const kill = vi.fn();
        mocks.spawn.mockReturnValue({
            pid: 4245,
            on: vi.fn(),
            kill,
            unref: vi.fn(),
        });
        const { startTeamJob } = await import('../team.js');
        await expect(startTeamJob({
            teamName: 'stdin-unavailable-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-stdin-unavailable-'),
        })).rejects.toThrow('runtime_cli_stdin_unavailable');
        const files = readdirSync(jobsDir).filter(name => name.endsWith('.json'));
        expect(files).toHaveLength(1);
        const saved = JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.stderr).toBe('runtime_cli_stdin_unavailable');
        expect(kill).toHaveBeenCalledTimes(1);
    });
    it('persists a failed job when runtime-cli stdin write throws', async () => {
        const kill = vi.fn();
        const write = vi.fn(() => { throw new Error('write failed'); });
        mocks.spawn.mockReturnValue({
            pid: 4246,
            on: vi.fn(),
            stdin: { write, end: vi.fn(), on: vi.fn() },
            kill,
            unref: vi.fn(),
        });
        const { startTeamJob } = await import('../team.js');
        await expect(startTeamJob({
            teamName: 'stdin-write-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-stdin-write-'),
        })).rejects.toThrow('write failed');
        const files = readdirSync(jobsDir).filter(name => name.endsWith('.json'));
        expect(files).toHaveLength(1);
        const saved = JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.stderr).toBe('runtime_cli_stdin_error:write failed');
        expect(kill).toHaveBeenCalledTimes(1);
    });
    it('persists a failed job when runtime-cli stdin end throws', async () => {
        const kill = vi.fn();
        const end = vi.fn(() => { throw new Error('end failed'); });
        mocks.spawn.mockReturnValue({
            pid: 4247,
            on: vi.fn(),
            stdin: { write: vi.fn(), end, on: vi.fn() },
            kill,
            unref: vi.fn(),
        });
        const { startTeamJob } = await import('../team.js');
        await expect(startTeamJob({
            teamName: 'stdin-end-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-stdin-end-'),
        })).rejects.toThrow('end failed');
        const files = readdirSync(jobsDir).filter(name => name.endsWith('.json'));
        expect(files).toHaveLength(1);
        const saved = JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.stderr).toBe('runtime_cli_stdin_error:end failed');
        expect(kill).toHaveBeenCalledTimes(1);
    });
    it('persists a failed job when runtime-cli stdin emits an error asynchronously', async () => {
        const stdinErrorHandlers = [];
        const kill = vi.fn();
        mocks.spawn.mockReturnValue({
            pid: 4248,
            on: vi.fn(),
            stdin: {
                write: vi.fn(),
                end: vi.fn(),
                on: vi.fn((event, handler) => {
                    if (event === 'error')
                        stdinErrorHandlers.push(handler);
                }),
            },
            kill,
            unref: vi.fn(),
        });
        const { startTeamJob } = await import('../team.js');
        const result = await startTeamJob({
            teamName: 'stdin-error-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-stdin-error-'),
        });
        expect(stdinErrorHandlers).toHaveLength(1);
        stdinErrorHandlers[0](new Error('pipe failed'));
        const saved = JSON.parse(readFileSync(join(jobsDir, `${result.jobId}.json`), 'utf-8'));
        expect(saved.status).toBe('failed');
        expect(saved.stderr).toBe('runtime_cli_stdin_error:pipe failed');
        expect(kill).toHaveBeenCalledTimes(1);
    });
    it('startTeamJob uses the current JS runtime instead of PATH node for runtime-cli', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        mocks.spawn.mockReturnValue({
            pid: 5151,
            stdin: { write, end },
            unref,
        });
        const { startTeamJob } = await import('../team.js');
        await startTeamJob({
            teamName: 'runtime-team',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd: makeProject('omc-team-cli-runtime-project-'),
        });
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.spawn.mock.calls[0][0]).toBe(process.execPath);
        expect(mocks.spawn.mock.calls[0][0]).not.toBe('node');
    });
    it('teamCommand start --json outputs valid JSON envelope', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-start-json-');
        mocks.spawn.mockReturnValue({
            pid: 7777,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'codex', '--task', 'review auth flow', '--cwd', cwd, '--json']);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        // Verify stdin payload sent to runtime-cli
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.agentTypes).toEqual(['codex']);
        expect(stdinPayload.tasks).toHaveLength(1);
        expect(stdinPayload.tasks[0].description).toBe('review auth flow');
        expect(stdinPayload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(stdinPayload.newWindow).toBeUndefined();
        // Verify --json causes structured JSON output
        expect(logSpy).toHaveBeenCalledTimes(1);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.jobId).toMatch(/^omc-[a-z0-9]{1,16}$/);
        expect(output.instanceId).toBe(stdinPayload.instanceId);
        expect(output.status).toBe('running');
        expect(output.pid).toBe(7777);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('teamCommand start forwards --new-window to runtime-cli payload', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-new-window-');
        mocks.spawn.mockReturnValue({
            pid: 8787,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'codex', '--task', 'review auth flow', '--new-window', '--cwd', cwd, '--json']);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.newWindow).toBe(true);
        expect(stdinPayload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('teamCommand start --json with --count expands agent types', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-count-');
        mocks.spawn.mockReturnValue({
            pid: 8888,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand([
            'start', '--agent', 'gemini', '--count', '3',
            '--task', 'lint all modules', '--name', 'lint-team', '--cwd', cwd, '--json',
        ]);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.teamName).toBe('lint-team');
        expect(stdinPayload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(stdinPayload.agentTypes).toEqual(['gemini', 'gemini', 'gemini']);
        expect(stdinPayload.tasks).toHaveLength(3);
        expect(stdinPayload.tasks.every((t) => t.description === 'lint all modules')).toBe(true);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.status).toBe('running');
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('teamCommand start --agent antigravity --count expands antigravity worker types', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-agy-');
        mocks.spawn.mockReturnValue({
            pid: 9191,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand([
            'start', '--agent', 'antigravity', '--count', '2',
            '--task', 'apply the implementation', '--name', 'agy-team', '--cwd', cwd, '--json',
        ]);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.teamName).toBe('agy-team');
        expect(stdinPayload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(stdinPayload.agentTypes).toEqual(['antigravity', 'antigravity']);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('teamCommand start rejects an unsupported --agent value', async () => {
        const cwd = makeProject('omc-team-cli-bad-agent-');
        const { teamCommand } = await import('../team.js');
        await expect(teamCommand([
            'start', '--agent', 'not-a-provider',
            '--task', 'do work', '--name', 'bad-team', '--cwd', cwd, '--json',
        ])).rejects.toThrow(/Unsupported agent type/);
        rmSync(cwd, { recursive: true, force: true });
    });
    it('startTeamJob rejects runtime v1 before creating job, state, or child effects', async () => {
        const cwd = makeProject('omc-team-cli-runtime-v1-rejected-');
        mocks.isRuntimeV2Enabled.mockReturnValue(false);
        const { startTeamJob } = await import('../team.js');
        await expect(startTeamJob({
            teamName: 'v1-rejected',
            agentTypes: ['codex'],
            tasks: [{ subject: 'one', description: 'desc' }],
            cwd,
        })).rejects.toThrow('team_start_unsafe_runtime_v1');
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(readdirSync(jobsDir)).toEqual([]);
        expect(existsSync(join(cwd, '.omc'))).toBe(false);
    });
    it('legacy team alias reuses an approved short follow-up launch hint', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-approved-followup-');
        const plansDir = join(cwd, '.omc', 'plans');
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, 'prd-feature.md'), [
            '# PRD',
            '',
            '## Acceptance criteria',
            '- done',
            '',
            '## Requirement coverage map',
            '- req -> impl',
            '',
            'omc team 4:codex "execute approved plan"',
            '',
        ].join('\n'));
        writeFileSync(join(plansDir, 'test-spec-feature.md'), [
            '# Test Spec',
            '',
            '## Unit coverage',
            '- unit',
            '',
            '## Verification mapping',
            '- verify',
            '',
        ].join('\n'));
        mocks.spawn.mockReturnValue({
            pid: 8889,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['3:claude', 'team', '--cwd', cwd, '--json']);
        const stdinPayload = JSON.parse(write.mock.calls[0][0]);
        expect(stdinPayload.workerCount).toBe(4);
        expect(stdinPayload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(stdinPayload.agentTypes).toEqual(['codex', 'codex', 'codex', 'codex']);
        expect(stdinPayload.tasks).toHaveLength(4);
        expect(stdinPayload.tasks.every((task) => task.description === 'execute approved plan')).toBe(true);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('legacy team alias fails closed for incomplete approved short follow-up hints', async () => {
        const cwd = makeProject('omc-team-cli-approved-incomplete-');
        const plansDir = join(cwd, '.omc', 'plans');
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, 'prd-feature.md'), [
            '# PRD',
            '',
            '## Acceptance criteria',
            '- done',
            '',
            '## Requirement coverage map',
            '- req -> impl',
            '',
            'omc team 4:codex "execute draft plan"',
            '',
        ].join('\n'));
        const { teamCommand } = await import('../team.js');
        await expect(teamCommand(['3:claude', 'team', '--cwd', cwd, '--json']))
            .rejects.toThrow('approved_execution_hint_incomplete:team');
        expect(mocks.spawn).not.toHaveBeenCalled();
        rmSync(cwd, { recursive: true, force: true });
    });
    it('legacy team alias fails closed for ambiguous approved short follow-up hints', async () => {
        const cwd = makeProject('omc-team-cli-approved-ambiguous-');
        const plansDir = join(cwd, '.omc', 'plans');
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, 'prd-feature.md'), [
            '# PRD',
            '',
            '## Acceptance criteria',
            '- done',
            '',
            '## Requirement coverage map',
            '- req -> impl',
            '',
            'omc team 2:claude "execute alpha"',
            'omc team 4:codex "execute beta"',
            '',
        ].join('\n'));
        writeFileSync(join(plansDir, 'test-spec-feature.md'), [
            '# Test Spec',
            '',
            '## Unit coverage',
            '- unit',
            '',
            '## Verification mapping',
            '- verify',
            '',
        ].join('\n'));
        const { teamCommand } = await import('../team.js');
        await expect(teamCommand(['3:claude', 'team', '--cwd', cwd, '--json']))
            .rejects.toThrow('approved_execution_hint_ambiguous:team');
        expect(mocks.spawn).not.toHaveBeenCalled();
        rmSync(cwd, { recursive: true, force: true });
    });
    it('teamCommand start without --json outputs non-JSON', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-start-plain-');
        mocks.spawn.mockReturnValue({
            pid: 9999,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['start', '--agent', 'claude', '--task', 'do stuff', '--cwd', cwd]);
        expect(logSpy).toHaveBeenCalledTimes(1);
        // Without --json, output is a raw object (not JSON-stringified)
        const rawOutput = logSpy.mock.calls[0][0];
        expect(typeof rawOutput).toBe('object');
        expect(rawOutput.status).toBe('running');
        expect(rawOutput.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        rmSync(cwd, { recursive: true, force: true });
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
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            instanceId: INSTANCE_ID,
            teamName: 'demo',
            taskResults: [],
        }));
        const status = await getTeamJobStatus(jobId);
        expect(status.status).toBe('completed');
        expect(status.result).toEqual(expect.objectContaining({ status: 'completed', instanceId: INSTANCE_ID }));
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
    });
    it('repairs a failed durable job when a later matching completed artifact arrives', async () => {
        const { getTeamJobStatus } = await import('../team.js');
        const jobId = 'omc-latecompleted';
        const resultArtifact = JSON.stringify({
            status: 'completed',
            teamName: 'demo',
            instanceId: INSTANCE_ID,
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'failed',
            startedAt: Date.now(),
            teamName: 'demo',
            cwd: '/tmp/demo',
            instanceId: INSTANCE_ID,
            stderr: 'transient close failure',
            result: JSON.stringify({ error: 'terminal_result_evidence_missing' }),
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), resultArtifact, 'utf-8');
        const status = await getTeamJobStatus(jobId);
        expect(status.status).toBe('completed');
        expect(status.instanceId).toBe(INSTANCE_ID);
        expect(status.result).toEqual(JSON.parse(resultArtifact));
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
        expect(persisted.result).toBe(resultArtifact);
        expect(persisted.stderr).toBe('transient close failure');
    });
    it('getTeamJobStatus rejects a terminal result artifact from a stale instance', async () => {
        const { getTeamJobStatus } = await import('../team.js');
        const jobId = 'omc-staleresult';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo',
            cwd: '/tmp/demo',
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            teamName: 'demo',
            instanceId: OTHER_INSTANCE_ID,
            taskResults: [],
        }));
        const status = await getTeamJobStatus(jobId);
        expect(status.status).toBe('failed');
        expect(status.stderr).toContain('Corrupt result artifact');
        expect(status.result).toEqual({ error: 'result_artifact_identity_mismatch' });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.instanceId).toBe(INSTANCE_ID);
        expect(persisted.status).toBe('failed');
    });
    it('getTeamJobStatus fails closed for missing and corrupt job authority', async () => {
        const { getTeamJobStatus } = await import('../team.js');
        await expect(getTeamJobStatus('omc-missingjob')).rejects.toThrow('No job found');
        writeFileSync(join(jobsDir, 'omc-corruptjob.json'), '{not-json', 'utf-8');
        await expect(getTeamJobStatus('omc-corruptjob')).rejects.toThrow('Corrupt job file');
    });
    it('waitForTeamJob times out with running status', async () => {
        const { waitForTeamJob } = await import('../team.js');
        const jobId = 'omc-timeout1';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo',
            cwd: '/tmp/demo',
            instanceId: INSTANCE_ID,
        }));
        const result = await waitForTeamJob(jobId, { timeoutMs: 10 });
        expect(result.status).toBe('running');
        expect(result.instanceId).toBe(INSTANCE_ID);
        expect(result.timedOut).toBe(true);
        expect(result.error).toContain('Timed out waiting for job');
    });
    it('cleanupTeamJob delegates the original instance to runtime-v2 and marks cleaned only after success', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanup1';
        const cwd = makeProject('omc-team-cli-cleanup-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%11', '%12'])));
        // Cleanup remains v2-bound even when the compatibility flag is disabled.
        mocks.isRuntimeV2Enabled.mockReturnValue(false);
        mocks.shutdownTeamV2.mockImplementation(async (_teamName, _cwd, options) => {
            expect(options).toEqual({ instanceId: INSTANCE_ID, force: true, timeoutMs: 1234 });
            rmSync(stateRoot, { recursive: true, force: true });
            return { outcome: 'cleaned' };
        });
        const result = await cleanupTeamJob(jobId, 1234);
        expect(result.message).toContain(`Cleaned up team instance ${INSTANCE_ID}`);
        expect(mocks.shutdownTeamV2).toHaveBeenCalledWith('demo-team', cwd, {
            instanceId: INSTANCE_ID,
            force: true,
            timeoutMs: 1234,
        });
        expect(existsSync(stateRoot)).toBe(false);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toEqual(expect.any(String));
        expect(saved.cleanupBlockedReason).toBeUndefined();
    });
    it('merges current result fields after deferred cleanup succeeds', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanupdeferred';
        const cwd = makeProject('omc-team-cli-deferred-status-');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        mocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = cleanupTeamJob(jobId, 0);
        const cleanupSettled = cleanupPromise.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
        const entered = await Promise.race([
            called.then(() => 'entered'),
            cleanupSettled.then(() => 'settled'),
        ]);
        expect(entered).toBe('entered');
        const result = JSON.stringify({
            status: 'completed',
            instanceId: INSTANCE_ID,
            teamName: 'demo-team',
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'completed',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
            result,
            stderr: 'terminal result published while cleanup waited',
            pid: 9876,
        }), 'utf-8');
        release({ outcome: 'cleaned' });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.status).toBe('completed');
        expect(saved.result).toBe(result);
        expect(saved.stderr).toBe('terminal result published while cleanup waited');
        expect(saved.pid).toBe(9876);
        expect(saved.cleanedUpAt).toEqual(expect.any(String));
    });
    it('does not regress a newer cleanup blocked reason during deferred failure publication', async () => {
        const { cleanupTeamJob, getTeamJobStatus } = await import('../team.js');
        const jobId = 'omc-cleanupreason';
        const cwd = makeProject('omc-team-cli-deferred-reason-');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
            cleanupBlockedAt: '2026-01-01T00:00:00.000Z',
            cleanupBlockedReason: 'R1',
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        mocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = cleanupTeamJob(jobId, 0);
        const cleanupSettled = cleanupPromise.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
        const entered = await Promise.race([
            called.then(() => 'entered'),
            cleanupSettled.then(() => 'settled'),
        ]);
        expect(entered).toBe('entered');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
            cleanupBlockedAt: '2026-02-02T00:00:00.000Z',
            cleanupBlockedReason: 'R2',
        }), 'utf-8');
        expect((await getTeamJobStatus(jobId)).status).toBe('running');
        release({ outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['worker-1'] });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanupBlockedReason).toBe('R2');
        expect(saved.cleanedUpAt).toBeUndefined();
    });
    it('does not erase a cleanup marker written by another deferred cleanup', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanupcleaned';
        const cwd = makeProject('omc-team-cli-deferred-cleaned-');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        let release;
        let resolveCalled;
        const called = new Promise(resolve => { resolveCalled = resolve; });
        mocks.shutdownTeamV2.mockImplementationOnce(async () => {
            resolveCalled();
            return new Promise(resolve => { release = resolve; });
        });
        const cleanupPromise = cleanupTeamJob(jobId, 0);
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
            teamName: 'demo-team',
            taskResults: [],
        });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'failed',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
            result,
            stderr: 'another cleanup completed',
            cleanedUpAt: cleanupAt,
        }), 'utf-8');
        release({ outcome: 'cleaned' });
        const settled = await cleanupSettled;
        expect(settled.kind).toBe('resolved');
        if (settled.kind === 'rejected')
            throw settled.error;
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toBe(cleanupAt);
        expect(saved.result).toBe(result);
        expect(saved.stderr).toBe('another cleanup completed');
    });
    it('cleanupTeamJob does not touch a replacement after the original job is already cleaned', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanupretry';
        const cwd = makeProject('omc-team-cli-cleanup-retry-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'completed',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
            cleanedUpAt: new Date().toISOString(),
        }));
        const result = await cleanupTeamJob(jobId);
        expect(result.message).toContain(`Already cleaned up job ${jobId}`);
        expect(existsSync(stateRoot)).toBe(true);
        expect(mocks.shutdownTeamV2).not.toHaveBeenCalled();
        expect(mocks.shutdownTeam).not.toHaveBeenCalled();
    });
    it('cleanupTeamJob remains v2-bound when the runtime reports a same-name replacement', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanupstale';
        const cwd = makeProject('omc-team-cli-stale-instance-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, ['%11'])));
        mocks.isRuntimeV2Enabled.mockReturnValue(false);
        mocks.shutdownTeamV2.mockResolvedValueOnce({
            outcome: 'preserved',
            reason: 'provider_cleanup_unverified',
            workers: ['replacement'],
        });
        const result = await cleanupTeamJob(jobId);
        expect(result.message).toContain('provider_cleanup_unverified:replacement');
        expect(mocks.shutdownTeamV2).toHaveBeenCalledWith('demo-team', cwd, {
            instanceId: INSTANCE_ID,
            force: true,
            timeoutMs: 10_000,
        });
        expect(mocks.shutdownTeam).not.toHaveBeenCalled();
        expect(existsSync(stateRoot)).toBe(true);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toBeUndefined();
        expect(saved.cleanupBlockedReason).toBe('provider_cleanup_unverified:replacement');
    });
    it('cleanupTeamJob preserves state when pane evidence is missing or corrupt', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        for (const [suffix, panes] of [['missing', undefined], ['corrupt', '{not-json']]) {
            const jobId = `omc-cleanup${suffix}`;
            const cwd = makeProject(`omc-team-cli-${suffix}-evidence-`);
            const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
            mkdirSync(stateRoot, { recursive: true });
            writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
                status: 'running',
                startedAt: Date.now(),
                teamName: 'demo-team',
                cwd,
                instanceId: INSTANCE_ID,
            }));
            if (panes !== undefined)
                writeFileSync(join(jobsDir, `${jobId}-panes.json`), panes);
            const result = await cleanupTeamJob(jobId);
            expect(result.message).toContain(panes === undefined ? 'cleanup_panes_evidence_missing' : 'cleanup_panes_evidence_corrupt');
            expect(mocks.shutdownTeamV2).not.toHaveBeenCalled();
            expect(existsSync(stateRoot)).toBe(true);
            const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
            expect(saved.cleanedUpAt).toBeUndefined();
            expect(saved.cleanupBlockedReason).toBe(panes === undefined ? 'cleanup_panes_evidence_missing' : 'cleanup_panes_evidence_corrupt');
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('cleanupTeamJob preserves state for a stale result artifact identity', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-staleresult2';
        const cwd = makeProject('omc-team-cli-stale-result-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
            status: 'completed',
            instanceId: OTHER_INSTANCE_ID,
            teamName: 'demo-team',
            taskResults: [],
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        const result = await cleanupTeamJob(jobId);
        expect(result.message).toContain('cleanup_result_evidence_corrupt');
        expect(mocks.shutdownTeamV2).not.toHaveBeenCalled();
        expect(existsSync(stateRoot)).toBe(true);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toBeUndefined();
        expect(saved.cleanupBlockedReason).toBe('cleanup_result_evidence_corrupt');
    });
    it('cleanupTeamJob preserves state when result evidence is corrupt', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-corruptresult';
        const cwd = makeProject('omc-team-cli-corrupt-result-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-result.json`), '{not-json', 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        const result = await cleanupTeamJob(jobId);
        expect(result.message).toContain('cleanup_result_evidence_corrupt');
        expect(mocks.shutdownTeamV2).not.toHaveBeenCalled();
        expect(existsSync(stateRoot)).toBe(true);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toBeUndefined();
        expect(saved.cleanupBlockedReason).toBe('cleanup_result_evidence_corrupt');
    });
    it('cleanupTeamJob propagates failed runtime cleanup without marking the job cleaned', async () => {
        const { cleanupTeamJob } = await import('../team.js');
        const jobId = 'omc-cleanupfailed';
        const cwd = makeProject('omc-team-cli-failed-cleanup-');
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now(),
            teamName: 'demo-team',
            cwd,
            instanceId: INSTANCE_ID,
        }));
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify(paneArtifact(INSTANCE_ID, [])));
        mocks.isRuntimeV2Enabled.mockReturnValue(true);
        mocks.shutdownTeamV2.mockResolvedValue({
            outcome: 'failed',
            reason: 'state_cleanup_failed',
            detail: 'receipt publication failed',
        });
        const result = await cleanupTeamJob(jobId);
        expect(result.message).toContain('state_cleanup_failed:receipt publication failed');
        expect(existsSync(stateRoot)).toBe(true);
        const saved = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(saved.cleanedUpAt).toBeUndefined();
        expect(saved.cleanupBlockedReason).toBe('state_cleanup_failed:receipt publication failed');
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
        const cwd = makeProject('omc-team-cli-v2-status-');
        const root = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'demo-team',
            instance_id: INSTANCE_ID,
            task: 'demo',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'demo-session:0',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', launch_attempt_id: 'attempt-1' }],
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
    it('team status deduplicates workerPaneIds from duplicate worker config rows', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.isRuntimeV2Enabled.mockReturnValue(true);
        mocks.monitorTeamV2.mockResolvedValue({
            teamName: 'demo-team',
            phase: 'team-exec',
            workers: [],
            tasks: { total: 1, pending: 0, blocked: 0, in_progress: 1, completed: 0, failed: 0, items: [] },
            deadWorkers: [],
            nonReportingWorkers: [],
            recommendations: [],
            allTasksTerminal: false,
            performance: { total_ms: 1, list_tasks_ms: 1, worker_scan_ms: 0, mailbox_delivery_ms: 0, updated_at: new Date().toISOString() },
        });
        const cwd = makeProject('omc-team-cli-v2-status-dedup-');
        const root = join(cwd, '.omc', 'state', 'team', 'demo-team');
        mkdirSync(root, { recursive: true });
        const duplicateWorkerConfig = canonicalizeTeamConfigWorkers({
            name: 'demo-team',
            instance_id: INSTANCE_ID,
            task: 'demo',
            agent_type: 'executor',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            tmux_session: 'demo-session:0',
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', launch_attempt_id: 'attempt-1' },
                { name: 'worker-1', index: 2, role: 'executor', assigned_tasks: [] },
            ],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        writeFileSync(join(root, 'config.json'), JSON.stringify(duplicateWorkerConfig));
        await teamCommand(['status', 'demo-team', '--json', '--cwd', cwd]);
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.workerPaneIds).toEqual(['%1']);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team status supports team-name target via runtime snapshot', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        // Name-target status remains a legacy read surface; startup/cleanup are v2-only.
        mocks.isRuntimeV2Enabled.mockReturnValue(false);
        mocks.resumeTeam.mockResolvedValue({
            teamName: 'demo-team',
            sessionName: 'omc-team-demo:0',
            leaderPaneId: '%0',
            config: { teamName: 'demo-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo', instance_id: INSTANCE_ID },
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
            config: { teamName: 'alpha-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo', instance_id: INSTANCE_ID },
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
        mocks.shutdownTeamV2.mockResolvedValue({ outcome: 'cleaned' });
        const cwd = makeProject('omc-team-cli-v2-shutdown-');
        const root = join(cwd, '.omc', 'state', 'team', 'beta-team');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'beta-team',
            instance_id: INSTANCE_ID,
            task: 'beta',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'beta-session:0',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', launch_attempt_id: 'attempt-1' }],
            created_at: new Date().toISOString(),
            next_task_id: 2,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
        await teamCommand(['shutdown', 'beta-team', '--force', '--json', '--cwd', cwd]);
        expect(mocks.shutdownTeamV2).toHaveBeenCalledWith('beta-team', cwd, {
            instanceId: INSTANCE_ID,
            force: true,
            timeoutMs: 0,
        });
        expect(mocks.resumeTeam).not.toHaveBeenCalled();
        expect(mocks.shutdownTeam).not.toHaveBeenCalled();
        const payload = JSON.parse(logSpy.mock.calls[0][0]);
        expect(payload.shutdown).toBe(true);
        expect(payload.forced).toBe(true);
        expect(payload.sessionFound).toBe(true);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('legacy shorthand start alias supports optional ralph token', async () => {
        const write = vi.fn();
        const end = vi.fn();
        const unref = vi.fn();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-legacy-');
        mocks.spawn.mockReturnValue({
            pid: 5151,
            stdin: { write, end },
            unref,
        });
        const { teamCommand } = await import('../team.js');
        await teamCommand(['ralph', '2:codex', 'ship', 'feature', '--cwd', cwd, '--json']);
        expect(write).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(write.mock.calls[0][0]);
        expect(payload.agentTypes).toEqual(['codex', 'codex']);
        expect(payload.instanceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(payload.tasks[0].subject).toContain('Ralph');
        expect(payload.tasks[0].description).toBe('ship feature');
        const out = JSON.parse(logSpy.mock.calls[0][0]);
        expect(out.status).toBe('running');
        expect(out.pid).toBe(5151);
        expect(out.instanceId).toBe(payload.instanceId);
        rmSync(cwd, { recursive: true, force: true });
        logSpy.mockRestore();
    });
    it('team api legacy facade delegates send-message to canonical mailbox state', async () => {
        const { teamCommand } = await import('../team.js');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const cwd = makeProject('omc-team-cli-send-');
        const root = join(cwd, '.omc', 'state', 'team', 'api-team');
        mkdirSync(join(root, 'tasks'), { recursive: true });
        mkdirSync(join(root, 'mailbox'), { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'api-team',
            instance_id: INSTANCE_ID,
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
        const cwd = makeProject('omc-team-cli-notified-');
        const root = join(cwd, '.omc', 'state', 'team', 'api-team');
        mkdirSync(join(root, 'mailbox'), { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: 'api-team',
            instance_id: INSTANCE_ID,
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
        const cwd = makeProject('omc-team-cli-api-');
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
            instance_id: INSTANCE_ID,
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
        expect(configPayload.data.config.instance_id).toBe(INSTANCE_ID);
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