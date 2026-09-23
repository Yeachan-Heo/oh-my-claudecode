import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync as rawMkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { buildCliOutput, buildTerminalCliResult, captureTerminalCliResult, handleRecoverDeadWorkerV2Owner, fenceAllDeadRecoveryExpiry, hasPendingRecoveryAdmissionBeforeDeadline, hasPendingRecoveryIntentBeforeDeadline, updateAllDeadRecoveryGrace, getTerminalStatus, isTerseFinalSummary, processPendingRecoveryIntents, refreshRuntimeWorkerPaneIds, areAllAuthoritativeWorkersDead, classifyAllDeadRecoveryEvidence, readTaskOutputFallback, writeResultArtifact, runPersistentRecoveryOwnerLoop, finalizeRuntimeShutdown, createRuntimeStartupShutdownBarrier, runWorkerLaunchFromEnvironment, selectRuntimeCliMode, } from '../runtime-cli.js';
import { aliasActiveRecoveryRequest, canonicalRecoveryPayloadHash, readRecoveryOutcome, reserveRecoveryRequest, writeRecoveryFinal } from '../recovery-request-store.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { reserveTeamInstance } from '../team-instance.js';
let fixtureRoot;
let previousHome;
let previousUserProfile;
let previousStateDir;
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
function mkdtempSync(prefix) {
    const root = rawMkdtempSync(prefix);
    if (!fixtureRoot) {
        fixtureRoot = root;
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = root;
        process.env.USERPROFILE = root;
        delete process.env.OMC_STATE_DIR;
    }
    return root;
}
beforeEach(() => { fixtureRoot = undefined; });
afterEach(() => {
    if (previousHome === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = previousHome;
    if (previousUserProfile === undefined)
        delete process.env.USERPROFILE;
    else
        process.env.USERPROFILE = previousUserProfile;
    if (previousStateDir === undefined)
        delete process.env.OMC_STATE_DIR;
    else
        process.env.OMC_STATE_DIR = previousStateDir;
    fixtureRoot = undefined;
    previousHome = undefined;
    previousUserProfile = undefined;
    previousStateDir = undefined;
});
describe('runtime-cli v2 shutdown publication', () => {
    it('captures an instance-bound snapshot before shutdown and publishes it afterward', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-shutdown-order-'));
        try {
            const teamName = 'shutdown-order';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const stateRoot = join(cwd, '.omc', 'state', 'team', teamName);
            const tasksDir = join(stateRoot, 'tasks');
            mkdirSync(tasksDir, { recursive: true });
            writeFileSync(join(stateRoot, 'manifest.json'), JSON.stringify({
                schema_version: 2,
                name: teamName,
                instance_id: INSTANCE_ID,
            }), 'utf-8');
            writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
                id: '1',
                status: 'completed',
                result: 'pre-shutdown task result',
            }), 'utf-8');
            const phases = [];
            let published;
            const completing = finalizeRuntimeShutdown(async () => {
                phases.push('collect');
                return buildCliOutput(stateRoot, teamName, 'completed', 1, Date.now() - 1_000, INSTANCE_ID);
            }, async () => {
                phases.push('shutdown');
                rmSync(stateRoot, { recursive: true, force: true });
            }, async (output) => {
                phases.push('publish');
                published = output;
            }, { teamName, cwd, instanceId: INSTANCE_ID });
            const output = await completing;
            expect(phases).toEqual(['collect', 'shutdown', 'publish']);
            expect(existsSync(stateRoot)).toBe(false);
            expect(output.taskResults).toEqual([
                { taskId: '1', status: 'completed', summary: 'pre-shutdown task result' },
            ]);
            expect(output.instanceId).toBe(INSTANCE_ID);
            expect(published?.instanceId).toBe(INSTANCE_ID);
            expect(published?.taskResults).toEqual(output.taskResults);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('captures terminal output only under the reserved instance authority', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-terminal-snapshot-'));
        try {
            const teamName = 'terminal-snapshot';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const stateRoot = join(cwd, '.omc', 'state', 'team', teamName);
            mkdirSync(join(stateRoot, 'tasks'), { recursive: true });
            writeFileSync(join(stateRoot, 'manifest.json'), JSON.stringify({
                schema_version: 2,
                name: teamName,
                instance_id: INSTANCE_ID,
            }), 'utf-8');
            writeFileSync(join(stateRoot, 'tasks', '1.json'), JSON.stringify({
                id: '1',
                status: 'completed',
                result: 'snapshot result',
            }), 'utf-8');
            const result = await captureTerminalCliResult(cwd, stateRoot, teamName, 'complete', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(result.output.instanceId).toBe(INSTANCE_ID);
            expect(result.output.taskResults).toEqual([
                { taskId: '1', status: 'completed', summary: 'snapshot result' },
            ]);
            expect(result.exitCode).toBe(0);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('holds signal-triggered shutdown until startup ownership settles', async () => {
        const barrier = createRuntimeStartupShutdownBarrier();
        barrier.requestShutdown();
        let released = false;
        const waiting = barrier.waitForStartup().then(() => { released = true; });
        await Promise.resolve();
        expect(barrier.isShutdownRequested()).toBe(true);
        expect(released).toBe(false);
        barrier.settleStartup();
        await waiting;
        expect(released).toBe(true);
    });
    it('does not publish a terminal result when shutdown cleanup fails', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-shutdown-failure-'));
        try {
            const teamName = 'shutdown-failure';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const phases = [];
            await expect(finalizeRuntimeShutdown(async () => { phases.push('collect'); return { status: 'failed' }; }, async () => { phases.push('shutdown'); throw new Error('team_shutdown_provider_cleanup_unverified:worker-1'); }, async () => { phases.push('publish'); }, { teamName, cwd, instanceId: INSTANCE_ID })).rejects.toThrow('team_shutdown_provider_cleanup_unverified:worker-1');
            expect(phases).toEqual(['collect', 'shutdown']);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli worker launch bootstrap', () => {
    it('rejects malformed launch JSON without echoing its secret payload', async () => {
        process.env.OMC_WORKER_LAUNCH_SPEC = '{"provider_argv":["codex","--token","SUPERSECRET"],';
        try {
            await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_invalid_spec_json');
        }
        finally {
            delete process.env.OMC_WORKER_LAUNCH_SPEC;
        }
    });
    it('fails closed when inline and descriptor launch-spec sources conflict', async () => {
        process.env.OMC_WORKER_LAUNCH_SPEC = '{}';
        process.env.OMC_WORKER_LAUNCH_SPEC_FILE = join(tmpdir(), 'conflicting-worker-launch.json');
        try {
            await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_spec_source_conflict');
        }
        finally {
            delete process.env.OMC_WORKER_LAUNCH_SPEC;
            delete process.env.OMC_WORKER_LAUNCH_SPEC_FILE;
        }
    });
    it('fails closed when the attempt-owned descriptor is missing', async () => {
        process.env.OMC_WORKER_LAUNCH_SPEC_FILE = join(tmpdir(), 'missing-worker-launch.json');
        try {
            await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_descriptor_missing');
        }
        finally {
            delete process.env.OMC_WORKER_LAUNCH_SPEC_FILE;
        }
    });
    it('prioritizes explicit worker launch and recovery gate modes over inherited owner state', () => {
        const inheritedOwner = { OMC_RECOVERY_OWNER_INPUT: '{"requestId":"stale"}' };
        expect(selectRuntimeCliMode(['node', 'runtime-cli.cjs', '--worker-launch'], inheritedOwner)).toBe('worker-launch');
        expect(selectRuntimeCliMode(['node', 'runtime-cli.cjs', '--recovery-gate'], inheritedOwner)).toBe('recovery-gate');
        expect(selectRuntimeCliMode(['node', 'runtime-cli.cjs'], inheritedOwner)).toBe('recovery-owner');
    });
});
describe('runtime-cli terminal status helper', () => {
    it('returns null when there is still active work', () => {
        expect(getTerminalStatus({ pending: 1, inProgress: 0, completed: 0, failed: 0 }, 1)).toBeNull();
    });
    it('returns null when terminal counts do not match expected task count', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 1, failed: 0 }, 2)).toBeNull();
    });
    it('returns failed for terminal snapshots with any failed task', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 1, failed: 1 }, 2)).toBe('failed');
    });
    it('returns completed for terminal snapshots with zero failed tasks', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 2, failed: 0 }, 2)).toBe('completed');
    });
});
describe('runtime-cli result artifact writer', () => {
    it('writes result artifact via tmp+rename with required fields', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-'));
        const jobId = 'job-123';
        const finishedAt = '2026-03-02T12:00:00.000Z';
        try {
            await writeResultArtifact({
                status: 'completed',
                teamName: 'team-a',
                instanceId: INSTANCE_ID,
                taskResults: [{ taskId: '1', status: 'completed', summary: 'ok' }],
                duration: 1.25,
                workerCount: 2,
            }, finishedAt, jobId, jobsDir);
            const resultPath = join(jobsDir, `${jobId}-result.json`);
            const tmpPath = `${resultPath}.tmp`;
            expect(existsSync(resultPath)).toBe(true);
            expect(existsSync(tmpPath)).toBe(false);
            const payload = JSON.parse(readFileSync(resultPath, 'utf-8'));
            expect(payload.status).toBe('completed');
            expect(payload.teamName).toBe('team-a');
            expect(payload.instanceId).toBe(INSTANCE_ID);
            expect(payload.duration).toBe(1.25);
            expect(payload.workerCount).toBe(2);
            expect(payload.finishedAt).toBe(finishedAt);
            expect(Array.isArray(payload.taskResults)).toBe(true);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
    it('no-ops when job id or jobs dir is missing', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-noop-'));
        try {
            await writeResultArtifact({
                status: 'failed',
                teamName: 'team-b',
                instanceId: INSTANCE_ID,
                taskResults: [],
                duration: 0.1,
                workerCount: 1,
            }, '2026-03-02T12:00:00.000Z', undefined, jobsDir);
            expect(existsSync(join(jobsDir, 'undefined-result.json'))).toBe(false);
            expect(readdirSync(jobsDir)).toEqual([]);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
    it('no-ops when jobs dir is missing even if job id is provided', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-missing-dir-'));
        const previousJobsDir = process.env.OMC_JOBS_DIR;
        delete process.env.OMC_JOBS_DIR;
        try {
            await writeResultArtifact({
                status: 'completed',
                teamName: 'team-c',
                instanceId: INSTANCE_ID,
                taskResults: [{ taskId: '1', status: 'completed', summary: 'ok' }],
                duration: 0.2,
                workerCount: 1,
            }, '2026-03-02T12:00:00.000Z', 'job-999', undefined);
            expect(readdirSync(jobsDir)).toEqual([]);
        }
        finally {
            if (previousJobsDir === undefined)
                delete process.env.OMC_JOBS_DIR;
            else
                process.env.OMC_JOBS_DIR = previousJobsDir;
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
    it('rejects result publication without a valid instance identity', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-invalid-identity-'));
        try {
            await expect(writeResultArtifact({
                status: 'completed',
                teamName: 'team-invalid',
                instanceId: 'not-a-uuid',
                taskResults: [],
                duration: 0,
                workerCount: 0,
            }, '2026-03-02T12:00:00.000Z', 'omc-invalid', jobsDir)).rejects.toThrow('result_artifact_instance_identity_missing');
            expect(readdirSync(jobsDir)).toEqual([]);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli terminal preservation helper', () => {
    it('preserves team state for completed terminal output', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-terminal-complete-'));
        try {
            const teamName = 'runtime-cli-preserve-complete';
            const stateRoot = join(cwd, '.omc', 'state', 'team', teamName);
            const tasksDir = join(stateRoot, 'tasks');
            mkdirSync(tasksDir, { recursive: true });
            writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
                id: '1',
                status: 'completed',
                result: 'PASS: complete without shutdown',
            }), 'utf-8');
            const result = buildTerminalCliResult(stateRoot, teamName, 'complete', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(existsSync(stateRoot)).toBe(true);
            expect(result.exitCode).toBe(0);
            expect(result.output.status).toBe('completed');
            expect(result.output.teamName).toBe(teamName);
            expect(result.output.instanceId).toBe(INSTANCE_ID);
            expect(result.output.taskResults).toEqual([
                {
                    taskId: '1',
                    status: 'completed',
                    summary: 'PASS: complete without shutdown',
                },
            ]);
            expect(result.notice).toContain('preserving team state');
            expect(result.notice).toContain(`omc team shutdown ${teamName}`);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('reports cancelled terminal phases without deleting team state', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-terminal-cancelled-'));
        try {
            const teamName = 'runtime-cli-preserve-cancelled';
            const stateRoot = join(cwd, '.omc', 'state', 'team', teamName);
            const tasksDir = join(stateRoot, 'tasks');
            mkdirSync(tasksDir, { recursive: true });
            writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
                id: '1',
                status: 'blocked',
                summary: 'team stopped for inspection',
            }), 'utf-8');
            const result = buildTerminalCliResult(stateRoot, teamName, 'cancelled', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(existsSync(stateRoot)).toBe(true);
            expect(result.exitCode).toBe(1);
            expect(result.output.status).toBe('failed');
            expect(result.output.teamName).toBe(teamName);
            expect(result.output.instanceId).toBe(INSTANCE_ID);
            expect(result.output.taskResults).toEqual([
                {
                    taskId: '1',
                    status: 'blocked',
                    summary: 'team stopped for inspection',
                },
            ]);
            expect(result.notice).toContain('phase=cancelled');
            expect(result.notice).toContain(`omc team shutdown ${teamName}`);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli terse-final output fallback', () => {
    function seedTask(cwd, teamName, task) {
        const stateRoot = join(cwd, '.omc', 'state', 'team', teamName);
        const tasksDir = join(stateRoot, 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify({ status: 'completed', ...task }), 'utf-8');
        return stateRoot;
    }
    function writeOutputFile(cwd, teamName, taskId, content) {
        const outputsDir = join(cwd, '.omc', 'outputs');
        mkdirSync(outputsDir, { recursive: true });
        const suffix = Math.random().toString(36).slice(2, 8);
        writeFileSync(join(outputsDir, `team-${teamName}-task-${taskId}-${Date.now()}-${suffix}.md`), content, 'utf-8');
    }
    describe('isTerseFinalSummary', () => {
        it('treats empty / whitespace-only finals as terse', () => {
            expect(isTerseFinalSummary('')).toBe(true);
            expect(isTerseFinalSummary('   \n\t ')).toBe(true);
        });
        it('treats bare acknowledgements as terse regardless of punctuation/case', () => {
            expect(isTerseFinalSummary('Done.')).toBe(true);
            expect(isTerseFinalSummary('ready')).toBe(true);
            expect(isTerseFinalSummary('OK!')).toBe(true);
            expect(isTerseFinalSummary('Task complete.')).toBe(true);
        });
        it('preserves substantive finals', () => {
            expect(isTerseFinalSummary('PASS: complete without shutdown')).toBe(false);
            expect(isTerseFinalSummary('Done refactoring the auth module; added 3 tests.')).toBe(false);
        });
    });
    describe('readTaskOutputFallback', () => {
        it('returns null when the outputs directory is missing', () => {
            const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-none-'));
            try {
                expect(readTaskOutputFallback(join(cwd, '.omc', 'outputs'), 'team-x', '1')).toBeNull();
            }
            finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        });
        it('does not match a different task whose id is a prefix', () => {
            const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-prefix-'));
            try {
                writeOutputFile(cwd, 'team-x', '10', 'output for task ten');
                expect(readTaskOutputFallback(join(cwd, '.omc', 'outputs'), 'team-x', '1')).toBeNull();
            }
            finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        });
    });
    it('substitutes the task output file when the final is empty', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-empty-'));
        try {
            const teamName = 'fallback-empty';
            const stateRoot = seedTask(cwd, teamName, { id: '1', status: 'completed', result: '' });
            writeOutputFile(cwd, teamName, '1', 'Implemented the parser fix and added regression coverage.');
            const output = buildCliOutput(stateRoot, teamName, 'completed', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(output.taskResults).toEqual([
                {
                    taskId: '1',
                    status: 'completed',
                    summary: 'Implemented the parser fix and added regression coverage.',
                },
            ]);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('substitutes the task output file when the final is a terse ack', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-ack-'));
        try {
            const teamName = 'fallback-ack';
            const stateRoot = seedTask(cwd, teamName, { id: '2', status: 'completed', result: 'Done.' });
            writeOutputFile(cwd, teamName, '2', 'Detailed worker report with real findings.');
            const output = buildCliOutput(stateRoot, teamName, 'completed', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(output.taskResults[0]?.summary).toBe('Detailed worker report with real findings.');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('preserves a substantive final even when an output file exists', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-preserve-'));
        try {
            const teamName = 'fallback-preserve';
            const stateRoot = seedTask(cwd, teamName, {
                id: '3',
                status: 'completed',
                result: 'PASS: complete without shutdown',
            });
            writeOutputFile(cwd, teamName, '3', 'Some other longer output that must NOT override the final.');
            const output = buildCliOutput(stateRoot, teamName, 'completed', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(output.taskResults[0]?.summary).toBe('PASS: complete without shutdown');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('leaves a terse final untouched when no output file is available', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-fallback-missing-'));
        try {
            const teamName = 'fallback-missing';
            const stateRoot = seedTask(cwd, teamName, { id: '4', status: 'completed', result: 'Done.' });
            const output = buildCliOutput(stateRoot, teamName, 'completed', 1, Date.now() - 1_000, INSTANCE_ID);
            expect(output.taskResults[0]?.summary).toBe('Done.');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli recovery pane refresh', () => {
    it('includes a committed replacement pane in cleanup evidence and never treats it as dead while alive or unknown', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-pane-refresh-'));
        try {
            const teamName = 'replacement-team';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({
                name: teamName,
                instance_id: INSTANCE_ID,
                worker_count: 1,
                workers: [{ name: 'worker-1', index: 1, pane_id: '%replacement', launch_attempt_id: 'attempt-replacement' }],
                agent_type: 'claude',
                created_at: new Date().toISOString(),
                tmux_session: `${teamName}:0`,
                state_revision: 2,
            }));
            const runtime = { workerPaneIds: ['%startup'] };
            const refresh = await refreshRuntimeWorkerPaneIds(runtime, teamName, cwd, INSTANCE_ID);
            expect(refresh).toEqual({ authoritativePaneIds: ['%replacement'], allWorkerPaneIdsKnown: true });
            expect(runtime.workerPaneIds).toEqual(['%startup', '%replacement']);
            expect(areAllAuthoritativeWorkersDead(refresh, [{ liveness: 'alive' }])).toBe(false);
            expect(areAllAuthoritativeWorkersDead(refresh, [{ liveness: 'unknown' }])).toBe(false);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('rejects authoritative pane refresh from a replacement instance', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-pane-mismatch-'));
        try {
            const teamName = 'replacement-mismatch';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({
                name: teamName,
                instance_id: OTHER_INSTANCE_ID,
                worker_count: 1,
                workers: [{ name: 'worker-1', index: 1, pane_id: '%replacement', launch_attempt_id: 'attempt-replacement' }],
                agent_type: 'claude',
                created_at: new Date().toISOString(),
                tmux_session: `${teamName}:0`,
                state_revision: 2,
            }));
            await expect(refreshRuntimeWorkerPaneIds({ workerPaneIds: [] }, teamName, cwd, INSTANCE_ID)).rejects.toThrow('team_instance_identity_mismatch');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli recovery intent cleanup', () => {
    function seedFinal(cwd, requestId, recoveryId) {
        writeRecoveryFinal(cwd, {
            schema_version: 1,
            kind: 'final',
            request_id: requestId,
            recovery_id: recoveryId,
            team_name: 'intent-team',
            worker_name: 'worker-1',
            outcome: 'failed',
            result: { outcome: 'failed', committed: false, error: 'worker_not_found', requestId, recoveryId,
                teamName: 'intent-team', workerName: 'worker-1', updatedAt: new Date().toISOString() },
            error: { code: 'worker_not_found', commit_uncertain: false },
            continuation: 'none',
            adoption: 'not_started',
            services: 'terminal_degraded',
            manifest: 'repair_required',
            completed_at: new Date().toISOString(),
            expires_at: '2099-01-01T00:00:00.000Z',
        });
    }
    async function seedIntent(cwd, requestId, recoveryId) {
        const stateRoot = join(cwd, '.omc', 'state', 'team', 'intent-team');
        if (!existsSync(stateRoot)) {
            await reserveTeamInstance({ teamName: 'intent-team', cwd, instanceId: INSTANCE_ID });
        }
        const configPath = join(stateRoot, 'config.json');
        if (!existsSync(configPath)) {
            mkdirSync(stateRoot, { recursive: true });
            writeFileSync(configPath, JSON.stringify({
                name: 'intent-team',
                instance_id: INSTANCE_ID,
            }), 'utf-8');
        }
        const workspaceHash = createHash('sha256').update(cwd).digest('hex');
        const payload = {
            operation: 'recover-worker',
            workspaceHash,
            teamName: 'intent-team',
            workerName: 'worker-1',
            instanceId: INSTANCE_ID,
        };
        reserveRecoveryRequest(cwd, requestId, payload, recoveryId);
        const path = absPath(cwd, TeamPaths.recoveryIntent('intent-team', recoveryId));
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({ schema_version: 1, kind: 'recover-worker', request_id: requestId,
            recovery_id: recoveryId, operation: payload.operation, workspace_hash: workspaceHash,
            payload_hash: canonicalRecoveryPayloadHash(payload), team_name: 'intent-team', worker_name: 'worker-1',
            instance_id: INSTANCE_ID,
            created_at: new Date().toISOString() }));
        return path;
    }
    async function seedExpiredAllDeadGrace(cwd, deadline, instanceId = INSTANCE_ID) {
        await reserveTeamInstance({ teamName: 'intent-team', cwd, instanceId });
        const configPath = absPath(cwd, TeamPaths.config('intent-team'));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ name: 'intent-team', instance_id: instanceId, worker_count: 0, workers: [], agent_type: 'claude',
            created_at: new Date().toISOString(), tmux_session: 'intent-team:0', lifecycle_state: 'active', state_revision: 4,
            all_dead_recovery: { detected_at: new Date(deadline - 300_000).toISOString(), deadline_at: new Date(deadline).toISOString(), state_revision: 4 } }));
        return configPath;
    }
    function seedPredeadlineReservation(cwd, requestId, recoveryId, deadline) {
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'intent-team',
            workerName: 'worker-1', instanceId: INSTANCE_ID }, recoveryId);
        const path = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
        const repairedBytes = readFileSync(path, 'utf8').replace(/"created_at":"[^"]+"/, `"created_at":"${new Date(deadline - 1_000).toISOString()}"`);
        return { path, repairedBytes };
    }
    function seedPendingAdmission(cwd, requestId, recoveryId, teamName, instanceId, deadline) {
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId,
        }, recoveryId);
        const path = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
        const bytes = readFileSync(path, 'utf8').replace(/"created_at":"[^"]+"/, `"created_at":"${new Date(deadline - 1_000).toISOString()}"`);
        writeFileSync(path, bytes);
        return { path, bytes };
    }
    it('removes an intent only after a matching final recovery id exists', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-match-'));
        try {
            const path = await seedIntent(cwd, 'request-a', 'recovery-a');
            seedFinal(cwd, 'request-a', 'recovery-a');
            await processPendingRecoveryIntents('intent-team', cwd, undefined, INSTANCE_ID);
            expect(existsSync(path)).toBe(false);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent when the durable final belongs to another recovery id', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-mismatch-'));
        try {
            const path = await seedIntent(cwd, 'request-a', 'recovery-a');
            seedFinal(cwd, 'request-a', 'recovery-a');
            const finalPath = absPath(cwd, TeamPaths.recoveryRequestResult('request-a'));
            const mismatched = JSON.parse(readFileSync(finalPath, 'utf8'));
            mismatched.recovery_id = 'recovery-b';
            mismatched.result.recoveryId = 'recovery-b';
            writeFileSync(finalPath, JSON.stringify(mismatched));
            await processPendingRecoveryIntents('intent-team', cwd, undefined, INSTANCE_ID);
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains the intent when another recovery currently owns team mutation', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-busy-'));
        try {
            const path = await seedIntent(cwd, 'request-busy', 'recovery-busy');
            await processPendingRecoveryIntents('intent-team', cwd, async (input) => {
                expect(input.instanceId).toBe(INSTANCE_ID);
                return {
                    outcome: 'failed', committed: false, error: 'team_mutation_busy', requestId: 'request-busy',
                    recoveryId: 'recovery-busy', teamName: 'intent-team', workerName: 'worker-1', updatedAt: new Date().toISOString(),
                };
            }, INSTANCE_ID);
            expect(existsSync(path)).toBe(true);
            expect(readRecoveryOutcome(cwd, 'request-busy')).toBeNull();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent whose filename recovery id disagrees with its record', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-path-mismatch-'));
        try {
            const path = await seedIntent(cwd, 'request-path', 'recovery-path');
            const record = JSON.parse(readFileSync(path, 'utf8'));
            record.recovery_id = 'other-recovery';
            writeFileSync(path, JSON.stringify(record));
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent whose worker tuple disagrees with its canonical reservation', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-worker-mismatch-'));
        try {
            const path = await seedIntent(cwd, 'request-worker', 'recovery-worker');
            const record = JSON.parse(readFileSync(path, 'utf8'));
            record.worker_name = 'worker-2';
            writeFileSync(path, JSON.stringify(record));
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent whose request tuple disagrees with its canonical reservation', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-request-mismatch-'));
        try {
            const path = await seedIntent(cwd, 'request-canonical', 'recovery-request');
            const record = JSON.parse(readFileSync(path, 'utf8'));
            record.request_id = 'request-other';
            writeFileSync(path, JSON.stringify(record));
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each([
        ['unversioned', JSON.stringify({ request_id: 'request-bad', recovery_id: 'recovery-bad',
                team_name: 'intent-team', worker_name: 'worker-1' })],
        ['truncated', '{"schema_version":1'],
    ])('retains a %s intent without executing it', async (_kind, bytes) => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-intent-malformed-'));
        try {
            const path = absPath(cwd, TeamPaths.recoveryIntent('intent-team', 'recovery-bad'));
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, bytes);
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each(['missing reservation', 'wrong workspace', 'wrong payload hash', 'incomplete schema'])('retains a matching-final intent with %s', async (corruption) => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-recovery-final-invalid-reservation-'));
        try {
            const requestId = `request-${corruption.replaceAll(' ', '-')}`;
            const recoveryId = `recovery-${corruption.replaceAll(' ', '-')}`;
            const path = await seedIntent(cwd, requestId, recoveryId);
            seedFinal(cwd, requestId, recoveryId);
            const reservationPath = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
            if (corruption === 'missing reservation') {
                rmSync(reservationPath, { force: true });
            }
            else {
                const reservation = JSON.parse(readFileSync(reservationPath, 'utf8'));
                if (corruption === 'wrong workspace')
                    reservation.workspace_hash = 'wrong-workspace';
                else if (corruption === 'wrong payload hash')
                    reservation.payload_hash = 'wrong-payload';
                else
                    delete reservation.expires_at;
                writeFileSync(reservationPath, JSON.stringify(reservation));
            }
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each(['malformed intent', 'path mismatch', 'workspace mismatch', 'incomplete reservation'])('blocks immediate installed-owner dispatch for %s', async (corruption) => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-direct-owner-invalid-'));
        try {
            const requestId = `request-direct-${corruption.replaceAll(' ', '-')}`;
            const recoveryId = `recovery-direct-${corruption.replaceAll(' ', '-')}`;
            const path = await seedIntent(cwd, requestId, recoveryId);
            if (corruption === 'malformed intent') {
                writeFileSync(path, '{"schema_version":1');
            }
            else if (corruption === 'path mismatch') {
                const intent = JSON.parse(readFileSync(path, 'utf8'));
                intent.recovery_id = 'other-recovery';
                writeFileSync(path, JSON.stringify(intent));
            }
            else {
                const reservationPath = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
                const reservation = JSON.parse(readFileSync(reservationPath, 'utf8'));
                if (corruption === 'workspace mismatch')
                    reservation.workspace_hash = 'wrong-workspace';
                else
                    delete reservation.created_at;
                writeFileSync(reservationPath, JSON.stringify(reservation));
            }
            const execute = vi.fn();
            await expect(handleRecoverDeadWorkerV2Owner({
                teamName: 'intent-team', cwd, workerName: 'worker-1', requestId, instanceId: INSTANCE_ID,
            }, execute))
                .rejects.toThrow('invalid_persisted_state');
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent and skips execution for a tuple-matching but incomplete final', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-incomplete-final-'));
        try {
            const path = await seedIntent(cwd, 'request-incomplete-final', 'recovery-incomplete-final');
            const finalPath = absPath(cwd, TeamPaths.recoveryRequestResult('request-incomplete-final'));
            writeFileSync(finalPath, JSON.stringify({ schema_version: 1, kind: 'final', request_id: 'request-incomplete-final',
                recovery_id: 'recovery-incomplete-final', team_name: 'intent-team', worker_name: 'worker-1', outcome: 'failed',
                result: { outcome: 'failed', requestId: 'request-incomplete-final', recoveryId: 'recovery-incomplete-final',
                    teamName: 'intent-team', workerName: 'worker-1', updatedAt: new Date().toISOString() },
                error: { code: 'worker_not_found', commit_uncertain: false }, continuation: 'none', adoption: 'not_started',
                services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(),
                expires_at: '2099-01-01T00:00:00.000Z' }));
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('retains an intent when a complete final has contradictory embedded error metadata', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-cross-field-final-'));
        try {
            const path = await seedIntent(cwd, 'request-cross-field', 'recovery-cross-field');
            const finalPath = absPath(cwd, TeamPaths.recoveryRequestResult('request-cross-field'));
            writeFileSync(finalPath, JSON.stringify({ schema_version: 1, kind: 'final', request_id: 'request-cross-field',
                recovery_id: 'recovery-cross-field', team_name: 'intent-team', worker_name: 'worker-1', outcome: 'failed',
                result: { outcome: 'failed', committed: false, error: 'worker_not_found', message: 'inner',
                    requestId: 'request-cross-field', recoveryId: 'recovery-cross-field', teamName: 'intent-team',
                    workerName: 'worker-1', updatedAt: new Date().toISOString() },
                error: { code: 'worker_not_found', message: 'outer', commit_uncertain: false }, continuation: 'none',
                adoption: 'not_started', services: 'terminal_degraded', manifest: 'repair_required',
                completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' }));
            const execute = vi.fn();
            await processPendingRecoveryIntents('intent-team', cwd, execute, INSTANCE_ID);
            expect(execute).not.toHaveBeenCalled();
            expect(existsSync(path)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('persists one all-dead grace deadline across successor-style reloads and clears it on recovery', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-durable-all-dead-grace-'));
        try {
            await reserveTeamInstance({ teamName: 'intent-team', cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config('intent-team'));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: 'intent-team', instance_id: INSTANCE_ID, worker_count: 1,
                workers: [{ name: 'worker-1', index: 1 }], agent_type: 'claude', created_at: new Date().toISOString(),
                tmux_session: 'intent-team:0', state_revision: 4 }));
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'all_dead', 1_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: false });
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'all_dead', 200_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: false });
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'all_dead', 301_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: true });
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'alive', 302_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: null, expired: false });
            expect(JSON.parse(readFileSync(configPath, 'utf8')).all_dead_recovery).toBeUndefined();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('preserves all-dead grace for unknown evidence but clears it for all-alive or mixed alive/unknown evidence', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-all-dead-evidence-'));
        try {
            await reserveTeamInstance({ teamName: 'intent-team', cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config('intent-team'));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: 'intent-team', instance_id: INSTANCE_ID, worker_count: 1,
                workers: [{ name: 'worker-1', index: 1, pane_id: '%worker-1' }], agent_type: 'claude',
                created_at: new Date().toISOString(), tmux_session: 'intent-team:0', state_revision: 4 }));
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'all_dead', 1_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: false });
            expect(classifyAllDeadRecoveryEvidence({ authoritativePaneIds: ['%worker-1'], allWorkerPaneIdsKnown: true }, [{ liveness: 'unknown' }], true)).toBe('unknown');
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'unknown', 350_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: false });
            expect(classifyAllDeadRecoveryEvidence({ authoritativePaneIds: [], allWorkerPaneIdsKnown: false }, [{ liveness: 'dead' }], true)).toBe('unknown');
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'unknown', 400_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: 301_000, expired: false });
            expect(JSON.parse(readFileSync(configPath, 'utf8')).all_dead_recovery.deadline_at)
                .toBe(new Date(301_000).toISOString());
            expect(classifyAllDeadRecoveryEvidence({ authoritativePaneIds: ['%worker-1', '%worker-2'], allWorkerPaneIdsKnown: true }, [{ liveness: 'alive' }, { liveness: 'unknown' }], true)).toBe('alive');
            expect(classifyAllDeadRecoveryEvidence({ authoritativePaneIds: ['%worker-1'], allWorkerPaneIdsKnown: true }, [{ liveness: 'alive' }], true)).toBe('alive');
            await expect(updateAllDeadRecoveryGrace('intent-team', cwd, 'alive', 400_000, INSTANCE_ID))
                .resolves.toEqual({ deadlineAt: null, expired: false });
            expect(JSON.parse(readFileSync(configPath, 'utf8')).all_dead_recovery).toBeUndefined();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('suspends expired all-dead terminalization for a valid predeadline recovery intent', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-pending-intent-'));
        try {
            await seedIntent(cwd, 'request-grace', 'recovery-grace');
            const deadline = Date.now() + 60_000;
            expect(hasPendingRecoveryIntentBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
            seedFinal(cwd, 'request-grace', 'recovery-grace');
            expect(hasPendingRecoveryIntentBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('fences terminalization when a canonical reservation predates intent publication', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-reservation-'));
        try {
            const teamName = 'intent-team';
            const deadline = Date.now() - 1_000;
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: teamName, instance_id: INSTANCE_ID, worker_count: 0, workers: [], agent_type: 'claude',
                created_at: new Date().toISOString(), tmux_session: 'intent-team:0', lifecycle_state: 'active', state_revision: 4,
                all_dead_recovery: { detected_at: new Date(deadline - 300_000).toISOString(), deadline_at: new Date(deadline).toISOString(), state_revision: 4 } }));
            reserveRecoveryRequest(cwd, 'request-reserved', { operation: 'recover-worker',
                workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1',
                instanceId: INSTANCE_ID }, 'recovery-reserved');
            const reservationPath = absPath(cwd, TeamPaths.recoveryRequestPending('request-reserved'));
            const reservation = JSON.parse(readFileSync(reservationPath, 'utf8'));
            reservation.created_at = new Date(deadline - 1_000).toISOString();
            writeFileSync(reservationPath, JSON.stringify(reservation));
            expect(hasPendingRecoveryAdmissionBeforeDeadline(teamName, cwd, deadline, INSTANCE_ID)).toBe(true);
            await expect(fenceAllDeadRecoveryExpiry(teamName, cwd, deadline, INSTANCE_ID)).resolves.toBe(false);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('expires instance B while retaining a valid predeadline admission owned by instance A', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-foreign-instance-'));
        try {
            const deadline = Date.now() - 1_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline, OTHER_INSTANCE_ID);
            const { path, bytes } = seedPendingAdmission(cwd, 'request-foreign-instance', 'recovery-foreign-instance', 'intent-team', INSTANCE_ID, deadline);
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
            expect(readFileSync(path, 'utf8')).toBe(bytes);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('keeps expiry fenced by a valid predeadline admission owned by the current instance', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-matching-instance-'));
        try {
            const deadline = Date.now() - 1_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline, OTHER_INSTANCE_ID);
            const { path, bytes } = seedPendingAdmission(cwd, 'request-matching-instance', 'recovery-matching-instance', 'intent-team', OTHER_INSTANCE_ID, deadline);
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).toBe(true);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).resolves.toBe(false);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
            expect(readFileSync(path, 'utf8')).toBe(bytes);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('keeps expiry fenced by unidentifiable predeadline admission evidence', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-corrupt-admission-'));
        try {
            const deadline = Date.now() - 1_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline, OTHER_INSTANCE_ID);
            const { path } = seedPendingAdmission(cwd, 'request-corrupt-admission', 'recovery-corrupt-admission', 'intent-team', INSTANCE_ID, deadline);
            const corruptBytes = '{"schema_version":1';
            writeFileSync(path, corruptBytes, 'utf-8');
            utimesSync(path, new Date(deadline - 1_000), new Date(deadline - 1_000));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).toBe(true);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, OTHER_INSTANCE_ID)).resolves.toBe(false);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
            expect(readFileSync(path, 'utf8')).toBe(corruptBytes);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('allows all-dead cleanup when a predeadline alias resolves to its canonical final', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-terminal-alias-'));
        try {
            const deadline = Date.now() - 60_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline);
            const payload = { operation: 'recover-worker',
                workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'intent-team',
                workerName: 'worker-1', instanceId: INSTANCE_ID };
            const canonical = reserveRecoveryRequest(cwd, 'request-alias-canonical', payload, 'recovery-alias').reservation;
            const canonicalPath = absPath(cwd, TeamPaths.recoveryRequestPending('request-alias-canonical'));
            writeFileSync(canonicalPath, readFileSync(canonicalPath, 'utf8').replace(/"created_at":"[^"]+"/, `"created_at":"${new Date(deadline - 1_000).toISOString()}"`));
            aliasActiveRecoveryRequest(cwd, 'request-alias-predeadline', payload, canonical);
            const aliasPath = absPath(cwd, TeamPaths.recoveryRequestPending('request-alias-predeadline'));
            writeFileSync(aliasPath, readFileSync(aliasPath, 'utf8').replace(/"created_at":"[^"]+"/, `"created_at":"${new Date(deadline - 1_000).toISOString()}"`));
            seedFinal(cwd, 'request-alias-canonical', 'recovery-alias');
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each(['cycle', 'canonical tuple mismatch'])('keeps all-dead cleanup fenced for an alias %s', kind => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-invalid-alias-'));
        try {
            const deadline = Date.now() + 60_000;
            const slug = kind.replaceAll(' ', '-');
            const payload = { operation: 'recover-worker',
                workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'intent-team',
                workerName: 'worker-1', instanceId: INSTANCE_ID };
            const canonical = reserveRecoveryRequest(cwd, `request-alias-${slug}`, payload, `recovery-alias-${slug}`).reservation;
            aliasActiveRecoveryRequest(cwd, `request-alias-target-${slug}`, payload, canonical);
            const aliasPath = absPath(cwd, TeamPaths.recoveryRequestPending(`request-alias-target-${slug}`));
            const alias = JSON.parse(readFileSync(aliasPath, 'utf8'));
            if (kind === 'cycle')
                alias.alias_of_request_id = `request-alias-target-${slug}`;
            else
                alias.recovery_id = `recovery-other-${slug}`;
            writeFileSync(aliasPath, JSON.stringify(alias));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('keeps a predeadline malformed admission fenced after a postdeadline corruption touch', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-touched-malformed-admission-'));
        try {
            const deadline = Date.now() + 100;
            const { path } = seedPredeadlineReservation(cwd, 'request-touched-corrupt', 'recovery-touched-corrupt', deadline);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
            const reservation = JSON.parse(readFileSync(path, 'utf8'));
            reservation.payload_hash = '0'.repeat(64);
            writeFileSync(path, JSON.stringify(reservation));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each(['team_name', 'workspace_hash'])('keeps a predeadline admission fenced when a postdeadline corruption changes %s without its payload hash', field => {
        const cwd = mkdtempSync(join(tmpdir(), `runtime-cli-grace-touched-${field}-`));
        try {
            const deadline = Date.now() + 100;
            const { path } = seedPredeadlineReservation(cwd, `request-touched-${field}`, `recovery-touched-${field}`, deadline);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
            const reservation = JSON.parse(readFileSync(path, 'utf8'));
            reservation[field] = field === 'team_name' ? 'foreign-team' : '0'.repeat(64);
            writeFileSync(path, JSON.stringify(reservation));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each(['truncated', 'tuple-corrupt', 'hash-corrupt'])('keeps lifecycle active for a %s predeadline canonical admission before intent publication', async (corruption) => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-malformed-admission-'));
        try {
            const deadline = Date.now() - 60_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline);
            const { path, repairedBytes } = seedPredeadlineReservation(cwd, `request-${corruption}`, `recovery-${corruption}`, deadline);
            writeFileSync(path, corruption === 'truncated'
                ? '{"schema_version":1'
                : corruption === 'tuple-corrupt'
                    ? repairedBytes.replace('"worker_name":"worker-1"', '"worker_name":"worker-2"')
                    : repairedBytes.replace(/"payload_hash":"[a-f0-9]{64}"/, `"payload_hash":"${'0'.repeat(64)}"`));
            utimesSync(path, new Date(deadline - 1_000), new Date(deadline - 1_000));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(false);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('allows cleanup after a malformed predeadline admission is durably repaired and terminally resolved', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-repaired-admission-'));
        try {
            const deadline = Date.now() - 60_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline);
            const { path, repairedBytes } = seedPredeadlineReservation(cwd, 'request-repaired', 'recovery-repaired', deadline);
            writeFileSync(path, '{"schema_version":1');
            utimesSync(path, new Date(deadline - 1_000), new Date(deadline - 1_000));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(true);
            writeFileSync(path, repairedBytes);
            seedFinal(cwd, 'request-repaired', 'recovery-repaired');
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not let a clearly postdeadline malformed canonical admission suspend all-dead cleanup', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-new-malformed-admission-'));
        try {
            const deadline = Date.now() - 60_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline);
            const path = absPath(cwd, TeamPaths.recoveryRequestPending('request-new-malformed'));
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, '{"schema_version":1');
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('ignores noncanonical and fully self-consistent foreign predeadline admission files', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-noncanonical-admission-'));
        try {
            const deadline = Date.now() - 60_000;
            const configPath = await seedExpiredAllDeadGrace(cwd, deadline);
            const path = join(absPath(cwd, TeamPaths.recoveryRequestsRoot()), 'foreign!.pending.json');
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, '{"schema_version":1');
            utimesSync(path, new Date(deadline - 1_000), new Date(deadline - 1_000));
            reserveRecoveryRequest(cwd, 'request-foreign', { operation: 'recover-worker',
                workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'foreign-team',
                workerName: 'worker-1', instanceId: INSTANCE_ID }, 'recovery-foreign');
            const foreignPath = absPath(cwd, TeamPaths.recoveryRequestPending('request-foreign'));
            const foreignReservation = JSON.parse(readFileSync(foreignPath, 'utf8'));
            foreignReservation.created_at = new Date(deadline - 1_000).toISOString();
            writeFileSync(foreignPath, JSON.stringify(foreignReservation));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('blocks all-dead cleanup for a malformed predeadline team intent until its terminal repair is verified', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-malformed-intent-'));
        try {
            const teamName = 'intent-team';
            const deadline = Date.now() - 60_000;
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: teamName, instance_id: INSTANCE_ID, worker_count: 0, workers: [], agent_type: 'claude',
                created_at: new Date().toISOString(), tmux_session: 'intent-team:0', lifecycle_state: 'active', state_revision: 4,
                all_dead_recovery: { detected_at: new Date(deadline - 300_000).toISOString(), deadline_at: new Date(deadline).toISOString(), state_revision: 4 } }));
            const path = await seedIntent(cwd, 'request-malformed-grace', 'recovery-malformed-grace');
            const intent = JSON.parse(readFileSync(path, 'utf8'));
            intent.payload_hash = '0'.repeat(64);
            writeFileSync(path, JSON.stringify(intent));
            utimesSync(path, new Date(deadline - 1_000), new Date(deadline - 1_000));
            expect(hasPendingRecoveryIntentBeforeDeadline(teamName, cwd, deadline, INSTANCE_ID)).toBe(true);
            await expect(fenceAllDeadRecoveryExpiry(teamName, cwd, deadline, INSTANCE_ID)).resolves.toBe(false);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
            seedFinal(cwd, 'request-malformed-grace', 'recovery-malformed-grace');
            expect(hasPendingRecoveryIntentBeforeDeadline(teamName, cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry(teamName, cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not let a clearly postdeadline malformed canonical intent suspend all-dead cleanup', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-grace-new-malformed-intent-'));
        try {
            const teamName = 'intent-team';
            const deadline = Date.now() - 60_000;
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: teamName, instance_id: INSTANCE_ID, worker_count: 0, workers: [], agent_type: 'claude',
                created_at: new Date().toISOString(), tmux_session: 'intent-team:0', lifecycle_state: 'active', state_revision: 4,
                all_dead_recovery: { detected_at: new Date(deadline - 300_000).toISOString(), deadline_at: new Date(deadline).toISOString(), state_revision: 4 } }));
            const path = await seedIntent(cwd, 'request-new-malformed', 'recovery-new-malformed');
            const intent = JSON.parse(readFileSync(path, 'utf8'));
            intent.payload_hash = '0'.repeat(64);
            writeFileSync(path, JSON.stringify(intent));
            expect(hasPendingRecoveryAdmissionBeforeDeadline('intent-team', cwd, deadline, INSTANCE_ID)).toBe(false);
            await expect(fenceAllDeadRecoveryExpiry('intent-team', cwd, deadline, INSTANCE_ID)).resolves.toBe(true);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('shutting_down');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
describe('detached persistent recovery owner', () => {
    function ownerLoopConfig(teamName, overrides) {
        return {
            name: teamName, instance_id: INSTANCE_ID, task: 'recovery owner test', agent_type: 'claude', worker_launch_mode: 'interactive',
            worker_count: 0, max_workers: 20, workers: [], created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`, next_task_id: 1, lifecycle_state: 'active', ...overrides,
        };
    }
    it('enters persistent maintenance after a transient bootstrap retry clears the durable attempt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-persistent-owner-'));
        try {
            const teamName = 'persistent-team';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            const owner = { epoch: 2, nonce: 'successor', pid: process.pid,
                process_started_at: 'linux:1', created_at: new Date().toISOString() };
            writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 1, runtime_owner_epoch: owner,
                active_recovery: { request_id: 'bootstrap-intent', recovery_id: 'bootstrap-recovery', worker_name: 'worker-1',
                    owner_epoch: 2, owner_nonce: 'successor', phase: 'reserved', state_revision: 1,
                    created_at: new Date().toISOString(), updated_at: new Date().toISOString() } })));
            const handled = [];
            const services = vi.fn(async () => 'synced');
            let drainedBootstrap = false;
            let laterIntentProcessed = false;
            await runPersistentRecoveryOwnerLoop({ teamName, cwd, workerName: 'worker-1', requestId: 'bootstrap-intent', instanceId: INSTANCE_ID, bootstrap: {
                    expectedEpoch: 2, predecessorEpoch: 1, predecessorNonce: 'dead-owner', predecessorPid: 99,
                    predecessorProcessStartedAt: 'linux:99', pid: process.pid, processStartedAt: 'linux:1',
                    nonce: 'successor', recoveryId: 'bootstrap-recovery',
                } }, {
                expectedEpoch: 2,
                execute: async (input) => {
                    handled.push(input.requestId);
                    return { outcome: 'failed', committed: false, error: 'team_mutation_busy', requestId: input.requestId,
                        recoveryId: 'bootstrap-recovery', teamName, workerName: input.workerName, updatedAt: new Date().toISOString(),
                        message: 'Transient owner contention.' };
                },
                processIntents: async () => {
                    if (!drainedBootstrap) {
                        drainedBootstrap = true;
                        writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 2, runtime_owner_epoch: owner })));
                    }
                    else if (!laterIntentProcessed) {
                        laterIntentProcessed = true;
                        handled.push('later-intent');
                    }
                },
                reconcileServices: services,
                monitor: async () => null,
                verifyFence: (_input, fence, expectedEpoch) => fence.epoch === expectedEpoch && fence.nonce === 'successor',
                shouldContinue: iteration => iteration < 2,
                sleep: async () => undefined,
            });
            expect(handled).toEqual(['bootstrap-intent', 'later-intent']);
            expect(services).toHaveBeenCalledTimes(2);
            expect(drainedBootstrap).toBe(true);
            expect(laterIntentProcessed).toBe(true);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not execute bootstrap effects when the authoritative config lacks the exact PID/start binding', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-bootstrap-config-fence-'));
        try {
            const teamName = 'persistent-team';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 2,
                runtime_owner_epoch: { epoch: 1, nonce: 'owner', pid: 1, process_started_at: 'linux:1',
                    created_at: new Date().toISOString() },
                active_recovery: { request_id: 'request-1', recovery_id: 'recovery-1', worker_name: 'worker-1',
                    owner_epoch: 1, owner_nonce: 'owner', phase: 'reserved', state_revision: 2,
                    created_at: new Date().toISOString(), updated_at: new Date().toISOString() } })));
            const execute = vi.fn();
            const services = vi.fn();
            await runPersistentRecoveryOwnerLoop({ teamName, cwd, workerName: 'worker-1', requestId: 'request-1', instanceId: INSTANCE_ID, bootstrap: {
                    expectedEpoch: 1, predecessorEpoch: 0, predecessorNonce: null, predecessorPid: null,
                    predecessorProcessStartedAt: null, pid: process.pid, processStartedAt: 'linux:999', nonce: 'owner', recoveryId: 'recovery-1',
                } }, {
                expectedEpoch: 1, execute, reconcileServices: services, processIntents: vi.fn(), monitor: async () => null,
                verifyFence: () => true, shouldContinue: () => true,
            });
            expect(execute).not.toHaveBeenCalled();
            expect(services).not.toHaveBeenCalled();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it.each([
        ['intervening epoch', { epoch: 3, nonce: 'winner' }, 2, () => true],
        ['nonce fence loss', { epoch: 2, nonce: 'wrong-owner' }, 2, () => false],
    ])('does not execute or maintain when bootstrap verification fails: %s', async (_name, owner, expectedEpoch, verifyFence) => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-bootstrap-fence-'));
        try {
            const teamName = 'persistent-team';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 1,
                runtime_owner_epoch: { ...owner, pid: process.pid, process_started_at: 'linux:1',
                    created_at: new Date().toISOString() } })));
            const execute = vi.fn();
            const services = vi.fn();
            const intents = vi.fn();
            await runPersistentRecoveryOwnerLoop({
                teamName, cwd, workerName: 'worker-1', requestId: 'request-1', instanceId: INSTANCE_ID,
            }, {
                expectedEpoch,
                execute,
                reconcileServices: services,
                processIntents: intents,
                verifyFence: () => verifyFence(),
                shouldContinue: () => true,
            });
            expect(execute).not.toHaveBeenCalled();
            expect(services).not.toHaveBeenCalled();
            expect(intents).not.toHaveBeenCalled();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('completes terminal cleanup after all-dead expiry fences the detached owner into shutting_down', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'runtime-cli-persistent-owner-shutdown-'));
        try {
            const teamName = 'persistent-team';
            await reserveTeamInstance({ teamName, cwd, instanceId: INSTANCE_ID });
            const configPath = absPath(cwd, TeamPaths.config(teamName));
            mkdirSync(join(configPath, '..'), { recursive: true });
            const owner = { epoch: 2, nonce: 'successor', pid: process.pid, state_revision: 2,
                process_started_at: 'linux:1', created_at: new Date().toISOString() };
            writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 2,
                worker_count: 1, workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1' }],
                runtime_owner_epoch: owner, all_dead_recovery: { detected_at: new Date(1).toISOString(),
                    deadline_at: new Date(2).toISOString(), state_revision: 2 } })));
            const shutdown = vi.fn(async () => {
                const fenced = JSON.parse(readFileSync(configPath, 'utf8'));
                expect(fenced.lifecycle_state).toBe('shutting_down');
                writeFileSync(configPath, JSON.stringify(ownerLoopConfig(teamName, { state_revision: 4,
                    lifecycle_state: 'stopped', runtime_owner_epoch: { ...owner, state_revision: 2 } })));
            });
            const monitor = vi.fn(async () => ({ workers: [{ liveness: 'dead' }],
                tasks: { pending: 1, in_progress: 0 } }));
            await runPersistentRecoveryOwnerLoop({
                teamName, cwd, workerName: 'worker-1', requestId: 'request-1', instanceId: INSTANCE_ID,
            }, {
                expectedEpoch: 2,
                execute: vi.fn(),
                processIntents: vi.fn(),
                reconcileServices: vi.fn(async () => 'synced'),
                monitor,
                shutdown,
                verifyFence: (_input, fence) => fence.epoch === 2 && fence.nonce === 'successor',
                shouldContinue: iteration => iteration < 3,
                sleep: async () => undefined,
            });
            expect(shutdown).toHaveBeenCalledTimes(1);
            expect(shutdown).toHaveBeenCalledWith(teamName, cwd, { force: true, instanceId: INSTANCE_ID });
            expect(monitor).toHaveBeenCalledWith(teamName, cwd, INSTANCE_ID);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('stopped');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=runtime-cli.test.js.map