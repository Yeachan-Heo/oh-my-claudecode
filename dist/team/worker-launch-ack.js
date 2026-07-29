import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { absPath, TeamPaths } from './state-paths.js';
import { atomicWriteJson } from '../lib/atomic-write.js';
import { lockPathFor, withFileLock } from '../lib/file-lock.js';
const WORKER_LAUNCH_SCHEMA_VERSION = 1;
const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_DECISION_TIMEOUT_MS = 15_000;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function isExactText(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}
function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isProvider(value) {
    return value === 'claude' || value === 'codex' || value === 'gemini'
        || value === 'cursor' || value === 'grok' || value === 'antigravity';
}
function identityMatches(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.schema_version === WORKER_LAUNCH_SCHEMA_VERSION
        && record.attempt_id === expected.attempt_id
        && record.nonce === expected.nonce
        && record.team_name === expected.team_name
        && record.worker_name === expected.worker_name
        && record.pane_id === expected.pane_id
        && record.provider === expected.provider
        && record.created_at === expected.created_at;
}
function isValidIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.schema_version === WORKER_LAUNCH_SCHEMA_VERSION
        && isUuid(record.attempt_id)
        && isUuid(record.nonce)
        && isExactText(record.team_name)
        && isExactText(record.worker_name)
        && isExactText(record.pane_id)
        && isProvider(record.provider)
        && typeof record.created_at === 'string'
        && Number.isFinite(Date.parse(record.created_at));
}
function isValidLaunchContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    if (record.kind === 'initial')
        return true;
    return record.kind === 'recovery'
        && isExactText(record.recovery_id)
        && Number.isSafeInteger(record.replacement_generation)
        && Number(record.replacement_generation) >= 1
        && isExactText(record.pane_attempt_id);
}
function identityOf(attempt) {
    return {
        schema_version: attempt.schema_version,
        attempt_id: attempt.attempt_id,
        nonce: attempt.nonce,
        team_name: attempt.team_name,
        worker_name: attempt.worker_name,
        pane_id: attempt.pane_id,
        provider: attempt.provider,
        created_at: attempt.created_at,
    };
}
async function readJson(path) {
    try {
        return { kind: 'value', value: JSON.parse(await readFile(path, 'utf8')) };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { kind: 'absent' };
        return { kind: 'malformed' };
    }
}
async function isCurrentLaunchIdentity(currentPath, identity) {
    const current = await readJson(currentPath);
    return current.kind === 'value' && identityMatches(current.value, identity);
}
async function writeExclusiveAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    const handle = await open(candidate, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value), 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(candidate, path);
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
}
function resolvePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export async function prepareWorkerLaunchAttempt(input) {
    const attemptId = randomUUID();
    const identity = {
        schema_version: WORKER_LAUNCH_SCHEMA_VERSION,
        attempt_id: attemptId,
        nonce: randomUUID(),
        team_name: input.teamName,
        worker_name: input.workerName,
        pane_id: input.paneId,
        provider: input.provider,
        created_at: new Date().toISOString(),
    };
    const attempt = {
        ...identity,
        currentPath: absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName)),
        expectedPath: absPath(input.cwd, TeamPaths.workerLaunchExpected(input.teamName, input.workerName, attemptId)),
        ackPath: absPath(input.cwd, TeamPaths.workerLaunchAck(input.teamName, input.workerName, attemptId)),
        decisionPath: absPath(input.cwd, TeamPaths.workerLaunchDecision(input.teamName, input.workerName, attemptId)),
        startedPath: absPath(input.cwd, TeamPaths.workerLaunchStarted(input.teamName, input.workerName, attemptId)),
        runtimeCliPath: input.runtimeCliPath,
        ...(input.context ? { context: input.context } : {}),
    };
    if (existsSync(attempt.expectedPath) || existsSync(attempt.ackPath)
        || existsSync(attempt.decisionPath) || existsSync(attempt.startedPath)) {
        throw new Error('worker_launch_attempt_path_conflict');
    }
    await writeExclusiveAtomic(attempt.expectedPath, identity);
    try {
        await withFileLock(lockPathFor(attempt.currentPath), async () => {
            await atomicWriteJson(attempt.currentPath, {
                ...identity,
                runtime_cli_path: input.runtimeCliPath,
                ...(input.context ? { context: input.context } : {}),
            });
        });
    }
    catch (error) {
        await unlink(attempt.expectedPath).catch(() => undefined);
        throw error;
    }
    return attempt;
}
export async function loadWorkerLaunchAttempt(input) {
    const expectedPath = absPath(input.cwd, TeamPaths.workerLaunchExpected(input.teamName, input.workerName, input.attemptId));
    const expected = await readJson(expectedPath);
    if (expected.kind !== 'value' || !isValidIdentity(expected.value))
        return null;
    const identity = expected.value;
    if (identity.attempt_id !== input.attemptId || identity.team_name !== input.teamName
        || identity.worker_name !== input.workerName || identity.pane_id !== input.paneId
        || identity.provider !== input.provider)
        return null;
    return {
        ...identity,
        currentPath: absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName)),
        expectedPath,
        ackPath: absPath(input.cwd, TeamPaths.workerLaunchAck(input.teamName, input.workerName, input.attemptId)),
        decisionPath: absPath(input.cwd, TeamPaths.workerLaunchDecision(input.teamName, input.workerName, input.attemptId)),
        startedPath: absPath(input.cwd, TeamPaths.workerLaunchStarted(input.teamName, input.workerName, input.attemptId)),
        runtimeCliPath: input.runtimeCliPath,
    };
}
export async function loadCurrentWorkerLaunchAttempt(input) {
    const currentPath = absPath(input.cwd, TeamPaths.workerLaunchCurrent(input.teamName, input.workerName));
    try {
        return await withFileLock(lockPathFor(currentPath), async () => {
            const current = await readJson(currentPath);
            if (current.kind !== 'value' || !isValidIdentity(current.value))
                return null;
            const record = current.value;
            if (record.team_name !== input.teamName || record.worker_name !== input.workerName
                || record.provider !== input.provider || !isExactText(record.runtime_cli_path)
                || (record.context !== undefined && !isValidLaunchContext(record.context)))
                return null;
            const attempt = await loadWorkerLaunchAttempt({
                cwd: input.cwd,
                teamName: input.teamName,
                workerName: input.workerName,
                paneId: record.pane_id,
                provider: input.provider,
                attemptId: record.attempt_id,
                runtimeCliPath: record.runtime_cli_path,
            });
            if (!attempt || !await isWorkerLaunchAttemptAccepted(attempt)
                || !await isWorkerLaunchProviderStarted(attempt)
                || !await isCurrentLaunchIdentity(currentPath, attempt))
                return null;
            return {
                ...attempt,
                ...(record.context ? { context: record.context } : {}),
            };
        });
    }
    catch {
        return null;
    }
}
export function buildWorkerLaunchBootstrapSpec(attempt, providerArgv, cwd, options = {}) {
    return {
        ...identityOf(attempt),
        current_path: attempt.currentPath,
        expected_path: attempt.expectedPath,
        ack_path: attempt.ackPath,
        decision_path: attempt.decisionPath,
        started_path: attempt.startedPath,
        provider_argv: [...providerArgv],
        cwd,
        decision_timeout_ms: resolvePositiveInteger(process.env.OMC_TEAM_START_ACK_DECISION_TIMEOUT_MS, DEFAULT_DECISION_TIMEOUT_MS),
        release_after_spawn: options.releaseAfterSpawn === true,
    };
}
async function publishDecision(attempt, decision, reason) {
    const record = {
        ...identityOf(attempt),
        kind: 'worker_launch_decision',
        decision,
        reason,
        written_at: new Date().toISOString(),
    };
    try {
        await writeExclusiveAtomic(attempt.decisionPath, record);
        return true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const existing = await readJson(attempt.decisionPath);
        return existing.kind === 'value'
            && identityMatches(existing.value, attempt)
            && existing.value.kind === 'worker_launch_decision'
            && existing.value.decision === decision;
    }
}
export async function revokeWorkerLaunchAttempt(attempt, reason) {
    return publishDecision(attempt, 'revoked', reason).catch(() => false);
}
async function rejectWorkerLaunchAttempt(attempt, reason) {
    return await revokeWorkerLaunchAttempt(attempt, reason)
        ? { ok: false, reason }
        : { ok: false, reason: 'decision_conflict' };
}
function acknowledgementResult(value, attempt) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { ok: false, reason: 'ack_malformed' };
    const record = value;
    if (record.kind !== 'worker_launch_ack' || typeof record.written_at !== 'string'
        || !Number.isFinite(Date.parse(record.written_at)))
        return { ok: false, reason: 'ack_malformed' };
    return identityMatches(record, attempt) ? null : { ok: false, reason: 'ack_mismatch' };
}
async function acceptObservedAcknowledgement(attempt, read) {
    if (read.kind === 'absent')
        return null;
    if (read.kind === 'malformed')
        return { ok: false, reason: 'ack_malformed' };
    const invalid = acknowledgementResult(read.value, attempt);
    if (invalid)
        return invalid;
    try {
        return await withFileLock(lockPathFor(attempt.currentPath), async () => {
            if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)) {
                return { ok: false, reason: 'attempt_superseded' };
            }
            return await publishDecision(attempt, 'accepted', 'ack_valid')
                ? { ok: true }
                : { ok: false, reason: 'decision_conflict' };
        });
    }
    catch {
        return { ok: false, reason: 'decision_conflict' };
    }
}
export async function awaitWorkerLaunchAcknowledgement(attempt, options = {}) {
    const expected = await readJson(attempt.expectedPath);
    if (expected.kind !== 'value' || !identityMatches(expected.value, attempt)) {
        return rejectWorkerLaunchAttempt(attempt, 'expected_record_invalid');
    }
    const timeoutMs = options.timeoutMs ?? resolvePositiveInteger(process.env.OMC_TEAM_START_ACK_TIMEOUT_MS, DEFAULT_ACK_TIMEOUT_MS);
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await acceptObservedAcknowledgement(attempt, await readJson(attempt.ackPath));
        if (result) {
            return result.ok ? result : rejectWorkerLaunchAttempt(attempt, result.reason);
        }
        await sleep(pollIntervalMs);
    }
    const finalResult = await acceptObservedAcknowledgement(attempt, await readJson(attempt.ackPath));
    if (finalResult) {
        return finalResult.ok ? finalResult : rejectWorkerLaunchAttempt(attempt, finalResult.reason);
    }
    return rejectWorkerLaunchAttempt(attempt, 'ack_timeout');
}
export async function isWorkerLaunchAttemptAccepted(attempt) {
    const decision = await readJson(attempt.decisionPath);
    return decision.kind === 'value'
        && identityMatches(decision.value, attempt)
        && decision.value.kind === 'worker_launch_decision'
        && decision.value.decision === 'accepted';
}
export async function isWorkerLaunchAttemptCurrent(attempt) {
    try {
        return await withFileLock(lockPathFor(attempt.currentPath), () => isCurrentLaunchIdentity(attempt.currentPath, attempt));
    }
    catch {
        return false;
    }
}
export async function withWorkerLaunchAttemptFence(attempt, fn) {
    try {
        return await withFileLock(lockPathFor(attempt.currentPath), async () => {
            if (!await isCurrentLaunchIdentity(attempt.currentPath, attempt)
                || !await isWorkerLaunchAttemptAccepted(attempt))
                return { ok: false };
            return { ok: true, value: await fn() };
        });
    }
    catch {
        return { ok: false };
    }
}
export async function isWorkerLaunchProviderStarted(attempt) {
    const started = await readJson(attempt.startedPath);
    const record = started.kind === 'value' ? started.value : null;
    return Boolean(record
        && identityMatches(record, attempt)
        && record.kind === 'worker_launch_provider_started'
        && (record.pid === null || Number.isSafeInteger(record.pid))
        && typeof record.written_at === 'string'
        && Number.isFinite(Date.parse(record.written_at)));
}
function isValidBootstrapSpec(value) {
    if (!isValidIdentity(value))
        return false;
    const spec = value;
    return isExactText(spec.current_path)
        && isExactText(spec.expected_path)
        && isExactText(spec.ack_path)
        && isExactText(spec.decision_path)
        && isExactText(spec.started_path)
        && Array.isArray(spec.provider_argv)
        && spec.provider_argv.length > 0
        && isExactText(spec.provider_argv[0])
        && spec.provider_argv.slice(1).every(argument => typeof argument === 'string')
        && typeof spec.cwd === 'string'
        && spec.cwd.length > 0
        && Number.isSafeInteger(spec.decision_timeout_ms)
        && typeof spec.release_after_spawn === 'boolean'
        && Number(spec.decision_timeout_ms) > 0;
}
async function publishAcknowledgement(spec) {
    const acknowledgement = {
        schema_version: spec.schema_version,
        attempt_id: spec.attempt_id,
        nonce: spec.nonce,
        team_name: spec.team_name,
        worker_name: spec.worker_name,
        pane_id: spec.pane_id,
        provider: spec.provider,
        created_at: spec.created_at,
        kind: 'worker_launch_ack',
        written_at: new Date().toISOString(),
    };
    try {
        await writeExclusiveAtomic(spec.ack_path, acknowledgement);
        return true;
    }
    catch {
        return false;
    }
}
async function waitForBootstrapDecision(spec) {
    const deadline = Date.now() + spec.decision_timeout_ms;
    while (Date.now() < deadline) {
        const read = await readJson(spec.decision_path);
        if (read.kind === 'value' && identityMatches(read.value, spec)
            && read.value.kind === 'worker_launch_decision') {
            const decision = read.value.decision;
            if (decision === 'accepted' || decision === 'revoked')
                return decision;
        }
        await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
    return 'timeout';
}
function quoteWindowsCmdArgument(value) {
    return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}
export function buildProviderSpawnInvocation(providerArgv, platform = process.platform, env = process.env) {
    const [command, ...args] = providerArgv;
    if (!command)
        throw new Error('worker_launch_provider_argv_missing');
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
        return {
            command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
            args: ['/d', '/s', '/c'],
            batchScript: `@echo off\r\n${providerArgv.map(quoteWindowsCmdArgument).join(' ')}\r\n`,
        };
    }
    return { command, args };
}
export async function materializeProviderSpawnInvocation(invocation) {
    if (!invocation.batchScript) {
        return { command: invocation.command, args: invocation.args, cleanup: async () => { } };
    }
    const wrapperDir = await mkdtemp(join(tmpdir(), 'omc-provider-'));
    const wrapperPath = join(wrapperDir, 'launch.cmd');
    await writeFile(wrapperPath, invocation.batchScript, { encoding: 'utf8', mode: 0o600 });
    return {
        command: invocation.command,
        args: [...invocation.args, `"${wrapperPath}"`],
        cleanup: async () => { await rm(wrapperDir, { recursive: true, force: true }); },
    };
}
async function publishProviderStarted(spec, pid) {
    const record = {
        schema_version: spec.schema_version,
        attempt_id: spec.attempt_id,
        nonce: spec.nonce,
        team_name: spec.team_name,
        worker_name: spec.worker_name,
        pane_id: spec.pane_id,
        provider: spec.provider,
        created_at: spec.created_at,
        kind: 'worker_launch_provider_started',
        pid: Number.isSafeInteger(pid) ? pid : null,
        written_at: new Date().toISOString(),
    };
    try {
        await writeExclusiveAtomic(spec.started_path, record);
        return true;
    }
    catch {
        return false;
    }
}
export async function runWorkerLaunchBootstrap(value) {
    if (!isValidBootstrapSpec(value))
        return { outcome: 'invalid_spec' };
    const spec = value;
    const expected = await readJson(spec.expected_path);
    if (expected.kind !== 'value' || !identityMatches(expected.value, spec))
        return { outcome: 'expected_record_invalid' };
    if (!await publishAcknowledgement(spec))
        return { outcome: 'ack_conflict' };
    const decision = await waitForBootstrapDecision(spec);
    if (decision === 'timeout')
        return { outcome: 'decision_timeout' };
    if (decision === 'revoked')
        return { outcome: 'revoked' };
    const { OMC_WORKER_LAUNCH_SPEC: _launchSpec, OMC_WORKER_LAUNCH_SPEC_B64: _encodedLaunchSpec, ...providerEnv } = process.env;
    try {
        const launched = await withFileLock(lockPathFor(spec.current_path), async () => {
            if (!await isCurrentLaunchIdentity(spec.current_path, spec)) {
                return { outcome: 'superseded' };
            }
            const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(spec.provider_argv));
            const child = spawn(invocation.command, invocation.args, {
                cwd: spec.cwd,
                env: providerEnv,
                stdio: 'inherit',
            });
            const completion = new Promise(resolve => {
                child.once('exit', async (exitCode, signal) => {
                    await invocation.cleanup();
                    resolve({ outcome: 'ran', exitCode, signal });
                });
                child.once('error', async () => {
                    await invocation.cleanup();
                    resolve({ outcome: 'provider_spawn_failed' });
                });
            });
            const spawned = await new Promise(resolve => {
                child.once('spawn', () => resolve(true));
                child.once('error', () => resolve(false));
            });
            if (!spawned) {
                await invocation.cleanup();
                return { outcome: 'provider_spawn_failed' };
            }
            if (!await isCurrentLaunchIdentity(spec.current_path, spec)) {
                child.kill();
                await completion;
                return { outcome: 'superseded' };
            }
            if (!await publishProviderStarted(spec, child.pid)) {
                child.kill();
                await completion;
                return { outcome: 'provider_spawn_failed' };
            }
            if (spec.release_after_spawn)
                return { outcome: 'ran', exitCode: null, signal: null };
            return { completion };
        });
        if ('completion' in launched) {
            if (!launched.completion)
                return { outcome: 'provider_spawn_failed' };
            return await launched.completion;
        }
        return launched;
    }
    catch {
        return { outcome: 'provider_spawn_failed' };
    }
}
//# sourceMappingURL=worker-launch-ack.js.map