/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { startTeam, monitorTeam, shutdownTeam } from './runtime.js';
import { appendTeamEvent } from './events.js';
import { deriveTeamLeaderGuidance } from './leader-nudge-guidance.js';
import { waitForSentinelReadiness } from './sentinel-gate.js';
import { isRuntimeV2Enabled, startTeamV2, monitorTeamV2, shutdownTeamV2, executeRecoverDeadWorkerV2Owner, prepareRecoveryOwnerBootstrap, reconcileCommittedTeamServices } from './runtime-v2.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import { parseRecoveryIntent, setRuntimeOwnerDispatch } from './runtime-owner-client.js';
import { absPath, TeamPaths } from './state-paths.js';
import { canonicalRecoveryPayloadHash, isSafeRecoveryRequestId, readRecoveryFinalState, readRecoveryOutcome, readRecoveryRequestReservation } from './recovery-request-store.js';
import { runWorkerActivationGate } from './worker-activation-gate.js';
import { readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { checkOwnerFence, currentProcessStartIdentity, requireOwnerProcessIdentity } from './team-owner-epoch.js';
/**
 * Retain startup panes for explicit cleanup, but include committed recovery
 * replacements from the revisioned config before publishing cleanup evidence.
 */
export async function refreshRuntimeWorkerPaneIds(runtime, teamName, cwd) {
    const current = await readRevisionedTeamConfig(teamName, cwd);
    if (!current)
        return null;
    const authoritativePaneIds = current.config.workers
        .map(worker => worker.pane_id)
        .filter((paneId) => typeof paneId === 'string' && paneId.length > 0);
    runtime.workerPaneIds = [...new Set([...runtime.workerPaneIds, ...authoritativePaneIds])];
    return {
        authoritativePaneIds,
        allWorkerPaneIdsKnown: authoritativePaneIds.length === current.config.workers.length,
    };
}
export function classifyAllDeadRecoveryEvidence(refresh, workers, hasOutstanding) {
    if (!hasOutstanding)
        return 'clear';
    if (!refresh.allWorkerPaneIdsKnown || refresh.authoritativePaneIds.length === 0
        || workers.length !== refresh.authoritativePaneIds.length)
        return 'unknown';
    if (workers.some(worker => worker.liveness === 'alive'))
        return 'alive';
    if (workers.some(worker => worker.liveness === 'unknown'))
        return 'unknown';
    return hasOutstanding && workers.every(worker => worker.liveness === 'dead') ? 'all_dead' : 'unknown';
}
export function areAllAuthoritativeWorkersDead(refresh, workers) {
    return classifyAllDeadRecoveryEvidence(refresh, workers, true) === 'all_dead';
}
function validateCanonicalRecoveryIntent(teamName, cwd, pathRecoveryId, path) {
    const intent = parseRecoveryIntent(readFileSync(path, 'utf8'));
    if (intent.team_name !== teamName || intent.recovery_id !== pathRecoveryId)
        throw new Error('invalid_persisted_state');
    const reservation = readRecoveryRequestReservation(cwd, intent.request_id);
    const workspaceHash = createHash('sha256').update(cwd).digest('hex');
    const expectedPayloadHash = canonicalRecoveryPayloadHash({ operation: 'recover-worker', workspaceHash,
        teamName: intent.team_name, workerName: intent.worker_name });
    if (!reservation || reservation.kind !== 'reservation' || reservation.operation !== intent.operation
        || reservation.request_id !== intent.request_id || reservation.recovery_id !== intent.recovery_id
        || reservation.team_name !== intent.team_name || reservation.worker_name !== intent.worker_name
        || reservation.workspace_hash !== workspaceHash || intent.workspace_hash !== workspaceHash
        || reservation.payload_hash !== expectedPayloadHash || intent.payload_hash !== expectedPayloadHash) {
        throw new Error('invalid_persisted_state');
    }
    return intent;
}
/** Private owner dispatch entry point used by durable recovery admission. */
export async function handleRecoverDeadWorkerV2Owner(input, execute = executeRecoverDeadWorkerV2Owner) {
    const reservation = readRecoveryRequestReservation(input.cwd, input.requestId);
    if (!reservation || reservation.kind !== 'reservation')
        throw new Error('invalid_persisted_state');
    const path = absPath(input.cwd, TeamPaths.recoveryIntent(input.teamName, reservation.recovery_id));
    const intent = validateCanonicalRecoveryIntent(input.teamName, input.cwd, reservation.recovery_id, path);
    if (intent.request_id !== input.requestId || intent.worker_name !== input.workerName)
        throw new Error('invalid_persisted_state');
    return execute(input);
}
export async function processPendingRecoveryIntents(teamName, cwd, execute = handleRecoverDeadWorkerV2Owner) {
    const root = absPath(cwd, TeamPaths.recoveryIntents(teamName));
    let names;
    try {
        names = readdirSync(root).filter(name => name.endsWith('.json')).sort();
    }
    catch {
        return;
    }
    for (const name of names) {
        const path = join(root, name);
        try {
            const pathRecoveryId = basename(name, '.json');
            const intent = validateCanonicalRecoveryIntent(teamName, cwd, pathRecoveryId, path);
            const finalState = readRecoveryFinalState(cwd, intent.request_id);
            if (finalState.kind === 'invalid')
                throw new Error('invalid_persisted_state');
            let outcome = readRecoveryOutcome(cwd, intent.request_id);
            if (!outcome || outcome.kind !== 'final') {
                await execute({ teamName, cwd, workerName: intent.worker_name, requestId: intent.request_id });
                outcome = readRecoveryOutcome(cwd, intent.request_id);
            }
            if (outcome?.kind === 'final' && outcome.request_id === intent.request_id
                && outcome.recovery_id === intent.recovery_id && outcome.team_name === intent.team_name
                && outcome.worker_name === intent.worker_name) {
                await unlink(path).catch(() => undefined);
            }
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery intent ${name} failed: ${error}\n`);
        }
    }
}
export async function updateAllDeadRecoveryGrace(teamName, cwd, evidence, nowMs = Date.now()) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await readRevisionedTeamConfig(teamName, cwd);
        if (!current)
            return { deadlineAt: null, expired: false };
        const existingDeadline = Date.parse(current.config.all_dead_recovery?.deadline_at ?? '');
        if (evidence === 'unknown') {
            return { deadlineAt: Number.isFinite(existingDeadline) ? existingDeadline : null, expired: false };
        }
        if (evidence === 'all_dead' && Number.isFinite(existingDeadline)) {
            return { deadlineAt: existingDeadline, expired: nowMs >= existingDeadline };
        }
        if ((evidence === 'alive' || evidence === 'clear') && !current.config.all_dead_recovery)
            return { deadlineAt: null, expired: false };
        const nextRevision = current.stateRevision + 1;
        const deadlineAt = nowMs + 300_000;
        const nextConfig = { ...current.config, state_revision: nextRevision,
            all_dead_recovery: evidence === 'all_dead'
                ? { detected_at: new Date(nowMs).toISOString(), deadline_at: new Date(deadlineAt).toISOString(), state_revision: nextRevision }
                : undefined };
        if (await saveTeamConfigAtRevision(nextConfig, current.stateRevision, cwd)) {
            return { deadlineAt: evidence === 'all_dead' ? deadlineAt : null, expired: false };
        }
    }
    throw new Error('stale_state_revision');
}
function canonicalRecoveryIntentEntryId(name, path) {
    if (!name.endsWith('.json'))
        return null;
    const recoveryId = basename(name, '.json');
    if (name !== `${recoveryId}.json` || !isSafeRecoveryRequestId(recoveryId))
        return null;
    try {
        return lstatSync(path).isFile() ? recoveryId : null;
    }
    catch {
        return null;
    }
}
function hasVerifiedTerminalRepairForMalformedIntent(teamName, cwd, recoveryId, path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw.team_name !== teamName || raw.recovery_id !== recoveryId
            || typeof raw.request_id !== 'string' || !isSafeRecoveryRequestId(raw.request_id)
            || typeof raw.worker_name !== 'string' || raw.worker_name.length === 0)
            return false;
        const final = readRecoveryFinalState(cwd, raw.request_id);
        return final.kind === 'valid' && final.final.recovery_id === recoveryId
            && final.final.team_name === teamName && final.final.worker_name === raw.worker_name;
    }
    catch {
        return false;
    }
}
function malformedIntentMayPredateDeadline(path, deadlineAt) {
    try {
        const metadata = lstatSync(path);
        // mtime can establish that a record is old, but cannot prove that an
        // otherwise unverifiable record was created after the deadline.
        if (Number.isFinite(metadata.mtimeMs) && metadata.mtimeMs <= deadlineAt)
            return true;
        // Only a filesystem creation timestamp can make a malformed record
        // clearly new; any unavailable or ambiguous timestamp fails closed.
        if (Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0) {
            return metadata.birthtimeMs <= deadlineAt;
        }
        return true;
    }
    catch {
        return true;
    }
}
function canonicalRecoveryAdmissionEntryId(name, path) {
    if (!name.endsWith('.pending.json'))
        return null;
    const requestId = name.slice(0, -'.pending.json'.length);
    if (name !== `${requestId}.pending.json` || !isSafeRecoveryRequestId(requestId))
        return null;
    try {
        return lstatSync(path).isFile() ? requestId : null;
    }
    catch {
        return null;
    }
}
function malformedAdmissionMayPredateDeadline(path, deadlineAt) {
    try {
        const metadata = lstatSync(path);
        if (!metadata.isFile())
            return true;
        // An old mtime proves the admission predated the deadline. A later mtime
        // may be a repair or corruption touch, so only a trustworthy birthtime
        // strictly after the deadline can prove it is new.
        if (Number.isFinite(metadata.mtimeMs) && metadata.mtimeMs <= deadlineAt)
            return true;
        if (Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0) {
            return metadata.birthtimeMs <= deadlineAt;
        }
        return true;
    }
    catch {
        return true;
    }
}
export function hasPendingRecoveryIntentBeforeDeadline(teamName, cwd, deadlineAt) {
    const root = absPath(cwd, TeamPaths.recoveryIntents(teamName));
    let names;
    try {
        names = readdirSync(root).filter(name => name.endsWith('.json'));
    }
    catch {
        return false;
    }
    for (const name of names) {
        const path = join(root, name);
        const recoveryId = canonicalRecoveryIntentEntryId(name, path);
        if (!recoveryId)
            continue;
        try {
            const intent = validateCanonicalRecoveryIntent(teamName, cwd, recoveryId, path);
            const createdAt = Date.parse(intent.created_at);
            const outcome = readRecoveryOutcome(cwd, intent.request_id);
            if (createdAt <= deadlineAt && (!outcome || outcome.kind !== 'final'))
                return true;
        }
        catch {
            if (malformedIntentMayPredateDeadline(path, deadlineAt)
                && !hasVerifiedTerminalRepairForMalformedIntent(teamName, cwd, recoveryId, path))
                return true;
        }
    }
    return false;
}
export function hasPendingRecoveryAdmissionBeforeDeadline(teamName, cwd, deadlineAt) {
    const workspaceHash = createHash('sha256').update(cwd).digest('hex');
    const root = absPath(cwd, TeamPaths.recoveryRequestsRoot());
    let names;
    try {
        names = readdirSync(root).filter(name => name.endsWith('.pending.json'));
    }
    catch {
        return false;
    }
    for (const name of names) {
        const path = join(root, name);
        const requestId = canonicalRecoveryAdmissionEntryId(name, path);
        if (!requestId)
            continue;
        try {
            const reservation = readRecoveryRequestReservation(cwd, requestId);
            if (!reservation)
                throw new Error('invalid_persisted_state');
            if (reservation.team_name !== teamName || reservation.workspace_hash !== workspaceHash
                || Date.parse(reservation.created_at) > deadlineAt)
                continue;
            const outcome = readRecoveryOutcome(cwd, requestId);
            if (!outcome || outcome.kind !== 'final')
                return true;
        }
        catch {
            // Only a fully validated reservation can establish that this canonical
            // entry belongs to another team or workspace. An invalid tuple/hash is
            // indistinguishable from a corrupted predeadline local admission.
            if (malformedAdmissionMayPredateDeadline(path, deadlineAt))
                return true;
        }
    }
    return false;
}
export async function fenceAllDeadRecoveryExpiry(teamName, cwd, deadlineAt) {
    const workspaceHash = createHash('sha256').update(cwd).digest('hex');
    return withProcessIdentityFileLock(absPath(cwd, TeamPaths.recoveryLifecycleLock(workspaceHash, teamName)), async () => {
        const current = await readRevisionedTeamConfig(teamName, cwd);
        if (!current || Date.parse(current.config.all_dead_recovery?.deadline_at ?? '') !== deadlineAt
            || Date.now() < deadlineAt || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped')
            return false;
        if (hasPendingRecoveryAdmissionBeforeDeadline(teamName, cwd, deadlineAt)
            || hasPendingRecoveryIntentBeforeDeadline(teamName, cwd, deadlineAt))
            return false;
        const nextRevision = current.stateRevision + 1;
        return saveTeamConfigAtRevision({ ...current.config, lifecycle_state: 'shutting_down', all_dead_recovery: undefined,
            state_revision: nextRevision }, current.stateRevision, cwd);
    });
}
function ownsPersistentRecoveryFence(input, fence, expectedEpoch) {
    if (expectedEpoch !== undefined && fence.epoch !== expectedEpoch)
        return false;
    const owner = checkOwnerFence(input.cwd, input.teamName, fence);
    if (!owner.ok || owner.record.pid !== process.pid || owner.record.process_started_at !== currentProcessStartIdentity())
        return false;
    try {
        requireOwnerProcessIdentity(owner.record);
    }
    catch {
        return false;
    }
    return true;
}
/**
 * Keep a detached successor alive as a normal v2 owner. It never starts a
 * team: it drains durable recovery intent, reconciles durable services, and
 * maintains persisted all-dead grace while its exact epoch is authoritative.
 */
export async function runPersistentRecoveryOwnerLoop(input, options = {}) {
    const execute = options.execute ?? handleRecoverDeadWorkerV2Owner;
    const processIntents = options.processIntents ?? processPendingRecoveryIntents;
    const reconcileServices = options.reconcileServices ?? reconcileCommittedTeamServices;
    const monitor = options.monitor ?? monitorTeamV2;
    const sleep = options.sleep ?? (async (ms) => { await new Promise(resolve => setTimeout(resolve, ms)); });
    const shutdown = options.shutdown ?? shutdownTeamV2;
    let iteration = 0;
    let bootstrapBindingRequired = Boolean(input.bootstrap);
    let bootstrapPending = true;
    while (options.shouldContinue?.(iteration) ?? true) {
        let current;
        try {
            current = await readRevisionedTeamConfig(input.teamName, input.cwd);
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery owner config maintenance failed: ${error}\n`);
            await sleep(options.pollIntervalMs ?? 250);
            continue;
        }
        if (!current || current.config.lifecycle_state === 'stopped')
            return;
        const configured = current.config.runtime_owner_epoch;
        if (!configured || (options.expectedEpoch !== undefined && configured.epoch !== options.expectedEpoch)
            || (input.bootstrap && (configured.pid !== input.bootstrap.pid || configured.process_started_at !== input.bootstrap.processStartedAt
                || configured.nonce !== input.bootstrap.nonce)))
            return;
        const activeRecovery = current.config.active_recovery;
        if (bootstrapBindingRequired && input.bootstrap && (configured.epoch !== input.bootstrap.expectedEpoch || configured.nonce !== input.bootstrap.nonce
            || configured.pid !== input.bootstrap.pid || configured.process_started_at !== input.bootstrap.processStartedAt
            || activeRecovery?.request_id !== input.requestId || activeRecovery?.recovery_id !== input.bootstrap.recoveryId
            || activeRecovery?.worker_name !== input.workerName || activeRecovery?.owner_epoch !== configured.epoch
            || activeRecovery?.owner_nonce !== configured.nonce))
            return;
        const fence = { epoch: configured.epoch, nonce: configured.nonce };
        const fenceOwned = options.verifyFence?.(input, fence, options.expectedEpoch)
            ?? ownsPersistentRecoveryFence(input, fence, options.expectedEpoch);
        if (!fenceOwned)
            return;
        if (current.config.lifecycle_state === 'shutting_down') {
            try {
                await shutdown(input.teamName, input.cwd, { force: true });
            }
            catch (error) {
                process.stderr.write(`[runtime-cli/v2] recovery owner terminal cleanup failed: ${error}\n`);
            }
            iteration += 1;
            if (!(options.shouldContinue?.(iteration) ?? true))
                return;
            await sleep(options.pollIntervalMs ?? 250);
            continue;
        }
        if (bootstrapPending) {
            bootstrapPending = false;
            try {
                await execute(input);
                const afterBootstrap = await readRevisionedTeamConfig(input.teamName, input.cwd);
                const afterActive = afterBootstrap?.config.active_recovery;
                if (afterBootstrap?.config.runtime_owner_epoch?.epoch === fence.epoch
                    && afterBootstrap.config.runtime_owner_epoch.nonce === fence.nonce
                    && (!afterActive || afterActive.request_id !== input.requestId || afterActive.recovery_id !== input.bootstrap?.recoveryId)) {
                    bootstrapBindingRequired = false;
                }
            }
            catch (error) {
                process.stderr.write(`[runtime-cli/v2] recovery owner bootstrap intent failed: ${error}\n`);
            }
        }
        try {
            await reconcileServices(current.config, input.cwd);
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery owner service maintenance failed: ${error}\n`);
        }
        try {
            await processIntents(input.teamName, input.cwd);
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery owner intent maintenance failed: ${error}\n`);
        }
        let afterIntents;
        try {
            afterIntents = await readRevisionedTeamConfig(input.teamName, input.cwd);
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery owner config maintenance failed: ${error}\n`);
            await sleep(options.pollIntervalMs ?? 250);
            continue;
        }
        if (!afterIntents || afterIntents.config.lifecycle_state === 'stopped')
            return;
        const afterOwner = afterIntents.config.runtime_owner_epoch;
        const afterActive = afterIntents.config.active_recovery;
        if (bootstrapBindingRequired && input.bootstrap && afterOwner?.epoch === fence.epoch
            && afterOwner.nonce === fence.nonce && afterOwner.pid === input.bootstrap.pid
            && afterOwner.process_started_at === input.bootstrap.processStartedAt
            && (!afterActive || afterActive.request_id !== input.requestId || afterActive.recovery_id !== input.bootstrap.recoveryId)) {
            bootstrapBindingRequired = false;
        }
        if (afterOwner?.epoch !== fence.epoch || afterOwner?.nonce !== fence.nonce
            || (input.bootstrap && (afterOwner?.pid !== input.bootstrap.pid || afterOwner?.process_started_at !== input.bootstrap.processStartedAt
                || afterOwner?.nonce !== input.bootstrap.nonce))
            || (bootstrapBindingRequired && input.bootstrap && (afterActive?.request_id !== input.requestId || afterActive?.recovery_id !== input.bootstrap.recoveryId
                || afterActive?.owner_epoch !== afterOwner?.epoch || afterActive?.owner_nonce !== afterOwner?.nonce))
            || !(options.verifyFence?.(input, fence, options.expectedEpoch)
                ?? ownsPersistentRecoveryFence(input, fence, options.expectedEpoch)))
            return;
        if (afterIntents.config.lifecycle_state === 'shutting_down') {
            try {
                await shutdown(input.teamName, input.cwd, { force: true });
            }
            catch (error) {
                process.stderr.write(`[runtime-cli/v2] recovery owner terminal cleanup failed: ${error}\n`);
            }
            iteration += 1;
            if (!(options.shouldContinue?.(iteration) ?? true))
                return;
            await sleep(options.pollIntervalMs ?? 250);
            continue;
        }
        const panes = afterIntents.config.workers.map(worker => worker.pane_id).filter((pane) => Boolean(pane));
        const refresh = { authoritativePaneIds: panes, allWorkerPaneIdsKnown: panes.length === afterIntents.config.workers.length };
        let snapshot = null;
        try {
            snapshot = await monitor(input.teamName, input.cwd);
        }
        catch (error) {
            process.stderr.write(`[runtime-cli/v2] recovery owner monitor maintenance failed: ${error}\n`);
        }
        if (snapshot) {
            const outstanding = snapshot.tasks.pending + snapshot.tasks.in_progress > 0;
            const evidence = classifyAllDeadRecoveryEvidence(refresh, snapshot.workers, outstanding);
            try {
                const grace = await updateAllDeadRecoveryGrace(input.teamName, input.cwd, evidence);
                if (evidence === 'all_dead' && grace.expired && grace.deadlineAt !== null) {
                    await fenceAllDeadRecoveryExpiry(input.teamName, input.cwd, grace.deadlineAt);
                }
            }
            catch (error) {
                process.stderr.write(`[runtime-cli/v2] recovery owner all-dead maintenance failed: ${error}\n`);
            }
        }
        iteration += 1;
        if (!(options.shouldContinue?.(iteration) ?? true))
            return;
        await sleep(options.pollIntervalMs ?? 250);
    }
}
export function assertAutoMergeRuntimeSupported(useV2, autoMerge) {
    if (autoMerge && !useV2) {
        throw new Error('--auto-merge requires runtime v2; unset OMC_RUNTIME_V2=0 or disable --auto-merge');
    }
}
export function getTerminalStatus(taskCounts, expectedTaskCount) {
    const active = taskCounts.pending + taskCounts.inProgress;
    const terminal = taskCounts.completed + taskCounts.failed;
    if (active !== 0 || terminal !== expectedTaskCount)
        return null;
    return taskCounts.failed > 0 ? 'failed' : 'completed';
}
function parseWatchdogFailedAt(marker) {
    if (typeof marker.failedAt === 'number')
        return marker.failedAt;
    if (typeof marker.failedAt === 'string') {
        const numeric = Number(marker.failedAt);
        if (Number.isFinite(numeric))
            return numeric;
        const parsed = Date.parse(marker.failedAt);
        if (Number.isFinite(parsed))
            return parsed;
    }
    throw new Error('watchdog marker missing valid failedAt');
}
export async function checkWatchdogFailedMarker(stateRoot, startTime) {
    const markerPath = join(stateRoot, 'watchdog-failed.json');
    let raw;
    try {
        raw = await readFile(markerPath, 'utf-8');
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return { failed: false };
        return { failed: true, reason: `Failed to read watchdog marker: ${err}` };
    }
    let marker;
    try {
        marker = JSON.parse(raw);
    }
    catch (err) {
        return { failed: true, reason: `Failed to parse watchdog marker: ${err}` };
    }
    let failedAt;
    try {
        failedAt = parseWatchdogFailedAt(marker);
    }
    catch (err) {
        return { failed: true, reason: `Invalid watchdog marker: ${err}` };
    }
    if (failedAt >= startTime) {
        return { failed: true, reason: `Watchdog marked team failed at ${new Date(failedAt).toISOString()}` };
    }
    try {
        await unlink(markerPath);
    }
    catch {
        // best-effort stale marker cleanup
    }
    return { failed: false };
}
export async function writeResultArtifact(output, finishedAt, jobId = process.env.OMC_JOB_ID, omcJobsDir = process.env.OMC_JOBS_DIR) {
    if (!jobId || !omcJobsDir)
        return;
    const resultPath = join(omcJobsDir, `${jobId}-result.json`);
    const tmpPath = `${resultPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ ...output, finishedAt }), 'utf-8');
    await rename(tmpPath, resultPath);
}
export function buildCliOutput(stateRoot, teamName, status, workerCount, startTimeMs) {
    const taskResults = collectTaskResults(stateRoot);
    const duration = (Date.now() - startTimeMs) / 1000;
    return {
        status,
        teamName,
        taskResults,
        duration,
        workerCount,
    };
}
export function buildTerminalCliResult(stateRoot, teamName, phase, workerCount, startTimeMs) {
    const status = phase === 'complete' ? 'completed' : 'failed';
    return {
        output: buildCliOutput(stateRoot, teamName, status, workerCount, startTimeMs),
        exitCode: status === 'completed' ? 0 : 1,
        notice: `[runtime-cli] phase=${phase} reached terminal state; preserving team state for inspection. Run "omc team shutdown ${teamName}" when explicit cleanup is desired.\n`,
    };
}
async function writePanesFile(jobId, paneIds, leaderPaneId, sessionName, ownsWindow) {
    const omcJobsDir = process.env.OMC_JOBS_DIR;
    if (!jobId || !omcJobsDir)
        return;
    const panesPath = join(omcJobsDir, `${jobId}-panes.json`);
    await writeFile(panesPath + '.tmp', JSON.stringify({ paneIds: [...paneIds], leaderPaneId, sessionName, ownsWindow }));
    await rename(panesPath + '.tmp', panesPath);
}
const MAX_FALLBACK_SUMMARY_CHARS = 2000;
/**
 * A task "final" is terse when it carries no substantive content: empty/
 * whitespace, or a bare acknowledgement like "Done." / "Ready." / "OK".
 * Such finals hide the real work that lives in the task's `.output` file,
 * so they are candidates for substitution. Anything else is treated as a
 * substantive final and preserved as-is.
 */
