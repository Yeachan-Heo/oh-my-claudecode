import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { aliasActiveRecoveryRequest, canonicalRecoveryPayloadHash, isMatchingRecoveryFinal, readRecoveryOutcome, readRecoveryFinalState, readRecoveryRequestReservation, reserveRecoveryRequest, writeRecoveryFinal, } from './recovery-request-store.js';
import { absPath, TeamPaths } from './state-paths.js';
import { assertTeamInstanceUnderLock, createTeamInstanceBinding, withTeamInstanceLifecycleLock } from './team-instance.js';
import { checkOwnerFence, currentProcessStartIdentity, isProcessIdentityDead, readLatestOwnerEpoch, } from './team-owner-epoch.js';
import { isValidTeamInstanceId } from './types.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { readRevisionedTeamConfig, validateLegacyTeamConfig } from './monitor.js';
const MIN_RECOVERY_TIMEOUT_MS = 180_000;
const MAX_RECOVERY_TIMEOUT_MS = 300_000;
function workspaceHash(cwd) {
    return createHash('sha256').update(cwd).digest('hex');
}
function normalizeRecoveryInstanceId(value) {
    if (!isValidTeamInstanceId(value))
        throw new Error('invalid_recovery_instance_id');
    return value.toLowerCase();
}
function recoveryInstanceBinding(input) {
    return createTeamInstanceBinding({
        teamName: input.teamName,
        cwd: input.cwd,
        instanceId: normalizeRecoveryInstanceId(input.instanceId),
    });
}
/** Assert the caller's intended incarnation while the lifecycle lock is held. */
async function assertRecoveryInstanceUnderLock(input) {
    await assertTeamInstanceUnderLock(recoveryInstanceBinding(input));
}
async function assertRecoveryInstance(input) {
    try {
        const binding = recoveryInstanceBinding(input);
        await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, () => assertRecoveryInstanceUnderLock(input));
        return true;
    }
    catch {
        return false;
    }
}
function timeoutBudget(timeoutMs, minimum = MIN_RECOVERY_TIMEOUT_MS, maximum = MAX_RECOVERY_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs))
        return minimum;
    return Math.max(minimum, Math.min(maximum, Math.floor(timeoutMs)));
}
function resolveCanonicalReservation(cwd, reservation) {
    let current = reservation;
    const seen = new Set();
    while (current.alias_of_request_id && !seen.has(current.request_id)) {
        seen.add(current.request_id);
        const parent = readRecoveryRequestReservation(cwd, current.alias_of_request_id);
        if (!parent || parent.operation !== reservation.operation || parent.payload_hash !== reservation.payload_hash
            || parent.workspace_hash !== reservation.workspace_hash || parent.team_name !== reservation.team_name
            || parent.worker_name !== reservation.worker_name
            || parent.instance_id.toLowerCase() !== reservation.instance_id.toLowerCase()
            || parent.recovery_id !== reservation.recovery_id) {
            throw new Error('invalid_persisted_state');
        }
        current = parent;
    }
    if (current.kind !== 'reservation')
        throw new Error('invalid_persisted_state');
    return current;
}
function findActiveIdenticalReservation(cwd, payload) {
    const targetHash = canonicalRecoveryPayloadHash(payload);
    try {
        for (const name of readdirSync(absPath(cwd, TeamPaths.recoveryRequestsRoot()))) {
            const match = /^(.+)\.pending\.json$/.exec(name);
            if (!match)
                continue;
            const reservation = readRecoveryRequestReservation(cwd, match[1]);
            if (!reservation || reservation.operation !== payload.operation || reservation.payload_hash !== targetHash
                || reservation.workspace_hash !== payload.workspaceHash || reservation.team_name !== payload.teamName
                || reservation.worker_name !== payload.workerName
                || reservation.instance_id.toLowerCase() !== payload.instanceId.toLowerCase())
                continue;
            const canonical = resolveCanonicalReservation(cwd, reservation);
            const outcome = readRecoveryOutcome(cwd, canonical.request_id);
            if (!outcome || outcome.kind === 'phase')
                return canonical;
        }
    }
    catch { /* request root has not been created */ }
    return null;
}
export function withRecoveryAdmissionLock(cwd, payloadHash, fn) {
    return withProcessIdentityFileLock(absPath(cwd, TeamPaths.recoveryAdmissionLock(payloadHash)), fn);
}
function canonicalBootstrapCandidate(value) {
    return JSON.stringify(value);
}
function recoveryOwnerBootstrapCandidatePath(cwd, teamName, expectedEpoch, nonce) {
    return absPath(cwd, TeamPaths.recoveryOwnerBootstrapCandidate(teamName, expectedEpoch, nonce));
}
async function syncParentDirectory(path) {
    const directory = await open(dirname(path), 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
function validateBootstrapCandidate(value, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor) {
    const candidate = value;
    if (!candidate || candidate.schema_version !== 1 || candidate.request_id !== input.requestId
        || candidate.recovery_id !== recoveryId || candidate.team_name !== input.teamName
        || candidate.worker_name !== input.workerName
        || typeof candidate.instance_id !== 'string'
        || candidate.instance_id.toLowerCase() !== normalizeRecoveryInstanceId(input.instanceId)
        || candidate.expected_epoch !== expectedEpoch
        || candidate.nonce !== nonce || candidate.pid !== pid || candidate.process_started_at !== processStartedAt
        || candidate.predecessor_epoch !== (predecessor?.epoch ?? 0)
        || candidate.predecessor_nonce !== (predecessor?.nonce ?? null)
        || candidate.predecessor_pid !== (predecessor?.pid ?? null)
        || candidate.predecessor_process_started_at !== (predecessor?.process_started_at ?? null)
        || typeof candidate.created_at !== 'string' || !Number.isFinite(Date.parse(candidate.created_at))
        || typeof candidate.payload_hash !== 'string')
        return false;
    const { payload_hash, ...unsigned } = candidate;
    return createHash('sha256').update(canonicalBootstrapCandidate(unsigned)).digest('hex') === payload_hash;
}
async function publishRecoveryOwnerBootstrapCandidate(input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor) {
    const unsigned = {
        schema_version: 1,
        request_id: input.requestId,
        recovery_id: recoveryId,
        team_name: input.teamName,
        worker_name: input.workerName,
        instance_id: normalizeRecoveryInstanceId(input.instanceId),
        expected_epoch: expectedEpoch,
        nonce,
        pid,
        process_started_at: processStartedAt,
        predecessor_epoch: predecessor?.epoch ?? 0,
        predecessor_nonce: predecessor?.nonce ?? null,
        predecessor_pid: predecessor?.pid ?? null,
        predecessor_process_started_at: predecessor?.process_started_at ?? null,
        created_at: new Date().toISOString(),
    };
    const candidate = {
        ...unsigned,
        payload_hash: createHash('sha256').update(canonicalBootstrapCandidate(unsigned)).digest('hex'),
    };
    const path = recoveryOwnerBootstrapCandidatePath(input.cwd, input.teamName, expectedEpoch, nonce);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.candidate`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(candidate), 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
        const linked = JSON.parse(await readFile(path, 'utf8'));
        if (!validateBootstrapCandidate(linked, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor)) {
            throw new Error('runtime_owner_bootstrap_candidate_mismatch');
        }
        await syncParentDirectory(path);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const linked = JSON.parse(await readFile(path, 'utf8'));
        if (!validateBootstrapCandidate(linked, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor)) {
            throw new Error('runtime_owner_bootstrap_candidate_mismatch');
        }
        await syncParentDirectory(path);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
function hasLiveOrUnknownBootstrapCandidate(input, recoveryId, expectedEpoch, predecessor) {
    const candidateDirectory = dirname(recoveryOwnerBootstrapCandidatePath(input.cwd, input.teamName, expectedEpoch, 'candidate'));
    const legacyCandidate = join(dirname(candidateDirectory), `${expectedEpoch}.json`);
    if (existsSync(legacyCandidate))
        return true;
    let entries;
    try {
        entries = readdirSync(candidateDirectory);
    }
    catch {
        return false;
    }
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        let value;
        try {
            value = JSON.parse(readFileSync(join(candidateDirectory, entry), 'utf8'));
        }
        catch {
            return true;
        }
        if (!value || typeof value.nonce !== 'string' || typeof value.pid !== 'number'
            || typeof value.process_started_at !== 'string'
            || !validateBootstrapCandidate(value, input, recoveryId, expectedEpoch, value.nonce, value.pid, value.process_started_at, predecessor)
            || !isProcessIdentityDead({ pid: value.pid, process_started_at: value.process_started_at }))
            return true;
    }
    return false;
}
/** Narrow white-box hooks for deterministic crash/retry protocol tests. */
/** Narrow white-box hooks for deterministic crash/retry protocol tests. */
export const recoveryOwnerBootstrapTestHooks = {
    publishCandidate: publishRecoveryOwnerBootstrapCandidate,
    hasLiveOrUnknownCandidate: hasLiveOrUnknownBootstrapCandidate,
    spawn: (implementation) => {
        recoveryOwnerSpawn = implementation ?? spawn;
        return recoveryOwnerSpawn;
    },
};
let recoveryOwnerSpawn = spawn;
export function parseRecoveryIntent(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('invalid_persisted_state');
    }
    const intent = value;
    if (intent?.schema_version !== 1 || intent.kind !== 'recover-worker'
        || intent.operation !== 'recover-worker' || typeof intent.workspace_hash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.workspace_hash)
        || typeof intent.payload_hash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.payload_hash)
        || typeof intent.request_id !== 'string' || intent.request_id.length === 0
        || typeof intent.recovery_id !== 'string' || intent.recovery_id.length === 0
        || typeof intent.team_name !== 'string' || intent.team_name.length === 0
        || typeof intent.worker_name !== 'string' || intent.worker_name.length === 0
        || !isValidTeamInstanceId(intent.instance_id)
        || intent.payload_hash !== canonicalRecoveryPayloadHash({ operation: intent.operation,
            workspaceHash: intent.workspace_hash, teamName: intent.team_name, workerName: intent.worker_name,
            instanceId: intent.instance_id })
        || typeof intent.created_at !== 'string' || !Number.isFinite(Date.parse(intent.created_at))) {
        throw new Error('invalid_persisted_state');
    }
    return intent;
}
function validateRecoveryIntent(intent, input, recoveryId) {
    const expectedWorkspaceHash = workspaceHash(input.cwd);
    const expectedPayloadHash = canonicalRecoveryPayloadHash({ operation: 'recover-worker', workspaceHash: expectedWorkspaceHash,
        teamName: input.teamName, workerName: input.workerName, instanceId: input.instanceId });
    if (intent.request_id !== input.requestId || intent.recovery_id !== recoveryId || intent.operation !== 'recover-worker'
        || intent.workspace_hash !== expectedWorkspaceHash || intent.payload_hash !== expectedPayloadHash
        || intent.team_name !== input.teamName || intent.worker_name !== input.workerName
        || intent.instance_id.toLowerCase() !== normalizeRecoveryInstanceId(input.instanceId)) {
        throw new Error('invalid_persisted_state');
    }
}
async function publishIntent(input, recoveryId) {
    const path = absPath(input.cwd, TeamPaths.recoveryIntent(input.teamName, recoveryId));
    try {
        validateRecoveryIntent(parseRecoveryIntent(await readFile(path, 'utf8')), input, recoveryId);
        return;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const workspaceHashValue = workspaceHash(input.cwd);
    const intentPayload = { operation: 'recover-worker', workspaceHash: workspaceHashValue,
        teamName: input.teamName, workerName: input.workerName, instanceId: normalizeRecoveryInstanceId(input.instanceId) };
    const intent = { schema_version: 1, kind: 'recover-worker', request_id: input.requestId,
        recovery_id: recoveryId, operation: intentPayload.operation, workspace_hash: intentPayload.workspaceHash,
        payload_hash: canonicalRecoveryPayloadHash(intentPayload), team_name: input.teamName, worker_name: input.workerName,
        instance_id: intentPayload.instanceId,
        created_at: new Date().toISOString() };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    const candidateHandle = await open(candidate, 'wx', 0o600);
    try {
        await candidateHandle.writeFile(JSON.stringify(intent), 'utf8');
        await candidateHandle.sync();
    }
    finally {
        await candidateHandle.close();
    }
    try {
        await link(candidate, path);
        validateRecoveryIntent(parseRecoveryIntent(await readFile(path, 'utf8')), input, recoveryId);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        validateRecoveryIntent(parseRecoveryIntent(await readFile(path, 'utf8')), input, recoveryId);
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
}
function timeoutResult(input, recoveryId) {
    return { outcome: 'failed', committed: false, error: 'recovery_request_timeout', requestId: input.requestId,
        recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: new Date().toISOString(),
        message: 'Timed out waiting for the persistent recovery owner.' };
}
export async function teamRecoveryState(cwd, teamName) {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    if (!existsSync(configPath))
        return 'team_not_found';
    try {
        const revisioned = await readRevisionedTeamConfig(teamName, cwd);
        if (revisioned)
            return 'v2';
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        return validateLegacyTeamConfig(config, teamName) ? 'runtime_v2_required' : 'invalid_persisted_state';
    }
    catch {
        return 'invalid_persisted_state';
    }
}
function terminalResult(input, recoveryId, error) {
    const message = error === 'team_not_found'
        ? 'The requested team does not exist.'
        : error === 'runtime_v2_required'
            ? 'Dead-worker recovery requires runtime v2 state.'
            : error === 'invalid_persisted_state'
                ? 'The authoritative team config is unreadable or malformed.'
                : 'The persistent runtime owner identity cannot be verified.';
    return { outcome: 'failed', committed: false, error, requestId: input.requestId, recoveryId,
        teamName: input.teamName, workerName: input.workerName, updatedAt: new Date().toISOString(), message };
}
function persistTerminalResult(input, recoveryId, result) {
    writeRecoveryFinal(input.cwd, {
        schema_version: 1, kind: 'final', request_id: input.requestId, recovery_id: recoveryId,
        team_name: input.teamName, worker_name: input.workerName, outcome: 'failed', result,
        error: { code: 'error' in result ? result.error : 'runtime_owner_unavailable', message: result.message, commit_uncertain: false }, continuation: 'none', adoption: 'not_started',
        services: 'terminal_degraded', manifest: 'repair_required', completed_at: result.updatedAt,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    return result;
}
function ownerAvailability(cwd, teamName) {
    let owner;
    try {
        owner = readLatestOwnerEpoch(cwd, teamName);
    }
    catch {
        return 'unknown';
    }
    if (!owner)
        return 'missing';
    if (isProcessIdentityDead(owner))
        return 'dead';
    try {
        process.kill(owner.pid, 0);
        return currentProcessStartIdentity(owner.pid) === owner.process_started_at ? 'live' : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
export function resolveRuntimeCliPath() {
    if (process.env.OMC_RUNTIME_CLI_PATH)
        return process.env.OMC_RUNTIME_CLI_PATH;
    if (typeof __dirname !== 'undefined' && __dirname) {
        return basename(__dirname) === 'bridge'
            ? join(__dirname, 'runtime-cli.cjs')
            : join(__dirname, '../../bridge/runtime-cli.cjs');
    }
    const entry = process.argv[1];
    if (entry && basename(entry) === 'runtime-cli.cjs')
        return entry;
    throw new Error('runtime_owner_bootstrap_path_unavailable');
}
export function isExpectedRecoveryOwnerSuccessor(owner, expectedEpoch, childPid, childProcessStartedAt, fenceOk, expectedNonce) {
    return Boolean(owner && childProcessStartedAt && owner.epoch === expectedEpoch && owner.pid === childPid
        && owner.process_started_at === childProcessStartedAt && (!expectedNonce || owner.nonce === expectedNonce) && fenceOk);
}
async function bootstrapPersistentOwner(input, priorEpoch) {
    let childFailed = false;
    const onChildFailure = () => { childFailed = true; };
    let setup = null;
    try {
        // Hold the lifecycle lock only through identity validation, child spawn,
        // and immutable candidate publication.  The child must acquire the same
        // lock during prepareRecoveryOwnerBootstrap, so waiting under this lock
        // would deadlock the election handshake.
        setup = await withTeamInstanceLifecycleLock(input.cwd, input.teamName, async () => {
            let predecessor;
            try {
                predecessor = readLatestOwnerEpoch(input.cwd, input.teamName);
            }
            catch {
                return null;
            }
            const reservation = readRecoveryRequestReservation(input.cwd, input.requestId);
            if (priorEpoch !== (predecessor?.epoch ?? null)
                || (predecessor && !isProcessIdentityDead(predecessor))
                || !reservation || reservation.kind !== 'reservation' || reservation.recovery_id.length === 0
                || reservation.team_name !== input.teamName || reservation.worker_name !== input.workerName
                || reservation.instance_id.toLowerCase() !== normalizeRecoveryInstanceId(input.instanceId))
                return null;
            try {
                await assertRecoveryInstanceUnderLock(input);
            }
            catch {
                return null;
            }
            const predecessorEpoch = predecessor?.epoch ?? 0;
            const expectedEpoch = predecessorEpoch + 1;
            if (hasLiveOrUnknownBootstrapCandidate(input, reservation.recovery_id, expectedEpoch, predecessor))
                return null;
            const bootstrapNonce = randomUUID();
            let child;
            try {
                child = recoveryOwnerSpawn(process.execPath, [resolveRuntimeCliPath()], {
                    cwd: input.cwd,
                    detached: true,
                    stdio: 'ignore',
                    env: {
                        ...process.env,
                        OMC_RECOVERY_OWNER_INPUT: JSON.stringify(input),
                        OMC_RECOVERY_OWNER_EXPECTED_EPOCH: String(expectedEpoch),
                        OMC_RECOVERY_OWNER_PREDECESSOR_EPOCH: String(predecessorEpoch),
                        OMC_RECOVERY_OWNER_PREDECESSOR_NONCE: predecessor?.nonce ?? '',
                        OMC_RECOVERY_OWNER_NONCE: bootstrapNonce,
                        OMC_RECOVERY_OWNER_PREDECESSOR_PID: String(predecessor?.pid ?? 0),
                        OMC_RECOVERY_OWNER_PREDECESSOR_STARTED_AT: predecessor?.process_started_at ?? '',
                        OMC_RECOVERY_OWNER_RECOVERY_ID: reservation.recovery_id,
                    },
                });
            }
            catch {
                return null;
            }
            child.once('error', onChildFailure);
            child.once('exit', onChildFailure);
            child.unref();
            const childPid = child.pid;
            if (typeof childPid !== 'number' || !Number.isSafeInteger(childPid) || childPid < 1)
                return null;
            const childProcessStartedAt = currentProcessStartIdentity(childPid);
            if (!childProcessStartedAt || childFailed)
                return null;
            try {
                await publishRecoveryOwnerBootstrapCandidate(input, reservation.recovery_id, expectedEpoch, bootstrapNonce, childPid, childProcessStartedAt, predecessor);
            }
            catch {
                return null;
            }
            return { reservation, expectedEpoch, bootstrapNonce, child, childPid, childProcessStartedAt };
        });
    }
    catch {
        return false;
    }
    if (!setup)
        return false;
    const { reservation, expectedEpoch, bootstrapNonce, child, childPid, childProcessStartedAt, } = setup;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (childFailed)
            return false;
        let owner;
        try {
            owner = readLatestOwnerEpoch(input.cwd, input.teamName);
        }
        catch {
            return false;
        }
        const config = await readRevisionedTeamConfig(input.teamName, input.cwd).catch(() => null);
        const configBound = config?.config.runtime_owner_epoch;
        const active = config?.config.active_recovery;
        const fenceOk = owner ? checkOwnerFence(input.cwd, input.teamName, { epoch: owner.epoch, nonce: owner.nonce }).ok : false;
        if (isExpectedRecoveryOwnerSuccessor(owner, expectedEpoch, childPid, childProcessStartedAt, fenceOk, bootstrapNonce)
            && config?.config.instance_id?.toLowerCase() === normalizeRecoveryInstanceId(input.instanceId)
            && configBound?.epoch === expectedEpoch && configBound.nonce === bootstrapNonce
            && configBound.pid === childPid && configBound.process_started_at === childProcessStartedAt
            && active?.request_id === input.requestId && active?.recovery_id === reservation.recovery_id
            && active?.worker_name === input.workerName && active?.owner_epoch === expectedEpoch && active?.owner_nonce === bootstrapNonce) {
            if (childFailed || child.exitCode !== null || child.signalCode !== null)
                return false;
            child.removeListener('error', onChildFailure);
            child.removeListener('exit', onChildFailure);
            return true;
        }
        if (owner && (owner.epoch > expectedEpoch || (owner.epoch === expectedEpoch && owner.pid !== childPid)))
            return false;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
}
/** Durable admission/replay client. The injected owner alone performs recovery effects. */
export function createRecoveryOwnerClient(dispatch, timing = {}) {
    return {
        async recoverDeadWorker(input) {
            const requestId = input.requestId || randomUUID();
            const normalized = { ...input, requestId, instanceId: normalizeRecoveryInstanceId(input.instanceId),
                timeoutMs: timeoutBudget(input.timeoutMs, timing.minTimeoutMs ?? MIN_RECOVERY_TIMEOUT_MS, timing.maxTimeoutMs ?? MAX_RECOVERY_TIMEOUT_MS) };
            const payload = { operation: 'recover-worker', workspaceHash: workspaceHash(normalized.cwd),
                teamName: normalized.teamName, workerName: normalized.workerName, instanceId: normalized.instanceId };
            const admitted = await withTeamInstanceLifecycleLock(normalized.cwd, normalized.teamName, async () => {
                const existing = readRecoveryRequestReservation(normalized.cwd, requestId);
                const existingMatchesPayload = Boolean(existing
                    && existing.operation === payload.operation
                    && existing.payload_hash === canonicalRecoveryPayloadHash(payload)
                    && existing.workspace_hash === payload.workspaceHash
                    && existing.team_name === payload.teamName
                    && existing.worker_name === payload.workerName
                    && existing.instance_id.toLowerCase() === payload.instanceId);
                // A valid immutable final is replayable through its reservation even
                // after the named state has been disposed or replaced.  Do not
                // attempt to assert that old instance against a successor.
                if (existingMatchesPayload) {
                    const existingCanonical = resolveCanonicalReservation(normalized.cwd, existing);
                    const existingFinalState = readRecoveryFinalState(normalized.cwd, existingCanonical.request_id);
                    if (existingFinalState.kind === 'invalid')
                        throw new Error('invalid_persisted_state');
                    const existingOutcome = readRecoveryOutcome(normalized.cwd, existingCanonical.request_id);
                    if (isMatchingRecoveryFinal(existingOutcome, {
                        requestId: existingCanonical.request_id,
                        recoveryId: existingCanonical.recovery_id,
                        teamName: normalized.teamName,
                        workerName: normalized.workerName,
                    })) {
                        return { kind: 'final', result: existingOutcome.result };
                    }
                }
                // A fresh by-name request may only create a reservation after the
                // current named state has been classified.  Missing, legacy, and
                // malformed state are read-only diagnostics: return the typed
                // failure without manufacturing an unowned reservation, intent, or
                // terminal final. Existing request IDs intentionally bypass this
                // check so an old incarnation can replay its durable final or remain
                // pending without being rebound to a replacement.
                if (!existing) {
                    const state = await teamRecoveryState(normalized.cwd, normalized.teamName);
                    if (state !== 'v2') {
                        return {
                            kind: 'terminal',
                            result: terminalResult(normalized, '', state),
                        };
                    }
                }
                const active = findActiveIdenticalReservation(normalized.cwd, payload);
                // Any reservation/intent publication must first prove that the
                // caller's intended instance still owns the canonical name.  A
                // stale request from instance A therefore remains pending when B
                // occupies the name, instead of being rebound to B.
                if (!existing || existingMatchesPayload || active) {
                    try {
                        await assertRecoveryInstanceUnderLock(normalized);
                    }
                    catch {
                        return { kind: 'blocked', recoveryId: existing?.recovery_id ?? '' };
                    }
                }
                const admission = await withRecoveryAdmissionLock(normalized.cwd, canonicalRecoveryPayloadHash(payload), () => {
                    return active
                        ? aliasActiveRecoveryRequest(normalized.cwd, requestId, payload, active)
                        : reserveRecoveryRequest(normalized.cwd, requestId, payload);
                });
                if (admission.kind === 'conflict')
                    return { kind: 'conflict', admission };
                const canonical = resolveCanonicalReservation(normalized.cwd, admission.reservation);
                if (canonical.instance_id.toLowerCase() !== normalized.instanceId) {
                    throw new Error('invalid_persisted_state');
                }
                const prior = readRecoveryOutcome(normalized.cwd, canonical.request_id);
                const priorFinalState = readRecoveryFinalState(normalized.cwd, canonical.request_id);
                if (priorFinalState.kind === 'invalid')
                    throw new Error('invalid_persisted_state');
                if (isMatchingRecoveryFinal(prior, { requestId: canonical.request_id, recoveryId: canonical.recovery_id,
                    teamName: normalized.teamName, workerName: normalized.workerName })) {
                    return { kind: 'final', result: prior.result };
                }
                const canonicalInput = { ...normalized, requestId: canonical.request_id };
                if (timing.persistentOwnerBootstrap) {
                    const state = await teamRecoveryState(normalized.cwd, normalized.teamName);
                    if (state !== 'v2') {
                        const result = terminalResult(canonicalInput, canonical.recovery_id, state);
                        return { kind: 'final', result: persistTerminalResult(canonicalInput, canonical.recovery_id, result) };
                    }
                }
                await publishIntent(canonicalInput, canonical.recovery_id);
                return { kind: 'pending', admission, canonical, canonicalInput };
            });
            if (admitted.kind === 'blocked') {
                return timeoutResult(normalized, admitted.recoveryId);
            }
            if (admitted.kind === 'terminal')
                return admitted.result;
            if (admitted.kind === 'conflict') {
                return { outcome: 'failed', committed: false, error: 'recovery_attempt_conflict', requestId,
                    recoveryId: admitted.admission.reservation.recovery_id, teamName: normalized.teamName, workerName: normalized.workerName,
                    updatedAt: new Date().toISOString(), message: 'Request ID is already reserved for a different recovery payload.' };
            }
            if (admitted.kind === 'final')
                return admitted.result;
            const { admission, canonical, canonicalInput } = admitted;
            const outcomeRequestId = canonical.request_id;
            if (timing.persistentOwnerBootstrap) {
                const state = await teamRecoveryState(normalized.cwd, normalized.teamName);
                let ownerReady = false;
                if (state === 'v2') {
                    const availability = ownerAvailability(normalized.cwd, normalized.teamName);
                    if (availability === 'unknown')
                        ownerReady = null;
                    else if (availability === 'live')
                        ownerReady = true;
                    else {
                        let priorEpoch = null;
                        try {
                            priorEpoch = readLatestOwnerEpoch(normalized.cwd, normalized.teamName)?.epoch ?? null;
                        }
                        catch {
                            priorEpoch = null;
                        }
                        const bootstrapOwner = timing.bootstrapOwner ?? bootstrapPersistentOwner;
                        // Custom test/integration hooks do not perform the child election
                        // handshake; still preflight their intended instance before any
                        // callback effect.  The real bootstrap acquires the lifecycle lock
                        // only for setup, then waits outside it.
                        if (bootstrapOwner !== bootstrapPersistentOwner) {
                            try {
                                const binding = recoveryInstanceBinding(canonicalInput);
                                ownerReady = await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
                                    await assertRecoveryInstanceUnderLock(canonicalInput);
                                    return bootstrapOwner(canonicalInput, priorEpoch);
                                });
                            }
                            catch {
                                ownerReady = false;
                            }
                        }
                        else {
                            ownerReady = await bootstrapOwner(canonicalInput, priorEpoch);
                        }
                    }
                }
                // Bootstrap publication/rebind is intentionally transient. A child may have
                // published the immutable successor epoch but lost its config CAS; the same
                // canonical request must remain replayable rather than being terminalized.
                if (ownerReady === null || ownerReady === false) {
                    // Leave the intent/reservation intact and wait for a subsequent owner or retry.
                }
            }
            else if (admission.kind === 'created') {
                void (async () => {
                    if (!await assertRecoveryInstance(canonicalInput))
                        return;
                    await dispatch(canonicalInput);
                })().catch(() => {
                    // The durable intent remains pending for the persistent owner to retry.
                });
            }
            const deadline = Date.now() + normalized.timeoutMs;
            while (Date.now() < deadline) {
                const outcome = readRecoveryOutcome(normalized.cwd, outcomeRequestId);
                const finalState = readRecoveryFinalState(normalized.cwd, outcomeRequestId);
                if (finalState.kind === 'invalid')
                    throw new Error('invalid_persisted_state');
                if (isMatchingRecoveryFinal(outcome, { requestId: outcomeRequestId, recoveryId: canonical.recovery_id,
                    teamName: normalized.teamName, workerName: normalized.workerName }))
                    return outcome.result;
                await new Promise(resolve => setTimeout(resolve, timing.pollIntervalMs ?? 250));
            }
            return timeoutResult(normalized, canonical.recovery_id);
        },
    };
}
let installedRecoveryOwnerDispatch;
/** Install the long-lived owner dispatcher without coupling the public client to runtime-cli startup. */
export function setRuntimeOwnerDispatch(dispatch) {
    installedRecoveryOwnerDispatch = dispatch;
}
/**
 * Stable named client used by runtime-v2. Admission is durable and dispatch is
 * non-recursive: the runtime owner invokes the private executor, never the
 * public recoverDeadWorkerV2 facade.
 */
export async function requestRuntimeOwnerRecovery(input) {
    const dispatch = installedRecoveryOwnerDispatch ?? (async (ownerInput) => {
        const reservation = readRecoveryRequestReservation(ownerInput.cwd, ownerInput.requestId);
        return timeoutResult(ownerInput, reservation?.recovery_id ?? '');
    });
    return createRecoveryOwnerClient(dispatch, { persistentOwnerBootstrap: !installedRecoveryOwnerDispatch }).recoverDeadWorker(input);
}
//# sourceMappingURL=runtime-owner-client.js.map