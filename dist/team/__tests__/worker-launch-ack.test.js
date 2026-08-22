import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec, buildWindowsSupervisorSource, cleanupWorkerLaunchTransport, isWorkerLaunchAttemptAccepted, isWorkerLaunchProviderStarted, loadWorkerLaunchAttempt, loadCurrentWorkerLaunchAttempt, prepareWorkerLaunchAttempt, materializeWorkerLaunchTransport, runWorkerLaunchBootstrap, readAndConsumeWorkerLaunchDescriptor, retireWorkerLaunchAttempt, retireAndCleanupCurrentWorkerLaunchAttempt, terminateWorkerLaunchProvider, revokeWorkerLaunchAttempt, buildProviderSpawnInvocation, materializeProviderSpawnInvocation, quoteWindowsCreateProcessArgument, } from '../worker-launch-ack.js';
import { getProcessStartIdentity, isProcessAlive, terminateOwnedProcessTree } from '../../platform/process-utils.js';
let cwd = '';
afterEach(async () => {
    if (cwd)
        await rm(cwd, { recursive: true, force: true });
    cwd = '';
});
async function attempt() {
    cwd = await mkdtemp(join(tmpdir(), 'worker-launch-ack-'));
    return prepareWorkerLaunchAttempt({
        cwd,
        teamName: 'launch-team',
        workerName: 'worker-1',
        paneId: '%2',
        provider: 'codex',
        runtimeCliPath: '/runtime-cli.cjs',
    });
}
describe('worker launch acknowledgement', () => {
    it('accepts only the exact child-written acknowledgement before running the provider', async () => {
        const launchAttempt = await attempt();
        const stopPath = join(cwd, 'provider-stop');
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)}))process.exit(0)},10)`], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 10_000,
            pollIntervalMs: 5,
        })).resolves.toBe(true);
        await writeFile(stopPath, 'stop', 'utf8');
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(true);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({
            kind: 'worker_launch_decision',
            decision: 'accepted',
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            pane_id: '%2',
        });
    });
    it.each([
        ['zero pid', 0, 'identity'],
        ['negative pid', -1, 'identity'],
        ['empty identity', process.pid, ''],
        ['stale identity', process.pid, 'stale:identity'],
    ])('rejects %s provider-start handoff evidence', async (_case, pid, processStartIdentity) => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.ackPath, JSON.stringify({
            schema_version: launchAttempt.schema_version,
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            team_name: launchAttempt.team_name,
            worker_name: launchAttempt.worker_name,
            pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider,
            created_at: launchAttempt.created_at,
            kind: 'worker_launch_ack',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 500,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            schema_version: launchAttempt.schema_version,
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            team_name: launchAttempt.team_name,
            worker_name: launchAttempt.worker_name,
            pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider,
            created_at: launchAttempt.created_at,
            kind: 'worker_launch_provider_started',
            pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 50,
            pollIntervalMs: 5,
        })).resolves.toBe(false);
    });
    it('rejects supervised provider-start evidence after its completion marker exists', async () => {
        const launchAttempt = await attempt();
        const identity = await getProcessStartIdentity(process.pid);
        const completionPath = join(cwd, 'provider-exit.txt');
        const base = {
            schema_version: launchAttempt.schema_version, attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce,
            team_name: launchAttempt.team_name, worker_name: launchAttempt.worker_name, pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider, created_at: launchAttempt.created_at,
        };
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...base, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(completionPath, '0\r\n', 'utf8');
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...base, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: identity, supervisor_completion_path: completionPath,
            written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 50, pollIntervalMs: 5 })).resolves.toBe(false);
    });
    it('rejects a provider that exits after publishing start evidence but before handoff', async () => {
        const launchAttempt = await attempt();
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 500)'], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await vi.waitFor(async () => {
            await expect(isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(true);
        }, { timeout: 2_000, interval: 5 });
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 50,
            pollIntervalMs: 5,
        })).resolves.toBe(false);
    });
    it('kills provider descendants when the provider exits around start publication', async () => {
        const launchAttempt = await attempt();
        const childPidPath = join(cwd, 'early-exit-child-pid');
        const providerScript = [
            "const fs=require('node:fs')",
            "const cp=require('node:child_process')",
            "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
            `fs.writeFileSync(${JSON.stringify(childPidPath)},String(child.pid))`,
        ].join(';');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        const result = await bootstrap;
        expect(['provider_spawn_failed', 'ran']).toContain(result.outcome);
        const childPid = Number(await readFile(childPidPath, 'utf8'));
        await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), { timeout: 2_000, interval: 20 });
        await expect(readFile(`${launchAttempt.startedPath}.terminal`, 'utf8').then(JSON.parse))
            .resolves.toMatchObject({ cleanup_verified: true });
        expect(isProcessAlive(process.pid)).toBe(true);
        await expect(readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')).resolves.toContain('worker_launch_provider_terminal');
    });
    it('revokes a timed-out attempt and treats a later acknowledgement as losing evidence', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'provider-ran');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 20,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_timeout' });
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd);
        await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_timeout' });
    });
    it('rejects a mismatched nonce and seals the attempt against later acceptance', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_ack',
            nonce: '00000000-0000-4000-8000-000000000000',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 100,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_mismatch' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
    });
    it('rejects malformed acknowledgement bytes and records a terminal revocation', async () => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.ackPath, '{not-json', 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 100,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_malformed' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_malformed' });
    });
    it('does not clean a superseded or expected-only current launch attempt', async () => {
        const accepted = await attempt();
        await writeFile(accepted.ackPath, JSON.stringify({
            schema_version: accepted.schema_version, attempt_id: accepted.attempt_id, nonce: accepted.nonce,
            team_name: accepted.team_name, worker_name: accepted.worker_name, pane_id: accepted.pane_id,
            provider: accepted.provider, created_at: accepted.created_at, kind: 'worker_launch_ack', written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(accepted, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await expect(retireWorkerLaunchAttempt(accepted, 'superseded')).resolves.toBe(true);
        const successor = await prepareWorkerLaunchAttempt({
            cwd, teamName: accepted.team_name, workerName: accepted.worker_name, paneId: '%3',
            provider: accepted.provider, runtimeCliPath: accepted.runtimeCliPath,
        });
        const cleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(accepted, 'stale_cleanup', cleanup)).resolves.toBe(false);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(successor, 'expected_only_cleanup', cleanup)).resolves.toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
    });
    it('reuses exact durable cleanup-complete evidence without touching a successor or pane again', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
        const firstCleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown', firstCleanup)).resolves.toBe(true);
        expect(firstCleanup).toHaveBeenCalledOnce();
        const retryCleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown_retry', retryCleanup)).resolves.toBe(true);
        expect(retryCleanup).not.toHaveBeenCalled();
    });
    it.runIf(process.platform !== 'win32')('publishes termination-complete on an identity-bound already-dead retry after a prior request', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_started', pid: 999_999_999, process_start_identity: '1',
            process_group_id: 999_999_999, written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.termination-request`, JSON.stringify({ ...expected,
            kind: 'worker_launch_termination_request', pid: 999_999_999,
            process_start_identity: '1', containment_nonce: launchAttempt.nonce,
            written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
        await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8').then(JSON.parse))
            .resolves.toMatchObject({ ...expected,
            kind: 'worker_launch_termination_complete', cleanup_verified: true,
            pid: 999_999_999, process_start_identity: '1' });
    });
    it('does not treat a reused provider PID as cleaned without terminal descendant proof', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const currentIdentity = await getProcessStartIdentity(process.pid);
        expect(currentIdentity).toMatch(/^\d+$/);
        const staleIdentity = String(BigInt(currentIdentity) + 1n);
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(currentIdentity).toBeTruthy();
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: currentIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 0)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
    });
    it('rejects malformed terminal and provider-start records as cleanup authority', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'not_a_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_started', pid: 0, process_start_identity: '', written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    });
    it('rejects replay when the acknowledgement path is already owned', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'], cwd);
        const first = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(first).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
        await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'ack_conflict' });
    });
    it('reports provider spawn failure after acknowledgement without hanging the bootstrap', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [join(cwd, 'definitely-missing-provider')], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: launchAttempt.team_name,
            workerName: launchAttempt.worker_name,
            provider: launchAttempt.provider,
        })).resolves.toBeNull();
    });
    it('terminates a started provider process tree when durable start publication fails', async () => {
        const launchAttempt = await attempt();
        await mkdir(launchAttempt.startedPath);
        const pidMarker = join(cwd, 'provider-tree-pids.json');
        const providerScript = [
            "const fs=require('node:fs')",
            "const cp=require('node:child_process')",
            "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
            `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
            'setInterval(()=>{},1000)',
        ].join(';');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
        const pids = JSON.parse(await readFile(pidMarker, 'utf8'));
        await vi.waitFor(() => {
            expect(isProcessAlive(pids.parent)).toBe(false);
            expect(isProcessAlive(pids.child)).toBe(false);
        }, { timeout: 2_000, interval: 20 });
    });
    it('retires and terminates the exact started provider process tree', async () => {
        const launchAttempt = await attempt();
        const pidMarker = join(cwd, 'started-provider-tree-pids.json');
        const providerScript = [
            "const fs=require('node:fs')",
            "const cp=require('node:child_process')",
            "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
            `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
            'setInterval(()=>{},1000)',
        ].join(';');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toBe(true);
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'pane_cleanup')).resolves.toBe(true);
        await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
        const pids = JSON.parse(await readFile(pidMarker, 'utf8'));
        await vi.waitFor(() => {
            expect(isProcessAlive(pids.parent)).toBe(false);
            expect(isProcessAlive(pids.child)).toBe(false);
            expect(isProcessAlive(process.pid)).toBe(true);
        }, { timeout: 2_000, interval: 20 });
    });
    it('reloads an accepted attempt only for the exact pane and provider identity', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
        await bootstrap;
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            paneId: '%2',
            provider: 'codex',
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce });
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            paneId: '%1',
            provider: 'codex',
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toBeNull();
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            provider: 'claude',
        })).resolves.toBeNull();
    });
    it('keeps revocation terminal when a valid acknowledgement is already present', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'revocation-race-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        await vi.waitFor(async () => {
            const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
            expect(acknowledgement.kind).toBe('worker_launch_ack');
        }, { timeout: 2_000, interval: 5 });
        await expect(revokeWorkerLaunchAttempt(launchAttempt, 'timeout')).resolves.toBe(true);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'decision_conflict' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
    });
    it('prevents provider spawn after durable launch retirement wins ordering', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'retired-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        await vi.waitFor(async () => {
            const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
            expect(acknowledgement.kind).toBe('worker_launch_ack');
        }, { timeout: 2_000, interval: 5 });
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'pane_cleanup')).resolves.toBe(true);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await new Promise(resolve => setTimeout(resolve, 100));
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(`${launchAttempt.decisionPath}.retired`, 'utf8')).resolves.toContain('worker_launch_retired');
    });
    it('keeps an accepted decision terminal when revocation arrives later', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'accepted-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(revokeWorkerLaunchAttempt(launchAttempt, 'late_timeout')).resolves.toBe(false);
        await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
        await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({ decision: 'accepted', reason: 'ack_valid' });
    });
    it('prevents an older acknowledged attempt from releasing a provider after supersession', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-worker-launch-recovery-generation-'));
        const olderAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'recovery', recovery_id: 'recovery-old', replacement_generation: 1, pane_attempt_id: 'pane-old' },
        });
        const providerMarker = join(cwd, 'superseded-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(olderAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        let acknowledged;
        for (let index = 0; index < 200 && !acknowledged; index++) {
            try {
                acknowledged = JSON.parse(await readFile(olderAttempt.ackPath, 'utf8'));
            }
            catch {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
        expect(acknowledged).toMatchObject({
            attempt_id: olderAttempt.attempt_id,
            nonce: olderAttempt.nonce,
            pane_id: olderAttempt.pane_id,
            kind: 'worker_launch_ack',
        });
        const newerAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: olderAttempt.team_name,
            workerName: olderAttempt.worker_name,
            paneId: '%3',
            provider: olderAttempt.provider,
            runtimeCliPath: olderAttempt.runtimeCliPath,
            context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
        });
        await expect(awaitWorkerLaunchAcknowledgement(olderAttempt, {
            timeoutMs: 2_000,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(olderAttempt)).resolves.toBe(false);
        await expect(isWorkerLaunchAttemptAccepted(newerAttempt)).resolves.toBe(false);
        const current = JSON.parse(await readFile(newerAttempt.currentPath, 'utf8'));
        expect(current).toMatchObject({
            attempt_id: newerAttempt.attempt_id,
            pane_id: '%3',
            context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
        });
    });
    it('reloads the accepted current recovery launch with its durable context', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-worker-launch-current-'));
        const launchAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            paneId: '%22',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
            context: {
                kind: 'recovery',
                recovery_id: 'recovery-current',
                replacement_generation: 2,
                pane_attempt_id: 'pane-attempt-current',
            },
        });
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
        const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
        expect(started).toMatchObject({
            kind: 'worker_launch_provider_started',
            attempt_id: launchAttempt.attempt_id,
            pane_id: '%22',
            provider: 'codex',
            process_start_identity: expect.any(String),
        });
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            provider: 'codex',
        })).resolves.toMatchObject({
            attempt_id: launchAttempt.attempt_id,
            pane_id: '%22',
            context: {
                kind: 'recovery',
                recovery_id: 'recovery-current',
                replacement_generation: 2,
                pane_attempt_id: 'pane-attempt-current',
            },
        });
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'test_cleanup')).resolves.toBe(true);
        await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
    });
    it('materializes an attempt-owned Windows transport without exposing provider secrets in pane text', async () => {
        const launchAttempt = await attempt();
        const secret = 'synthetic-token-value';
        const longValue = `long-${'x'.repeat(12_000)}`;
        const providerArgv = [
            'C:\\Program Files\\Codex\\codex.exe',
            '--token', secret,
            '--metacharacters', '100% ! ^ & | ( ) "quoted" with spaces',
            '--unicode', 'Grüße-λ-漢字',
            '--long', longValue,
        ];
        const providerEnv = {
            OMC_TEAM_WORKER: 'launch-team/worker-1',
            OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
            PROVIDER_TOKEN: secret,
            PROVIDER_URL: 'https://provider.example.test/path?x=1&y=2',
            PATH: 'C:\\Program Files\\Node;C:\\Tools',
            SYNTHETIC_METACHARS: '100% ! ^ & | ( ) "quoted" with spaces',
            SYNTHETIC_UNICODE: 'Grüße-λ-漢字',
            SYNTHETIC_CRLF: 'line-one\r\nline-two',
            SYNTHETIC_LONG: longValue,
        };
        const materialized = await materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv,
            providerEnv,
            cwd,
        });
        expect(materialized.wrapperRelativePath).toMatch(/^\.omc\\state\\team\\launch-team\\workers\\worker-1\\launch-attempts\\[0-9a-f-]+\\launch\.cmd$/);
        expect(Buffer.byteLength(materialized.wrapperRelativePath, 'utf8')).toBeLessThan(256);
        const wrapper = await readFile(materialized.wrapperPath, 'utf8');
        expect(wrapper).toContain('setlocal DisableDelayedExpansion');
        expect(wrapper).toContain('OMC_WORKER_LAUNCH_SPEC_FILE=%~dp0bootstrap.json');
        expect(wrapper).toContain('--worker-launch');
        for (const value of [secret, providerEnv.PROVIDER_URL, providerEnv.SYNTHETIC_METACHARS,
            providerEnv.SYNTHETIC_UNICODE, providerEnv.SYNTHETIC_CRLF, longValue]) {
            expect(wrapper).not.toContain(value);
        }
        expect(wrapper).not.toContain('PROVIDER_TOKEN');
        const descriptorRaw = await readFile(materialized.bootstrapDescriptorPath, 'utf8');
        expect(Buffer.byteLength(descriptorRaw, 'utf8')).toBeGreaterThan(12_000);
        const descriptor = JSON.parse(descriptorRaw);
        expect(descriptor).toMatchObject({
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
        });
        expect(descriptor.provider_argv).toEqual(providerArgv);
        expect(descriptor.provider_env).toEqual(providerEnv);
        await expect(materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            cwd,
        })).rejects.toThrow('worker_launch_transport_owner_conflict');
        const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath);
        expect(consumed).toMatchObject({ attempt_id: launchAttempt.attempt_id, provider_env: { PROVIDER_TOKEN: secret } });
        await expect(readFile(materialized.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup')).resolves.toBe(true);
        await expect(readFile(materialized.wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup_retry')).resolves.toBe(true);
        await expect(readFile(launchAttempt.transportCleanupCompletePath, 'utf8').then(JSON.parse))
            .resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, kind: 'worker_launch_transport_cleanup_complete' });
    });
    it('uses a safe relative wrapper command when worker cwd is nested below the leader state root', async () => {
        const launchAttempt = await attempt();
        const workerCwd = join(cwd, '.omc', 'team', 'launch-team', 'worktrees', 'worker-1');
        await mkdir(workerCwd, { recursive: true });
        const materialized = await materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
            cwd: workerCwd,
        });
        expect(materialized.wrapperRelativePath).toMatch(/^(?:\.\.\\)+state\\team\\launch-team\\workers\\worker-1\\launch-attempts\\[0-9a-f-]+\\launch\.cmd$/);
        expect(materialized.wrapperRelativePath).not.toMatch(/[\s"%!^&|()]/);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'nested_worktree_cleanup')).resolves.toBe(true);
    });
    it('removes only partial current-attempt transport files when exclusive materialization fails', async () => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.wrapperPath, 'foreign-wrapper', 'utf8');
        await expect(materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
            cwd,
        })).rejects.toThrow('worker_launch_transport_path_conflict');
        await expect(readFile(launchAttempt.transportOwnerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toBe('foreign-wrapper');
    });
    it('refuses transport cleanup when the durable owner belongs to another attempt identity', async () => {
        const launchAttempt = await attempt();
        await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.transportOwnerPath, JSON.stringify({
            ...expected,
            nonce: '00000000-0000-4000-8000-000000000000',
            kind: 'worker_launch_transport_owner',
        }), 'utf8');
        await expect(readAndConsumeWorkerLaunchDescriptor(launchAttempt.bootstrapDescriptorPath))
            .rejects.toThrow('worker_launch_descriptor_owner_invalid');
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'foreign_owner')).resolves.toBe(false);
        await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toContain('--worker-launch');
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
    });
    it('validates provider environment keys and propagates only explicit provider values', async () => {
        const launchAttempt = await attempt();
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { 'BAD-KEY': 'value' },
        })).toThrow('worker_launch_provider_env_key_invalid');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { VALID_KEY: undefined },
        })).toThrow('worker_launch_provider_env_value_invalid');
        const marker = join(cwd, 'provider-env.json');
        const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({value:process.env.OMC_TEST_PROVIDER_VALUE,attempt:process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,internal:process.env.OMC_WORKER_LAUNCH_SPEC_FILE}));setTimeout(()=>process.exit(0),200)`;
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, {
            providerEnv: {
                OMC_TEST_PROVIDER_VALUE: 'provider-value',
                OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
                OMC_WORKER_LAUNCH_SPEC_FILE: 'must-be-filtered',
            },
            releaseAfterSpawn: true,
        }));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(readFile(marker, 'utf8').then(JSON.parse)).resolves.toEqual({
            value: 'provider-value',
            attempt: launchAttempt.attempt_id,
        });
    });
    it('routes native Windows batch shims through a percent-safe temporary wrapper without changing POSIX argv', async () => {
        const providerArgv = [
            'C:\\Program Files\\Codex\\codex.cmd',
            '--label=100% ready',
            '--home=%USERPROFILE%',
            '--encoded=%25',
            'say "hello" & continue',
            '--literal=bang! caret^',
        ];
        const windowsInvocation = buildProviderSpawnInvocation(providerArgv, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
        expect(windowsInvocation).toEqual({
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/v:off', '/s', '/c'],
            batchScript: '@echo off\r\nstart "" /b /wait "C:\\Program Files\\Codex\\codex.cmd" "--label=100%% ready" "--home=%%USERPROFILE%%" "--encoded=%%25" "say ""hello"" & continue" "--literal=bang! caret^"\r\n',
        });
        const materialized = await materializeProviderSpawnInvocation(windowsInvocation);
        const wrapperPath = materialized.args[4].slice(1, -1);
        await expect(readFile(wrapperPath, 'utf8')).resolves.toBe(windowsInvocation.batchScript);
        await materialized.cleanup();
        await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const supervised = await materializeProviderSpawnInvocation(windowsInvocation, { superviseWindowsTree: true });
        expect(supervised.completionPath).toBeTruthy();
        await expect(readFile(supervised.args[4].slice(1, -1), 'utf8')).resolves.toContain(':omc_hold');
        await expect(readFile(supervised.args[4].slice(1, -1), 'utf8')).resolves.toContain('provider-exit.txt');
        await supervised.cleanup();
        expect(buildProviderSpawnInvocation(providerArgv, 'linux')).toEqual({
            command: providerArgv[0],
            args: providerArgv.slice(1),
        });
        expect(buildProviderSpawnInvocation(['C:\\Tools\\codex.exe', '--version'], 'win32', { ComSpec: 'cmd.exe' }))
            .toMatchObject({ command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c'], batchScript: expect.stringContaining('codex.exe') });
    });
    it('cleans up a temporary provider wrapper when wrapper write fails', async () => {
        vi.resetModules();
        const actualFs = await vi.importActual('node:fs/promises');
        const rmMock = vi.fn(actualFs.rm);
        const writeFileMock = vi.fn(async (path, ...args) => {
            if (String(path).endsWith('launch.cmd'))
                throw new Error('synthetic write failure');
            return actualFs.writeFile(path, ...args);
        });
        vi.doMock('node:fs/promises', () => ({ ...actualFs, rm: rmMock, writeFile: writeFileMock }));
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            await expect(workerLaunch.materializeProviderSpawnInvocation({
                command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c'], batchScript: '@echo off\r\n',
            })).rejects.toThrow('synthetic write failure');
            expect(rmMock).toHaveBeenCalledWith(expect.stringContaining('omc-provider-'), { recursive: true, force: true });
        }
        finally {
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it('materializes POSIX supervision without changing direct provider argv', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'worker-launch-posix-supervisor-'));
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(['/usr/bin/codex', '--prompt', 'literal & value'], 'linux'), { superviseProcessTree: true });
        expect(invocation.command).toBe('/bin/sh');
        expect(invocation.args.slice(1)).toEqual(['/usr/bin/codex', '--prompt', 'literal & value']);
        expect(invocation.completionPath).toBeTruthy();
        await expect(readFile(invocation.args[0], 'utf8')).resolves.toContain('"$@"');
        await invocation.cleanup();
    });
    it.runIf(process.platform === 'win32')('distinguishes provider starts created within the same wall-clock second', async () => {
        const first = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
        const second = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
        await Promise.all([
            new Promise((resolve, reject) => { first.once('spawn', resolve); first.once('error', reject); }),
            new Promise((resolve, reject) => { second.once('spawn', resolve); second.once('error', reject); }),
        ]);
        try {
            const [firstIdentity, secondIdentity] = await Promise.all([
                getProcessStartIdentity(first.pid), getProcessStartIdentity(second.pid),
            ]);
            expect(firstIdentity).toMatch(/^(dmtf|ticks):/);
            expect(secondIdentity).toMatch(/^(dmtf|ticks):/);
            expect(firstIdentity).not.toBe(secondIdentity);
        }
        finally {
            first.kill('SIGKILL');
            second.kill('SIGKILL');
        }
    });
    it.runIf(process.platform === 'win32').each(['cmd', 'bat'])('round-trips native .%s arguments through a real batch shim', async (extension) => {
        cwd = await mkdtemp(join(tmpdir(), `worker-launch-native-${extension}-`));
        const providerPath = join(cwd, `provider.${extension}`);
        const outputPath = join(cwd, 'argv.json');
        await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))" %*\r\n`, 'utf8');
        const payload = ['100% ready', '%USERPROFILE%', 'bang!', 'caret^', 'say "hello" & continue', 'two words'];
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath, outputPath, ...payload], 'win32', { ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe' }));
        const exitCode = await new Promise((resolve, reject) => {
            const child = spawn(invocation.command, invocation.args, { stdio: 'pipe' });
            child.once('error', reject);
            child.once('exit', code => resolve(code));
        });
        expect(exitCode).toBe(0);
        await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual(payload);
        const wrapperPath = invocation.args[4].slice(1, -1);
        await invocation.cleanup();
        await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.runIf(process.platform === 'win32')('keeps a supervisor root alive until an early-exit provider tree is terminated', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'worker-launch-native-supervisor-'));
        const providerPath = join(cwd, 'early-provider.cmd');
        const childPidPath = join(cwd, 'early-provider-child.pid');
        await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref()" "${childPidPath}"\r\n`, 'utf8');
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath], 'win32', { ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe' }), { superviseWindowsTree: true });
        const supervisor = spawn(invocation.command, invocation.args, { stdio: 'ignore', windowsHide: true });
        await expect.poll(async () => invocation.completionPath ? await readFile(invocation.completionPath, 'utf8').catch(() => '') : '').toMatch(/0/);
        const childPid = Number(await readFile(childPidPath, 'utf8'));
        expect(isProcessAlive(childPid)).toBe(true);
        const identity = await getProcessStartIdentity(supervisor.pid);
        expect(identity).toBeTruthy();
        await expect(terminateOwnedProcessTree({ pid: supervisor.pid, expectedStartIdentity: identity,
            deadlineAt: new Date(Date.now() + 5_000).toISOString(), force: true })).resolves.toBe('terminated');
        await expect.poll(() => isProcessAlive(childPid), { timeout: 2_000, interval: 20 }).toBe(false);
        await invocation.cleanup();
    });
    it('rejects CRLF-bearing native Windows batch arguments before materializing a wrapper', () => {
        expect(() => buildProviderSpawnInvocation(['C:\\Tools\\provider.cmd', '--prompt=line one\r\nwhoami'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toThrow('worker_launch_provider_argv_invalid');
    });
    it('excludes ambient secret environment values and rejects Windows aliases', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { EXPLICIT: 'yes' } });
        for (const key of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY', 'HOME', 'USERPROFILE']) {
            expect(spec.provider_env).not.toHaveProperty(key);
        }
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { OMC_WORKER_LAUNCH_SPEC_FILE: 'x' } })).toThrow('worker_launch_provider_env_reserved');
            expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { PATH: 'one', Path: 'two' } })).toThrow('worker_launch_provider_env_key_alias_conflict');
            expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { SystemRoot: 'D:\\attacker' } })).toThrow('worker_launch_provider_env_reserved');
            expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { SYSTEMROOT: 'D:\\attacker' } })).toThrow('worker_launch_provider_env_reserved');
        }
        finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });
    it('binds the Windows supervisor source, environment, Job Object, and argv protocol', () => {
        const source = buildWindowsSupervisorSource();
        const create = source.indexOf('CreateProcessW(');
        const assign = source.indexOf('AssignProcessToJobObject(');
        const resume = source.indexOf('ResumeThread(');
        expect(create).toBeGreaterThan(-1);
        expect(source).toContain('0x00000400');
        expect(source).toContain('AllocHGlobal($envBytes.Length)');
        expect(source).toContain('BasicLimitInformation.LimitFlags = 0x2000');
        expect(source).toContain('SetInformationJobObject');
        expect(assign).toBeGreaterThan(create);
        expect(resume).toBeGreaterThan(assign);
        expect(source).toContain('TerminateJobObject');
        expect(source).toContain('process_start_identity=("ticks:" +');
        expect(source).toContain('containment_nonce=$payload.containment_nonce');
        expect(source).toContain('finally {');
    });
    it('quotes exact Windows CreateProcess arguments', () => {
        expect(quoteWindowsCreateProcessArgument('')).toBe('""');
        expect(quoteWindowsCreateProcessArgument('plain')).toBe('"plain"');
        expect(quoteWindowsCreateProcessArgument('two words')).toBe('"two words"');
        expect(quoteWindowsCreateProcessArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
        expect(quoteWindowsCreateProcessArgument('say "hello"')).toBe('"say \\"hello\\""');
        expect(() => quoteWindowsCreateProcessArgument('bad\r\narg')).toThrow('worker_launch_provider_argv_invalid');
    });
    it('rejects substituted authority fields and descriptor symlinks', async () => {
        const launchAttempt = await attempt();
        const materialized = await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
        const descriptor = JSON.parse(await readFile(materialized.bootstrapDescriptorPath, 'utf8'));
        descriptor.provider_argv = ['tampered'];
        await writeFile(materialized.bootstrapDescriptorPath, JSON.stringify(descriptor), 'utf8');
        await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow('worker_launch_descriptor_invalid');
        await rm(materialized.bootstrapDescriptorPath, { force: true });
        await symlink(materialized.wrapperPath, materialized.bootstrapDescriptorPath);
        await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow();
    });
});
//# sourceMappingURL=worker-launch-ack.test.js.map