export function isTerseFinalSummary(summary) {
    const trimmed = summary.trim();
    if (trimmed.length === 0)
        return true;
    const normalized = trimmed.toLowerCase().replace(/[\s.!]+$/g, '');
    const TERSE_ACKS = new Set([
        'done',
        'ready',
        'ok',
        'okay',
        'complete',
        'completed',
        'finished',
        'success',
        'all done',
        'task complete',
        'task completed',
    ]);
    return TERSE_ACKS.has(normalized);
}
/**
 * Locate the newest `.output` file recorded for a task under the team's
 * outputs directory and return its (bounded) content. Returns null when no
 * non-empty output file exists. Best-effort: never throws.
 */
export function readTaskOutputFallback(outputsDir, teamName, taskId) {
    let entries;
    try {
        entries = readdirSync(outputsDir);
    }
    catch {
        return null;
    }
    const prefix = `team-${teamName}-task-${taskId}-`;
    const candidates = entries.filter(f => f.startsWith(prefix) && f.endsWith('.md'));
    if (candidates.length === 0)
        return null;
    let newest = null;
    for (const name of candidates) {
        const full = join(outputsDir, name);
        try {
            const mtime = statSync(full).mtimeMs;
            if (!newest || mtime > newest.mtime)
                newest = { path: full, mtime };
        }
        catch {
            // skip unreadable entry
        }
    }
    if (!newest)
        return null;
    try {
        const content = readFileSync(newest.path, 'utf-8').trim();
        if (content.length === 0)
            return null;
        return content.length > MAX_FALLBACK_SUMMARY_CHARS
            ? content.slice(0, MAX_FALLBACK_SUMMARY_CHARS) + '\n... (truncated)'
            : content;
    }
    catch {
        return null;
    }
}
function collectTaskResults(stateRoot) {
    const tasksDir = join(stateRoot, 'tasks');
    const teamName = basename(stateRoot);
    // stateRoot is `<omcRoot>/state/team/<teamName>`; outputs live at `<omcRoot>/outputs`.
    const outputsDir = join(stateRoot, '..', '..', '..', 'outputs');
    try {
        const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                const raw = readFileSync(join(tasksDir, f), 'utf-8');
                const task = JSON.parse(raw);
                const taskId = task.id ?? f.replace('.json', '');
                let summary = (task.result ?? task.summary) ?? '';
                if (isTerseFinalSummary(summary)) {
                    const fallback = readTaskOutputFallback(outputsDir, teamName, taskId);
                    if (fallback)
                        summary = fallback;
                }
                return {
                    taskId,
                    status: task.status ?? 'unknown',
                    summary,
                };
            }
            catch {
                return { taskId: f.replace('.json', ''), status: 'unknown', summary: '' };
            }
        });
    }
    catch {
        return [];
    }
}
async function stopLegacyWatchdog(runtime, useV2) {
    if (!useV2 && runtime?.stopWatchdog) {
        await runtime.stopWatchdog();
    }
}
/**
 * Preserve watchdog quiescence before capturing terminal output, then tear down
 * the team and publish that immutable snapshot. Shutdown may remove v1 state.
 */
