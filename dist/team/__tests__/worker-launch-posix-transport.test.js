/**
 * Regression suite for issue #3655 — POSIX supervised worker launch transport.
 *
 * v4.15.8/v4.15.9 introduced the attempt-owned descriptor transport on the
 * runtime-cli reader side (`runWorkerLaunchFromEnvironment` rejects any
 * inline-only launch spec with `worker_launch_descriptor_required`), but the
 * POSIX supervised writer (`buildWorkerStartCommand` via
 * `spawnWorkerInPane`) still delivered the bootstrap spec inline through
 * `OMC_WORKER_LAUNCH_SPEC`. Every supervised POSIX worker launch therefore
 * failed before provider startup. This suite pins the writer/reader contract:
 * the POSIX writer must materialize an attempt-owned descriptor and hand the
 * runtime CLI its path, exactly like the native Windows path already does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerStartCommand } from '../tmux-session.js';
import { awaitWorkerLaunchAcknowledgement, cleanupWorkerLaunchTransport, materializeWorkerLaunchTransport, prepareWorkerLaunchAttempt, readAndConsumeWorkerLaunchDescriptor, } from '../worker-launch-ack.js';
import { runWorkerLaunchFromEnvironment } from '../runtime-cli.js';
let cwd = '';
let originalPlatform;
let exitSpy;
/** Undo the writer's single-quote shell escaping for one env assignment. */
function extractEnvAssignment(command, key) {
    const pattern = new RegExp(`(?:^|\\s)${key}=('(?:[^']|'"'"')*')`);
    const match = command.match(pattern);
    if (!match)
        return undefined;
    return match[1].slice(1, -1).replace(/'"'"'/g, "'");
}
/** Simulate the pane shell: apply the writer's env assignments to process.env. */
function applyEnvAssignments(command, keys) {
    for (const key of keys) {
        const value = extractEnvAssignment(command, key);
        if (value !== undefined)
            process.env[key] = value;
    }
}
async function makeAttempt() {
    cwd = await mkdtemp(join(tmpdir(), 'worker-launch-posix-transport-'));
    return prepareWorkerLaunchAttempt({
        cwd,
        teamName: 'posix-team',
        workerName: 'worker-1',
        paneId: '%2',
        provider: 'codex',
        runtimeCliPath: '/runtime-cli.cjs',
    });
}
afterEach(async () => {
    if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
    originalPlatform = undefined;
    exitSpy?.mockRestore();
    exitSpy = undefined;
    for (const key of ['OMC_WORKER_LAUNCH_SPEC', 'OMC_WORKER_LAUNCH_SPEC_B64', 'OMC_WORKER_LAUNCH_SPEC_FILE']) {
        delete process.env[key];
    }
    vi.unstubAllEnvs();
    if (cwd)
        await rm(cwd, { recursive: true, force: true });
    cwd = '';
});
describe('POSIX supervised worker-launch transport (issue #3655)', () => {
    it('supervised POSIX writer materializes a descriptor the runtime CLI reader accepts and executes', async () => {
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('HOME', '/home/tester');
        const attempt = await makeAttempt();
        const providerMarker = join(cwd, 'provider-ran.json');
        const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)},JSON.stringify({attempt:process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,transport:process.env.OMC_WORKER_LAUNCH_SPEC_FILE??null}));setTimeout(()=>process.exit(0),200)`;
        const config = {
            teamName: 'posix-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_WORKER: 'posix-team/worker-1',
                OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id,
            },
            launchBinary: process.execPath,
            launchArgs: ['-e', providerScript],
            cwd,
            provider: 'codex',
            launchAttempt: attempt,
        };
        // The writer seam (spawnWorkerInPane) materializes the attempt transport
        // before building the start command — identical to the native Windows path.
        const materialized = await materializeWorkerLaunchTransport({
            attempt,
            providerArgv: [process.execPath, '-e', providerScript],
            cwd,
            providerEnv: config.envVars,
        });
        const startCmd = buildWorkerStartCommand(config);
        // Writer contract: the delivered POSIX command references the attempt-owned
        // descriptor; it must NOT inline the bootstrap spec (secrets stay off the
        // process list and out of tmux scrollback; command size stays bounded).
        const descriptorPath = extractEnvAssignment(startCmd, 'OMC_WORKER_LAUNCH_SPEC_FILE');
        expect(descriptorPath).toBe(materialized.bootstrapDescriptorPath);
        expect(startCmd).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
        expect(startCmd).not.toContain(providerScript);
        expect(Buffer.byteLength(startCmd, 'utf8')).toBeLessThan(2_048);
        // Reader contract: run the runtime CLI exactly as the pane would, with the
        // env assignments the writer emitted.
        applyEnvAssignments(startCmd, ['OMC_WORKER_LAUNCH_SPEC_FILE', 'OMC_TEAM_WORKER', 'OMC_WORKER_LAUNCH_ATTEMPT_ID']);
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined));
        const bootstrap = runWorkerLaunchFromEnvironment();
        await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 5_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toBeUndefined();
        // The validated bootstrap ran: the provider stub executed and saw the
        // attempt identity while the internal descriptor env var stayed filtered.
        const marker = JSON.parse(await readFile(providerMarker, 'utf8'));
        expect(marker.attempt).toBe(attempt.attempt_id);
        expect(marker.transport).toBeNull();
        // Consume semantics: the runtime CLI consumed the descriptor after
        // validation; the transport owner/wrapper remain until explicit retire.
        await expect(readFile(materialized.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupWorkerLaunchTransport(attempt, 'test_cleanup')).resolves.toBe(true);
        await expect(readFile(materialized.wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('accepts the materialized descriptor and consumes it exactly once', async () => {
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const attempt = await makeAttempt();
        const materialized = await materializeWorkerLaunchTransport({
            attempt,
            providerArgv: [process.execPath, '-e', 'process.exit(0)'],
            cwd,
        });
        const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath);
        expect(consumed).toMatchObject({ attempt_id: attempt.attempt_id, provider: 'codex' });
        // Second consume fails closed: the descriptor is gone.
        await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath))
            .rejects.toThrow('worker_launch_descriptor_missing');
        await expect(cleanupWorkerLaunchTransport(attempt, 'test_cleanup_after_consume')).resolves.toBe(true);
    });
    it('keeps descriptor/source conflict and invalid JSON fail-closed at the runtime CLI', async () => {
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        process.env.OMC_WORKER_LAUNCH_SPEC = '{"provider_argv":["codex"],';
        await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_invalid_spec_json');
        delete process.env.OMC_WORKER_LAUNCH_SPEC;
        process.env.OMC_WORKER_LAUNCH_SPEC = '{}';
        process.env.OMC_WORKER_LAUNCH_SPEC_FILE = join(cwd ?? '', 'conflicting-worker-launch.json');
        await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_spec_source_conflict');
        delete process.env.OMC_WORKER_LAUNCH_SPEC;
        delete process.env.OMC_WORKER_LAUNCH_SPEC_FILE;
        // An inline-only spec (the pre-fix POSIX writer behavior) stays rejected.
        process.env.OMC_WORKER_LAUNCH_SPEC = '{"provider_argv":["codex"]}';
        await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_descriptor_required');
    });
    it('delivers a bounded command for a provider environment with a large value', async () => {
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('HOME', '/home/tester');
        const attempt = await makeAttempt();
        const longValue = `long-${'x'.repeat(12_000)}`;
        // A large provider argv/env is written into the attempt descriptor, exactly
        // as the supervised writer does; the delivered command must only reference
        // the descriptor path and stay small (issue #3655).
        const materialized = await materializeWorkerLaunchTransport({
            attempt,
            providerArgv: [process.execPath, '--token', longValue],
            providerEnv: { OMC_TEAM_WORKER: 'posix-team/worker-1', PROVIDER_LONG: longValue },
            cwd,
        });
        expect(Buffer.byteLength(await readFile(materialized.bootstrapDescriptorPath, 'utf8'), 'utf8')).toBeGreaterThan(12_000);
        const startCmd = buildWorkerStartCommand({
            teamName: 'posix-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_WORKER: 'posix-team/worker-1' },
            launchBinary: process.execPath,
            launchArgs: ['--version'],
            cwd,
            provider: 'codex',
            launchAttempt: attempt,
        });
        const descriptorPath = extractEnvAssignment(startCmd, 'OMC_WORKER_LAUNCH_SPEC_FILE');
        expect(descriptorPath).toBe(attempt.bootstrapDescriptorPath);
        expect(startCmd).not.toContain(longValue);
        expect(Buffer.byteLength(startCmd, 'utf8')).toBeLessThan(2_048);
    });
});
//# sourceMappingURL=worker-launch-posix-transport.test.js.map