import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildProviderSpawnInvocation, materializeProviderSpawnInvocation, withWorkerLaunchAttemptFence } from './worker-launch-ack.js';
import { getProcessStartIdentity, getProcessStartIdentitySync, isProcessAlive, terminateOwnedProcessTree } from '../platform/process-utils.js';
async function writeAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    await rename(temporary, path);
}
export async function waitForRecoveryGateRecord(path, expected, timeoutMs, pollIntervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const value = JSON.parse(await readFile(path, 'utf8'));
            if (value.recovery_id === expected.recovery_id && value.worker_name === expected.worker_name
                && value.replacement_generation === expected.replacement_generation && value.pane_attempt_id === expected.pane_attempt_id
                && value.launch_attempt_id === expected.launch_attempt_id && value.launch_nonce === expected.launch_nonce)
                return true;
        }
        catch { /* absent or incomplete publication; keep waiting */ }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return false;
}
/**
 * Provider-independent activation barrier. The provider process is not created
 * until the runtime owner has first published activate and then run for this
 * exact pane attempt. Credentials are deliberately not written by this runner.
 */
export async function runWorkerActivationGate(gate) {
    if (gate.providerArgv.length === 0 || !gate.providerArgv[0])
        return { outcome: 'invalid_provider_argv' };
    const launchContext = gate.launchAttempt?.context;
    if (!gate.launchAttempt || launchContext?.kind !== 'recovery'
        || gate.launchAttempt.worker_name !== gate.workerName
        || launchContext.recovery_id !== gate.recoveryId
        || launchContext.replacement_generation !== gate.replacementGeneration
        || launchContext.pane_attempt_id !== gate.paneAttemptId)
        return { outcome: 'superseded' };
    const expected = {
        recovery_id: gate.recoveryId,
        worker_name: gate.workerName,
        replacement_generation: gate.replacementGeneration,
        pane_attempt_id: gate.paneAttemptId,
        launch_attempt_id: gate.launchAttempt.attempt_id,
        launch_nonce: gate.launchAttempt.nonce,
        written_at: new Date().toISOString(),
    };
    const timeoutMs = gate.timeoutMs ?? 30_000;
    const pollIntervalMs = gate.pollIntervalMs ?? 100;
    await writeAtomic(gate.readyPath, expected);
    if (!await waitForRecoveryGateRecord(gate.activatePath, expected, timeoutMs, pollIntervalMs))
        return { outcome: 'activation_timeout' };
    // This marker proves the pane is gated and can be safely adopted by the owner.
    await writeAtomic(`${gate.readyPath}.adoption-ready`, { ...expected, written_at: new Date().toISOString() });
    if (!await waitForRecoveryGateRecord(gate.runPath, expected, timeoutMs, pollIntervalMs))
        return { outcome: 'run_timeout' };
    const fenced = await withWorkerLaunchAttemptFence(gate.launchAttempt, async () => {
        const { OMC_RECOVERY_GATE_SPEC: _recoveryGateSpec, OMC_RECOVERY_GATE_SPEC_B64: _encodedRecoveryGateSpec, ...providerProcessEnv } = process.env;
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(gate.providerArgv), {
            superviseProcessTree: true,
        });
        const child = spawn(invocation.command, invocation.args, {
            cwd: gate.cwd,
            env: { ...providerProcessEnv, ...gate.env },
            stdio: 'inherit',
            detached: process.platform !== 'win32',
        });
        let settled = false;
        let providerPid;
        let providerStartIdentity = null;
        let supervisedExitCode = null;
        let supervisorTimer;
        let terminationResult = null;
        let finishCompletion;
        const completion = new Promise(resolve => {
            const finish = async (result, terminal) => {
                if (settled)
                    return;
                settled = true;
                if (supervisorTimer)
                    clearInterval(supervisorTimer);
                try {
                    await writeAtomic(`${gate.runPath}.terminal`, { ...expected, provider_pid: child.pid ?? null, ...terminal,
                        written_at: new Date().toISOString() });
                }
                catch { /* owner may have already cleaned terminal attempt state */ }
                await invocation.cleanup().catch(() => undefined);
                resolve(result);
            };
            finishCompletion = finish;
            child.once('exit', async (exitCode, signal) => {
                const effectiveExitCode = supervisedExitCode ?? exitCode;
                const effectiveSignal = supervisedExitCode === null ? signal : null;
                const cleanupVerified = terminationResult ? await terminationResult === 'terminated' : false;
                await finish(cleanupVerified
                    ? { outcome: 'ran', exitCode: effectiveExitCode, signal: effectiveSignal }
                    : { outcome: 'provider_cleanup_unverified' }, { outcome: cleanupVerified ? 'exit' : 'cleanup_unverified', cleanup_verified: cleanupVerified,
                    exit_code: effectiveExitCode, signal: effectiveSignal });
            });
            child.once('error', () => {
                void finish({ outcome: 'provider_spawn_failed' }, { outcome: 'error', cleanup_verified: false });
            });
        });
        const terminateProvider = async () => {
            if (settled || !providerPid || !providerStartIdentity)
                return false;
            terminationResult ??= terminateOwnedProcessTree({
                pid: providerPid,
                expectedStartIdentity: providerStartIdentity,
                deadlineAt: new Date(Date.now() + 2_000).toISOString(),
                force: true,
            });
            const terminated = await terminationResult === 'terminated';
            const completed = await new Promise(resolve => {
                const timer = setTimeout(() => resolve(false), 2_000);
                void completion.then(result => {
                    clearTimeout(timer);
                    resolve(result.outcome !== 'provider_cleanup_unverified');
                });
            });
            return terminated && completed;
        };
        const cleanupSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
        const onGateSignal = () => { void terminateProvider(); };
        const ownsSignalLifecycle = Boolean(process.env.OMC_RECOVERY_GATE_SPEC || process.env.OMC_RECOVERY_GATE_SPEC_B64);
        if (ownsSignalLifecycle) {
            for (const signal of cleanupSignals)
                process.once(signal, onGateSignal);
            void completion.finally(() => {
                for (const signal of cleanupSignals)
                    process.removeListener(signal, onGateSignal);
            });
        }
        const spawned = await new Promise(resolve => {
            child.once('spawn', () => resolve(true));
            child.once('error', () => resolve(false));
        });
        if (!spawned) {
            const failed = await completion;
            await invocation.cleanup();
            return failed.outcome === 'provider_spawn_failed'
                ? { outcome: 'provider_spawn_failed' }
                : failed;
        }
        try {
            await new Promise(resolve => setTimeout(resolve, 150));
            if (settled)
                return await completion;
            providerPid = child.pid;
            // Capture identity synchronously to close the PID-reuse window.
            providerStartIdentity = providerPid ? getProcessStartIdentitySync(providerPid) : null;
            if (!providerStartIdentity && providerPid) {
                providerStartIdentity = await getProcessStartIdentity(providerPid);
                // Recheck settled and liveness after async lookup to detect PID reuse
                if (settled || !providerPid || !isProcessAlive(providerPid)) {
                    if (!await terminateProvider())
                        return { outcome: 'provider_cleanup_unverified' };
                    return { outcome: 'provider_spawn_failed' };
                }
            }
            if (settled || !providerPid || !providerStartIdentity || !isProcessAlive(providerPid)) {
                if (!await terminateProvider())
                    return { outcome: 'provider_cleanup_unverified' };
                return { outcome: 'provider_spawn_failed' };
            }
            if (invocation.completionPath && await readFile(invocation.completionPath, 'utf8').then(() => true).catch(() => false)) {
                const exitCode = Number(await readFile(invocation.completionPath, 'utf8').catch(() => ''));
                if (Number.isSafeInteger(exitCode))
                    supervisedExitCode = exitCode;
                if (!await terminateProvider())
                    return { outcome: 'provider_cleanup_unverified' };
                return { outcome: 'provider_spawn_failed' };
            }
            await writeAtomic(`${gate.runPath}.launched`, {
                ...expected,
                provider_pid: providerPid,
                provider_start_identity: providerStartIdentity,
                written_at: new Date().toISOString(),
                ...(invocation.completionPath ? { supervisor_completion_path: invocation.completionPath } : {}),
            });
            if (invocation.completionPath) {
                let pollingCompletion = false;
                supervisorTimer = setInterval(() => {
                    if (pollingCompletion || settled || !providerStartIdentity || !providerPid)
                        return;
                    pollingCompletion = true;
                    void readFile(invocation.completionPath, 'utf8').then(async (raw) => {
                        const exitCode = Number(raw.trim());
                        if (!Number.isSafeInteger(exitCode))
                            return;
                        supervisedExitCode = exitCode;
                        const cleaned = await terminateProvider();
                        if (!cleaned && !settled) {
                            await finishCompletion({ outcome: 'provider_cleanup_unverified' }, { outcome: 'cleanup_unverified', cleanup_verified: false, exit_code: exitCode, signal: null });
                        }
                    }).catch(() => undefined).finally(() => { pollingCompletion = false; });
                }, pollIntervalMs);
                supervisorTimer.unref();
            }
            return { completion };
        }
        catch {
            if (!await terminateProvider())
                return { outcome: 'provider_cleanup_unverified' };
            return { outcome: 'provider_spawn_failed' };
        }
    });
    if (!fenced.ok)
        return { outcome: 'superseded' };
    if ('completion' in fenced.value) {
        if (!fenced.value.completion)
            return { outcome: 'provider_spawn_failed' };
        return await fenced.value.completion;
    }
    return fenced.value;
}
//# sourceMappingURL=worker-activation-gate.js.map