export async function finalizeRuntimeShutdown(runtime, useV2, collectOutput, shutdown, publishOutput) {
    await stopLegacyWatchdog(runtime, useV2);
    const output = await collectOutput();
    await shutdown();
    await publishOutput(output);
    return output;
}
async function main() {
    const startTime = Date.now();
    const logLeaderNudgeEventFailure = createSwallowedErrorLogger('team.runtime-cli main appendTeamEvent failed');
    // Read stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const rawInput = Buffer.concat(chunks).toString('utf-8').trim();
    let input;
    try {
        input = JSON.parse(rawInput);
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}\n`);
        process.exit(1);
    }
    // Validate required fields
    const missing = [];
    if (!input.teamName)
        missing.push('teamName');
    if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0)
        missing.push('agentTypes');
    if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0)
        missing.push('tasks');
    if (!input.cwd)
        missing.push('cwd');
    if (missing.length > 0) {
        process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(', ')}\n`);
        process.exit(1);
    }
    const { teamName, agentTypes, tasks, cwd, newWindow = false, pollIntervalMs = 5000, sentinelGateTimeoutMs = 30_000, sentinelGatePollIntervalMs = 250, autoMerge = false, } = input;
    const workerCount = input.workerCount ?? agentTypes.length;
    const stateRoot = join(cwd, `.omc/state/team/${teamName}`);
    const config = {
        teamName,
        workerCount,
        agentTypes: agentTypes,
        tasks,
        cwd,
        newWindow,
    };
    const useV2 = isRuntimeV2Enabled();
    try {
        assertAutoMergeRuntimeSupported(useV2, autoMerge);
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
    let runtime = null;
    let finalStatus = 'failed';
    let pollActive = true;
    async function doShutdown(status) {
        pollActive = false;
        finalStatus = status;
        const output = await finalizeRuntimeShutdown(runtime, useV2, async () => buildCliOutput(stateRoot, teamName, finalStatus, workerCount, startTime), async () => {
            if (!runtime)
                return;
            try {
                if (useV2) {
                    await shutdownTeamV2(runtime.teamName, runtime.cwd, { force: true });
                }
                else {
                    await shutdownTeam(runtime.teamName, runtime.sessionName, runtime.cwd, 2_000, runtime.workerPaneIds, runtime.leaderPaneId, runtime.ownsWindow);
                }
            }
            catch (err) {
                process.stderr.write(`[runtime-cli] shutdown error: ${err}\n`);
            }
        }, async (publishedOutput) => {
            const finishedAt = new Date().toISOString();
            try {
                await writeResultArtifact(publishedOutput, finishedAt);
            }
            catch (err) {
                process.stderr.write(`[runtime-cli] Failed to persist result artifact: ${err}\n`);
            }
        });
        // 3. Write result to stdout
        process.stdout.write(JSON.stringify(output) + '\n');
        // 4. Exit
        process.exit(status === 'completed' ? 0 : 1);
    }
    function exitWithoutShutdown(phase) {
        pollActive = false;
        finalStatus = phase === 'complete' ? 'completed' : 'failed';
        const result = buildTerminalCliResult(stateRoot, teamName, phase, workerCount, startTime);
        process.stderr.write(result.notice);
        process.stdout.write(JSON.stringify(result.output) + '\n');
        process.exit(result.exitCode);
    }
    // Register signal handlers before poll loop
    process.on('SIGINT', () => {
        process.stderr.write('[runtime-cli] Received SIGINT, shutting down...\n');
        doShutdown('failed').catch(() => process.exit(1));
    });
    process.on('SIGTERM', () => {
        process.stderr.write('[runtime-cli] Received SIGTERM, shutting down...\n');
        doShutdown('failed').catch(() => process.exit(1));
    });
    // Start the team — v2 uses direct tmux spawn with CLI API inbox (no done.json, no watchdog)
    try {
        if (useV2) {
            const v2Runtime = await startTeamV2({
                teamName,
                workerCount,
                agentTypes,
                tasks,
                cwd,
                newWindow,
                autoMerge,
            });
            const v2PaneIds = v2Runtime.config.workers
                .map(w => w.pane_id)
                .filter((p) => typeof p === 'string');
            runtime = {
                teamName: v2Runtime.teamName,
                sessionName: v2Runtime.sessionName,
                leaderPaneId: v2Runtime.config.leader_pane_id || '',
                ownsWindow: v2Runtime.ownsWindow,
                config,
                workerNames: v2Runtime.config.workers.map(w => w.name),
                workerPaneIds: v2PaneIds,
                activeWorkers: new Map(),
                cwd,
            };
            setRuntimeOwnerDispatch(handleRecoverDeadWorkerV2Owner);
        }
        else {
            runtime = await startTeam(config);
        }
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] startTeam failed: ${err}\n`);
        process.exit(1);
    }
    // Persist pane IDs so MCP server can clean up explicitly via omc_run_team_cleanup.
    const jobId = process.env.OMC_JOB_ID;
    const expectedTaskCount = tasks.length;
    let mismatchStreak = 0;
    try {
        await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
    }
    // ── V2 event-driven poll loop (no watchdog) ────────────────────────────
    if (useV2) {
        process.stderr.write('[runtime-cli] Using runtime v2 (event-driven, no watchdog)\n');
        let lastLeaderNudgeReason = '';
        // Recovery grace is persisted in revisioned config and survives owner restart.
        while (pollActive) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            if (!pollActive)
                break;
            await processPendingRecoveryIntents(teamName, cwd);
            let paneRefresh;
            try {
                paneRefresh = await refreshRuntimeWorkerPaneIds(runtime, teamName, cwd);
            }
            catch (err) {
                process.stderr.write(`[runtime-cli/v2] Failed to read authoritative pane evidence: ${err}\n`);
                continue;
            }
            if (!paneRefresh) {
                process.stderr.write('[runtime-cli/v2] Authoritative pane evidence missing; preserving team state\n');
                continue;
            }
            let snap;
            try {
                snap = await monitorTeamV2(teamName, cwd);
            }
            catch (err) {
                process.stderr.write(`[runtime-cli/v2] monitorTeamV2 error: ${err}\n`);
                continue;
            }
            if (!snap) {
                process.stderr.write('[runtime-cli/v2] monitorTeamV2 returned null (team config missing?)\n');
                await doShutdown('failed');
                return;
            }
            try {
                await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
            }
            catch { /* best-effort panes file write */ }
            process.stderr.write(`[runtime-cli/v2] phase=${snap.phase} pending=${snap.tasks.pending} blocked=${snap.tasks.blocked} in_progress=${snap.tasks.in_progress} completed=${snap.tasks.completed} failed=${snap.tasks.failed} dead=${snap.deadWorkers.length} totalMs=${snap.performance.total_ms}\n`);
            const leaderGuidance = deriveTeamLeaderGuidance({
                tasks: {
                    pending: snap.tasks.pending,
                    blocked: snap.tasks.blocked,
                    inProgress: snap.tasks.in_progress,
                    completed: snap.tasks.completed,
                    failed: snap.tasks.failed,
                },
                workers: {
                    total: snap.workers.length,
                    alive: snap.workers.filter((worker) => worker.alive).length,
                    idle: snap.workers.filter((worker) => worker.alive && (worker.status.state === 'idle' || worker.status.state === 'done')).length,
                    nonReporting: snap.nonReportingWorkers.length,
                },
            });
            process.stderr.write(`[runtime-cli/v2] leader_next_action=${leaderGuidance.nextAction} reason=${leaderGuidance.reason}\n`);
            for (const recommendation of snap.recommendations) {
                process.stderr.write(`[runtime-cli/v2] recommendation=${recommendation}\n`);
            }
            if (leaderGuidance.nextAction === 'keep-checking-status') {
                lastLeaderNudgeReason = '';
            }
            if (leaderGuidance.nextAction !== 'keep-checking-status'
                && leaderGuidance.reason !== lastLeaderNudgeReason) {
                await appendTeamEvent(teamName, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: leaderGuidance.reason,
                    next_action: leaderGuidance.nextAction,
                    message: leaderGuidance.message,
                }, cwd).catch(logLeaderNudgeEventFailure);
                lastLeaderNudgeReason = leaderGuidance.reason;
            }
            // Terminal check via task counts
            const v2Observed = snap.tasks.pending + snap.tasks.in_progress + snap.tasks.completed + snap.tasks.failed;
            if (v2Observed !== expectedTaskCount) {
                mismatchStreak += 1;
                process.stderr.write(`[runtime-cli/v2] Task-count mismatch observed=${v2Observed} expected=${expectedTaskCount} streak=${mismatchStreak}\n`);
                if (mismatchStreak >= 2) {
                    process.stderr.write('[runtime-cli/v2] Persistent task-count mismatch — failing fast\n');
                    await doShutdown('failed');
                    return;
                }
                continue;
            }
            mismatchStreak = 0;
            if (snap.phase === 'completed') {
                exitWithoutShutdown('complete');
                return;
            }
            if (snap.phase === 'failed') {
                exitWithoutShutdown('failed');
                return;
            }
            if (snap.allTasksTerminal) {
                const hasFailures = snap.tasks.failed > 0;
                if (!hasFailures) {
                    // Sentinel gate before declaring success
                    const sentinelLogPath = join(cwd, 'sentinel_stop.jsonl');
                    const gateResult = await waitForSentinelReadiness({
                        workspace: cwd,
                        logPath: sentinelLogPath,
                        timeoutMs: sentinelGateTimeoutMs,
                        pollIntervalMs: sentinelGatePollIntervalMs,
                    });
                    if (!gateResult.ready) {
                        process.stderr.write(`[runtime-cli/v2] Sentinel gate blocked: ${gateResult.blockers.join('; ')}\n`);
                        exitWithoutShutdown('failed');
                        return;
                    }
                    exitWithoutShutdown('complete');
                }
                else {
                    process.stderr.write('[runtime-cli/v2] Terminal failure detected from task counts\n');
                    exitWithoutShutdown('failed');
                }
                return;
            }
            // An all-dead team can be resumed by a replacement owner. Keep the durable
            // state intact for the full recovery grace interval before terminal cleanup.
            const hasOutstanding = (snap.tasks.pending + snap.tasks.in_progress) > 0;
            const evidence = classifyAllDeadRecoveryEvidence(paneRefresh, snap.workers, hasOutstanding);
            const grace = await updateAllDeadRecoveryGrace(teamName, cwd, evidence);
            if (evidence === 'all_dead' && grace.expired && grace.deadlineAt !== null
                && await fenceAllDeadRecoveryExpiry(teamName, cwd, grace.deadlineAt)) {
                process.stderr.write('[runtime-cli/v2] All-worker recovery grace expired\n');
                await doShutdown('failed');
                return;
            }
        }
        return;
    }
    // ── V1 poll loop (legacy watchdog-based) ────────────────────────────────
    let allDeadSince = null;
    while (pollActive) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        if (!pollActive)
            break;
        const watchdogCheck = await checkWatchdogFailedMarker(stateRoot, startTime);
        if (watchdogCheck.failed) {
            process.stderr.write(`[runtime-cli] ${watchdogCheck.reason ?? 'Watchdog failure marker detected'}\n`);
            await doShutdown('failed');
            return;
        }
        let snap;
        try {
            snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
        }
        catch (err) {
            process.stderr.write(`[runtime-cli] monitorTeam error: ${err}\n`);
            continue;
        }
        try {
            await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
        }
        catch (err) {
            process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
        }
        process.stderr.write(`[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length} monitorMs=${snap.monitorPerformance.totalMs} tasksMs=${snap.monitorPerformance.listTasksMs} workerMs=${snap.monitorPerformance.workerScanMs}\n`);
        const observedTaskCount = snap.taskCounts.pending
            + snap.taskCounts.inProgress
            + snap.taskCounts.completed
            + snap.taskCounts.failed;
        if (observedTaskCount !== expectedTaskCount) {
            mismatchStreak += 1;
            process.stderr.write(`[runtime-cli] Task-count mismatch observed=${observedTaskCount} expected=${expectedTaskCount} streak=${mismatchStreak}\n`);
            if (mismatchStreak >= 2) {
                process.stderr.write('[runtime-cli] Persistent task-count mismatch detected — failing fast\n');
                await doShutdown('failed');
                return;
            }
            continue;
        }
        mismatchStreak = 0;
        const terminalStatus = getTerminalStatus(snap.taskCounts, expectedTaskCount);
        // Check completion — enforce sentinel readiness gate before terminal success
        if (terminalStatus === 'completed') {
            const sentinelLogPath = join(cwd, 'sentinel_stop.jsonl');
            const gateResult = await waitForSentinelReadiness({
                workspace: cwd,
                logPath: sentinelLogPath,
                timeoutMs: sentinelGateTimeoutMs,
                pollIntervalMs: sentinelGatePollIntervalMs,
            });
            if (!gateResult.ready) {
                process.stderr.write(`[runtime-cli] Sentinel gate blocked completion (timedOut=${gateResult.timedOut}, attempts=${gateResult.attempts}, elapsedMs=${gateResult.elapsedMs}): ${gateResult.blockers.join('; ')}\n`);
                await doShutdown('failed');
                return;
            }
            await doShutdown('completed');
            return;
        }
        if (terminalStatus === 'failed') {
            process.stderr.write('[runtime-cli] Terminal failure detected from task counts\n');
            await doShutdown('failed');
            return;
        }
        // Preserve durable team state for a 300s owner-recovery grace rather than
        // treating the first all-dead observation as terminal.
        const allWorkersDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
        const hasOutstandingWork = (snap.taskCounts.pending + snap.taskCounts.inProgress) > 0;
        const allDeadWithWork = allWorkersDead && (hasOutstandingWork || snap.phase === 'fixing');
        if (allDeadWithWork) {
            allDeadSince ??= Date.now();
            if (Date.now() - allDeadSince >= 300_000) {
                process.stderr.write('[runtime-cli] All-worker recovery grace expired\n');
                exitWithoutShutdown('failed');
                return;
            }
        }
        else {
            allDeadSince = null;
        }
    }
}
async function runRecoveryGateFromEnvironment() {
    const raw = process.env.OMC_RECOVERY_GATE_SPEC;
    if (!raw)
        throw new Error('OMC_RECOVERY_GATE_SPEC is required');
    const gate = JSON.parse(raw);
    const result = await runWorkerActivationGate(gate);
    if (result.outcome !== 'ran')
        throw new Error(`recovery_gate_${result.outcome}`);
    if (result.signal)
        process.kill(process.pid, result.signal);
    process.exit(result.exitCode ?? 0);
}
/** Detached durable recovery-owner entry point. It remains the persistent v2 owner until its fence or team lifecycle is lost. */
export async function runRecoveryOwnerFromEnvironment() {
    const raw = process.env.OMC_RECOVERY_OWNER_INPUT;
    if (!raw)
        throw new Error('OMC_RECOVERY_OWNER_INPUT is required');
    const input = JSON.parse(raw);
    if (typeof input.teamName !== 'string' || typeof input.cwd !== 'string' || typeof input.workerName !== 'string'
        || typeof input.requestId !== 'string')
        throw new Error('invalid_recovery_owner_input');
    const expectedEpoch = Number(process.env.OMC_RECOVERY_OWNER_EXPECTED_EPOCH);
    const predecessorEpoch = Number(process.env.OMC_RECOVERY_OWNER_PREDECESSOR_EPOCH);
    const predecessorNonce = process.env.OMC_RECOVERY_OWNER_PREDECESSOR_NONCE;
    const bootstrapNonce = process.env.OMC_RECOVERY_OWNER_NONCE;
    const predecessorPid = Number(process.env.OMC_RECOVERY_OWNER_PREDECESSOR_PID);
    const predecessorStartedAt = process.env.OMC_RECOVERY_OWNER_PREDECESSOR_STARTED_AT;
    const recoveryId = process.env.OMC_RECOVERY_OWNER_RECOVERY_ID;
    const processStartedAt = currentProcessStartIdentity();
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || !Number.isSafeInteger(predecessorEpoch)
        || predecessorEpoch < 0 || expectedEpoch !== predecessorEpoch + 1 || typeof bootstrapNonce !== 'string' || bootstrapNonce.length === 0
        || typeof recoveryId !== 'string' || recoveryId.length === 0 || !processStartedAt
        || (predecessorEpoch === 0 && (predecessorNonce || predecessorPid !== 0 || predecessorStartedAt))
        || (predecessorEpoch > 0 && (typeof predecessorNonce !== 'string' || predecessorNonce.length === 0
            || !Number.isSafeInteger(predecessorPid) || predecessorPid < 1
            || typeof predecessorStartedAt !== 'string' || predecessorStartedAt.length === 0))) {
        throw new Error('invalid_recovery_owner_bootstrap');
    }
    // This contract is process-bound before the executor can publish a successor or run maintenance.
    const bootstrap = { expectedEpoch, predecessorEpoch,
        predecessorNonce: predecessorEpoch === 0 ? null : predecessorNonce,
        predecessorPid: predecessorEpoch === 0 ? null : predecessorPid,
        predecessorProcessStartedAt: predecessorEpoch === 0 ? null : predecessorStartedAt,
        pid: process.pid, processStartedAt, nonce: bootstrapNonce, recoveryId };
    await prepareRecoveryOwnerBootstrap({ teamName: input.teamName, cwd: input.cwd, workerName: input.workerName,
        requestId: input.requestId, bootstrap });
    setRuntimeOwnerDispatch(handleRecoverDeadWorkerV2Owner);
    await runPersistentRecoveryOwnerLoop({
        teamName: input.teamName,
        cwd: input.cwd,
        workerName: input.workerName,
        requestId: input.requestId,
        bootstrap,
    }, { expectedEpoch });
}
if (require.main === module) {
    const entry = process.env.OMC_RECOVERY_OWNER_INPUT
        ? runRecoveryOwnerFromEnvironment
        : process.argv.includes('--recovery-gate') ? runRecoveryGateFromEnvironment : main;
    entry().catch(err => {
        process.stderr.write(`[runtime-cli] Fatal error: ${err}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=runtime-cli.js.map