import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
                && value.replacement_generation === expected.replacement_generation && value.pane_attempt_id === expected.pane_attempt_id)
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
    const expected = {
        recovery_id: gate.recoveryId,
        worker_name: gate.workerName,
        replacement_generation: gate.replacementGeneration,
        pane_attempt_id: gate.paneAttemptId,
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
    const child = spawn(gate.providerArgv[0], gate.providerArgv.slice(1), {
        cwd: gate.cwd,
        env: { ...process.env, ...gate.env },
        stdio: 'inherit',
    });
    const completion = new Promise(resolve => {
        child.once('exit', (exitCode, signal) => resolve({ outcome: 'ran', exitCode, signal }));
        child.once('error', () => resolve({ outcome: 'provider_spawn_failed' }));
    });
    const spawned = await new Promise(resolve => {
        child.once('spawn', () => resolve(true));
        child.once('error', () => resolve(false));
    });
    if (!spawned)
        return { outcome: 'provider_spawn_failed' };
    await writeAtomic(`${gate.runPath}.launched`, { ...expected, written_at: new Date().toISOString() });
    return completion;
}
//# sourceMappingURL=worker-activation-gate.js.map