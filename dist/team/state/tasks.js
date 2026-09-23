import { randomUUID } from 'crypto';
import { join } from 'path';
import { lstat, readFile, readdir } from 'fs/promises';
import { TASK_ID_SAFE_PATTERN } from '../contracts.js';
import { createSwallowedErrorLogger } from '../../lib/swallowed-error.js';
const logEventAppendFailure = createSwallowedErrorLogger('team.state.tasks transitionTaskStatus appendTeamEvent failed');
const logCompletionMarkerFailure = createSwallowedErrorLogger('team.state.tasks transitionTaskStatus completion marker failed');
/**
 * `depends_on` is the canonical dependency field, while `blocked_by` is kept
 * for compatibility with older task producers. Once both fields are present
 * they must describe the same ordered set; otherwise a reader could claim a
 * task using one field while a monitor or writer reasons about the other.
 */
export function validateTaskDependencies(fields, errorMessage = 'invalid_task_dependencies') {
    const taskId = fields.id;
    if (taskId !== undefined
        && (typeof taskId !== 'string'
            || !TASK_ID_SAFE_PATTERN.test(taskId)
            || String(Number(taskId)) !== taskId)) {
        throw new Error(errorMessage);
    }
    const dependsOn = fields.depends_on;
    const blockedBy = fields.blocked_by;
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
        throw new Error(errorMessage);
    }
    if (blockedBy !== undefined && !Array.isArray(blockedBy)) {
        throw new Error(errorMessage);
    }
    if (dependsOn !== undefined && blockedBy !== undefined
        && (dependsOn.length !== blockedBy.length
            || dependsOn.some((dependencyId, index) => dependencyId !== blockedBy[index]))) {
        throw new Error(errorMessage);
    }
    const dependencies = (dependsOn ?? blockedBy ?? []);
    const seen = new Set();
    for (const dependencyId of dependencies) {
        const numericId = typeof dependencyId === 'string' ? Number(dependencyId) : Number.NaN;
        if (typeof dependencyId !== 'string'
            || !TASK_ID_SAFE_PATTERN.test(dependencyId)
            || !Number.isSafeInteger(numericId)
            || numericId < 1
            || String(numericId) !== dependencyId
            || dependencyId === taskId
            || seen.has(dependencyId)) {
            throw new Error(errorMessage);
        }
        seen.add(dependencyId);
    }
    return dependencies;
}
function taskDependencyIds(task) {
    return validateTaskDependencies(task, 'invalid_persisted_state');
}
/**
 * Build the canonical persisted representation for a newly-created task.
 *
 * Task files are the source of truth, so every producer must use the same
 * dependency normalization and must not persist null/undefined optional
 * fields that readers treat as absent.
 */
export function createTaskRecord(id, task) {
    const dependencyIds = validateTaskDependencies({
        id,
        depends_on: task.depends_on,
        blocked_by: task.blocked_by,
    }, 'invalid_task_dependencies');
    const record = {
        ...task,
        id,
        status: task.status ?? 'pending',
        depends_on: [...dependencyIds],
        version: 1,
        created_at: new Date().toISOString(),
    };
    if (task.blocked_by !== undefined)
        record.blocked_by = [...dependencyIds];
    else
        delete record.blocked_by;
    // Optional wire fields historically used null as an empty value. Keep the
    // task shape canonical without mutating the caller's object.
    for (const key of ['owner', 'result', 'error']) {
        if (record[key] === undefined || record[key] === null)
            delete record[key];
    }
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined)
            Reflect.deleteProperty(record, key);
    }
    return record;
}
export async function computeTaskReadiness(teamName, taskId, cwd, deps) {
    const task = await deps.readTask(teamName, taskId, cwd);
    if (!task)
        return { ready: false, reason: 'blocked_dependency', dependencies: [] };
    const depIds = taskDependencyIds(task);
    if (depIds.length === 0)
        return { ready: true };
    const depTasks = await Promise.all(depIds.map((depId) => deps.readTask(teamName, depId, cwd)));
    for (const depTask of depTasks) {
        if (depTask)
            taskDependencyIds(depTask);
    }
    const incomplete = depIds.filter((_, idx) => depTasks[idx]?.status !== 'completed');
    if (incomplete.length > 0)
        return { ready: false, reason: 'blocked_dependency', dependencies: incomplete };
    return { ready: true };
}
export async function claimTask(taskId, workerName, expectedVersion, deps) {
    const cfg = await deps.readTeamConfig(deps.teamName, deps.cwd);
    if (!cfg || !cfg.workers.some((w) => w.name === workerName))
        return { ok: false, error: 'worker_not_found' };
    const existing = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!existing)
        return { ok: false, error: 'task_not_found' };
    const readiness = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
    if (readiness.ready === false) {
        return { ok: false, error: 'blocked_dependency', dependencies: readiness.dependencies };
    }
    const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
        const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
        if (!current)
            return { ok: false, error: 'task_not_found' };
        const v = deps.normalizeTask(current);
        if (expectedVersion !== null && v.version !== expectedVersion)
            return { ok: false, error: 'claim_conflict' };
        const readinessAfterLock = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
        if (readinessAfterLock.ready === false) {
            return { ok: false, error: 'blocked_dependency', dependencies: readinessAfterLock.dependencies };
        }
        if (deps.isTerminalTaskStatus(v.status))
            return { ok: false, error: 'already_terminal' };
        if (v.status === 'in_progress')
            return { ok: false, error: 'claim_conflict' };
        if (v.recovery_reservation)
            return { ok: false, error: 'claim_conflict' };
        if (v.status === 'pending' || v.status === 'blocked') {
            if (v.claim)
                return { ok: false, error: 'claim_conflict' };
            if (v.owner && v.owner !== workerName)
                return { ok: false, error: 'claim_conflict' };
        }
        const claimToken = randomUUID();
        const updated = {
            ...v,
            status: 'in_progress',
            owner: workerName,
            claim: {
                owner: workerName,
                token: claimToken,
                leased_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                ...(deps.launchAttemptId ? { launch_attempt_id: deps.launchAttemptId } : {}),
            },
            version: v.version + 1,
        };
        await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
        return { ok: true, task: updated, claimToken };
    });
    if (!lock.ok)
        return { ok: false, error: 'claim_conflict' };
    return lock.value;
}
function extractDelegationComplianceEvidence(task, terminalData) {
    const plan = task.delegation;
    if (!plan || plan.mode === 'none')
        return null;
    if (plan.mode === 'optional' && plan.required_parallel_probe !== true)
        return null;
    const result = typeof terminalData?.result === 'string' ? terminalData.result : '';
    const spawnMatch = result.match(/^\s*Subagent spawn evidence:\s*(.+)$/im);
    if (spawnMatch?.[1]?.trim()) {
        const detail = spawnMatch[1].trim();
        if (!/^none\b|^0\b/i.test(detail)) {
            return { status: 'spawned', source: 'terminal_result', detail, recorded_at: new Date().toISOString() };
        }
    }
    if (plan.skip_allowed_reason_required === true) {
        const skipMatch = result.match(/^\s*Subagent skip reason:\s*(.+)$/im);
        if (skipMatch?.[1]?.trim()) {
            return { status: 'skipped', source: 'terminal_result', detail: skipMatch[1].trim(), recorded_at: new Date().toISOString() };
        }
    }
    return null;
}
function requiresDelegationComplianceEvidence(task) {
    const plan = task.delegation;
    return !!plan && (plan.mode === 'auto' || plan.mode === 'required' || plan.required_parallel_probe === true);
}
function hasValidLease(claim) {
    if (!claim || typeof claim.owner !== 'string' || claim.owner.trim() === ''
        || typeof claim.token !== 'string' || claim.token.trim() === ''
        || typeof claim.leased_until !== 'string' || claim.leased_until.trim() === '') {
        return false;
    }
    return Number.isFinite(Date.parse(claim.leased_until));
}
export async function transitionTaskStatus(taskId, from, to, claimToken, terminalData, deps) {
    if (!deps.canTransitionTaskStatus(from, to))
        return { ok: false, error: 'invalid_transition' };
    const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
        const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
        if (!current)
            return { ok: false, error: 'task_not_found' };
        const v = deps.normalizeTask(current);
        if (deps.isTerminalTaskStatus(v.status))
            return { ok: false, error: 'already_terminal' };
        if (!deps.canTransitionTaskStatus(v.status, to))
            return { ok: false, error: 'invalid_transition' };
        if (v.status !== from)
            return { ok: false, error: 'invalid_transition' };
        if (!v.owner || !hasValidLease(v.claim) || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
            return { ok: false, error: 'claim_conflict' };
        }
        if (Date.parse(v.claim.leased_until) <= Date.now())
            return { ok: false, error: 'lease_expired' };
        const normalizedResult = typeof terminalData?.result === 'string' ? terminalData.result : undefined;
        const normalizedError = typeof terminalData?.error === 'string' ? terminalData.error : undefined;
        const delegationCompliance = to === 'completed'
            ? extractDelegationComplianceEvidence(v, terminalData)
            : null;
        if (to === 'completed' && requiresDelegationComplianceEvidence(v) && !delegationCompliance) {
            return { ok: false, error: 'missing_delegation_compliance_evidence' };
        }
        const updated = {
            ...v,
            status: to,
            completed_at: to === 'completed' ? new Date().toISOString() : v.completed_at,
            result: to === 'completed' ? normalizedResult : undefined,
            error: to === 'failed' ? normalizedError : undefined,
            delegation_compliance: to === 'completed' ? delegationCompliance ?? v.delegation_compliance : v.delegation_compliance,
            claim: undefined,
            version: v.version + 1,
            ...(terminalData && 'metadata' in terminalData && terminalData.metadata
                ? { metadata: { ...(v.metadata ?? {}), ...terminalData.metadata } }
                : {}),
        };
        await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
        let eventAppended = true;
        try {
            if (to === 'completed') {
                await deps.appendTeamEvent(deps.teamName, { type: 'task_completed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: undefined }, deps.cwd);
            }
            else if (to === 'failed') {
                await deps.appendTeamEvent(deps.teamName, { type: 'task_failed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: updated.error || 'task_failed' }, deps.cwd);
            }
        }
        catch (error) {
            eventAppended = false;
            logEventAppendFailure(error);
        }
        return { ok: true, task: updated, eventAppended };
    });
    if (!lock.ok)
        return { ok: false, error: 'claim_conflict' };
    if (!lock.value.ok)
        return lock.value;
    if (to === 'completed' && lock.value.eventAppended) {
        try {
            await deps.markTaskCompleted(deps.teamName, lock.value.task.id, deps.cwd);
        }
        catch (error) {
            logCompletionMarkerFailure(error);
        }
    }
    return { ok: true, task: lock.value.task };
}
export async function releaseTaskClaim(taskId, claimToken, _workerName, deps) {
    const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
        const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
        if (!current)
            return { ok: false, error: 'task_not_found' };
        const v = deps.normalizeTask(current);
        if (v.status === 'pending' && !v.claim && !v.owner)
            return { ok: true, task: v };
        if (v.status === 'completed' || v.status === 'failed')
            return { ok: false, error: 'already_terminal' };
        if (!v.owner || !hasValidLease(v.claim) || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
            return { ok: false, error: 'claim_conflict' };
        }
        if (Date.parse(v.claim.leased_until) <= Date.now())
            return { ok: false, error: 'lease_expired' };
        const updated = {
            ...v,
            status: 'pending',
            owner: undefined,
            claim: undefined,
            version: v.version + 1,
        };
        await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
        return { ok: true, task: updated };
    });
    if (!lock.ok)
        return { ok: false, error: 'claim_conflict' };
    return lock.value;
}
export async function listTasks(teamName, cwd, deps) {
    const tasksRoot = join(deps.teamDir(teamName, cwd), 'tasks');
    const invalidState = (path, cause) => deps.stateError?.(path, cause) ?? new Error('invalid_persisted_state');
    let entries;
    try {
        entries = await readdir(tasksRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw invalidState(tasksRoot, 'unreadable');
    }
    const candidates = new Map();
    for (const entry of entries) {
        const canonical = /^task-(\d{1,20})\.json$/.exec(entry.name);
        const legacy = /^(\d{1,20})\.json$/.exec(entry.name);
        const match = canonical ?? legacy;
        if (!match)
            continue;
        const id = match[1];
        const current = candidates.get(id) ?? {};
        if (canonical)
            current.canonical = entry.name;
        else
            current.legacy = entry.name;
        candidates.set(id, current);
    }
    const tasks = [];
    for (const [id, paths] of candidates) {
        let fileName = paths.canonical ?? paths.legacy;
        if (!fileName)
            continue;
        let path = join(tasksRoot, fileName);
        let fileStat;
        try {
            fileStat = await lstat(path);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                if (fileName === paths.canonical && paths.legacy) {
                    fileName = paths.legacy;
                    path = join(tasksRoot, fileName);
                    try {
                        fileStat = await lstat(path);
                    }
                    catch (legacyError) {
                        if (legacyError.code === 'ENOENT')
                            continue;
                        throw invalidState(path, 'unreadable');
                    }
                }
                else {
                    continue;
                }
            }
            else {
                throw invalidState(path, 'unreadable');
            }
        }
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
            throw invalidState(path, 'unreadable');
        }
        let raw;
        try {
            raw = await readFile(path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                if (fileName === paths.canonical && paths.legacy) {
                    fileName = paths.legacy;
                    path = join(tasksRoot, fileName);
                    try {
                        const legacyStat = await lstat(path);
                        if (legacyStat.isSymbolicLink() || !legacyStat.isFile()) {
                            throw invalidState(path, 'unreadable');
                        }
                        raw = await readFile(path, 'utf8');
                    }
                    catch (legacyError) {
                        if (legacyError.code === 'ENOENT')
                            continue;
                        if (legacyError instanceof Error && legacyError.message.startsWith('invalid_persisted_state')) {
                            throw legacyError;
                        }
                        throw invalidState(path, 'unreadable');
                    }
                }
                else {
                    continue;
                }
            }
            else {
                throw invalidState(path, 'unreadable');
            }
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw invalidState(join(tasksRoot, fileName), 'json');
        }
        if (!deps.isTeamTask(parsed))
            throw invalidState(path, 'schema');
        const task = deps.normalizeTask(parsed);
        if (task.id !== id)
            throw invalidState(path, 'schema');
        try {
            taskDependencyIds(task);
        }
        catch {
            throw invalidState(path, 'schema');
        }
        tasks.push(task);
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id));
    return tasks;
}
function reservationFromSidecar(sidecar) {
    return { recovery_id: sidecar.recovery_id, request_id: sidecar.request_id, continuation_sequence: sidecar.continuation_sequence, checkpoint_path: sidecar.checkpoint_path, checkpoint_hash: sidecar.checkpoint_hash, replacement_worker: sidecar.replacement_worker, replacement_generation: sidecar.replacement_generation, adoption_token_hash: sidecar.adoption_token_hash, reserved_at: sidecar.created_at };
}
function checkpointError(error) { return `checkpoint_${error}`; }
export async function requeueRecoveredTask(input, deps) {
    const lock = await deps.withTaskClaimLock(deps.teamName, input.taskId, deps.cwd, async () => {
        const current = await deps.readTask(deps.teamName, input.taskId, deps.cwd);
        if (!current)
            return { ok: false, error: 'task_not_found' };
        const task = deps.normalizeTask(current);
        const sidecar = await deps.readRecoverySidecar(deps.teamName, input.recoveryId, input.taskId, deps.cwd);
        if (sidecar === 'malformed')
            return { ok: false, error: 'task_requeue_failed' };
        if (sidecar) {
            const reservation = reservationFromSidecar(sidecar);
            const sameAttempt = sidecar.recovery_id === input.recoveryId && sidecar.request_id === input.requestId && sidecar.task_id === input.taskId && sidecar.replacement_worker === input.replacementWorker && sidecar.replacement_generation === input.replacementGeneration && sidecar.adoption_token_hash === input.adoptionTokenHash;
            if (!sameAttempt)
                return { ok: false, error: 'task_requeue_failed' };
            if (task.status === 'pending' && task.version === sidecar.old_task_version + 1 && !task.owner && !task.claim && JSON.stringify(task.recovery_reservation) === JSON.stringify(reservation))
                return { ok: true, task, reservation, replayed: true };
            if (task.status !== 'in_progress' || task.version !== sidecar.old_task_version || task.owner !== sidecar.old_owner || task.claim?.owner !== sidecar.old_owner || task.claim?.token !== sidecar.old_claim_token || task.claim?.leased_until !== sidecar.old_claim_leased_until)
                return { ok: false, error: 'task_requeue_failed' };
            const checkpoint = await deps.readRecoveryCheckpoint(sidecar.checkpoint_path);
            if (!checkpoint.ok || checkpoint.checkpoint.resume_payload_hash !== sidecar.checkpoint_hash || checkpoint.checkpoint.sequence !== sidecar.continuation_sequence)
                return { ok: false, error: 'task_requeue_failed' };
            const updated = { ...task, status: 'pending', owner: undefined, claim: undefined, version: task.version + 1, recovery_reservation: reservation };
            await deps.writeAtomic(deps.taskFilePath(deps.teamName, input.taskId, deps.cwd), JSON.stringify(updated, null, 2));
            return { ok: true, task: updated, reservation, replayed: false };
        }
        if (task.status !== 'in_progress' || !task.owner || !task.claim || task.claim.owner !== task.owner || task.recovery_reservation)
            return { ok: false, error: 'task_requeue_failed' };
        const selected = await deps.selectRecoveryCheckpoint(deps.teamName, task, deps.cwd);
        if (!selected.ok)
            return { ok: false, error: checkpointError(selected.error) };
        const createdAt = new Date().toISOString();
        const next = { schema_version: 1, recovery_id: input.recoveryId, request_id: input.requestId, task_id: task.id, old_task_version: task.version, old_owner: task.owner, old_claim_token: task.claim.token, old_claim_leased_until: task.claim.leased_until, continuation_sequence: selected.checkpoint.sequence, checkpoint_path: selected.path, checkpoint_hash: selected.checkpoint.resume_payload_hash, replacement_worker: input.replacementWorker, replacement_generation: input.replacementGeneration, adoption_token_hash: input.adoptionTokenHash, created_at: createdAt };
        await deps.writeRecoverySidecar(deps.teamName, input.recoveryId, input.taskId, next, deps.cwd);
        const reservation = reservationFromSidecar(next);
        const updated = { ...task, status: 'pending', owner: undefined, claim: undefined, version: task.version + 1, recovery_reservation: reservation };
        await deps.writeAtomic(deps.taskFilePath(deps.teamName, input.taskId, deps.cwd), JSON.stringify(updated, null, 2));
        return { ok: true, task: updated, reservation, replayed: false };
    });
    return lock.ok ? lock.value : { ok: false, error: 'claim_conflict' };
}
export async function adoptRecoveryReservations(taskIds, workerName, proof, deps) {
    const results = [];
    for (const taskId of [...taskIds].sort()) {
        const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
            const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
            if (!current)
                return { ok: false, error: 'task_not_found' };
            const task = deps.normalizeTask(current);
            const reservation = task.recovery_reservation;
            if (!reservation) {
                if (task.status === 'in_progress' && task.owner === workerName && task.claim && task.recovery_adoption?.recovery_id === proof.recoveryId && task.recovery_adoption.request_id === proof.requestId && task.recovery_adoption.replacement_generation === proof.replacementGeneration) {
                    const checkpoint = await deps.readRecoveryCheckpoint(task.recovery_adoption.checkpoint_path);
                    if (!checkpoint.ok)
                        return { ok: false, error: checkpointError(checkpoint.error) };
                    if (deps.launchAttemptId && task.claim.launch_attempt_id !== deps.launchAttemptId) {
                        const rebound = {
                            ...task,
                            claim: { ...task.claim, launch_attempt_id: deps.launchAttemptId },
                            version: task.version + 1,
                        };
                        await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(rebound, null, 2));
                        return { ok: true, task: rebound, claimToken: rebound.claim.token, checkpoint: checkpoint.checkpoint, replayed: true };
                    }
                    return { ok: true, task, claimToken: task.claim.token, checkpoint: checkpoint.checkpoint, replayed: true };
                }
                return { ok: false, error: 'claim_conflict' };
            }
            if (task.status !== 'pending' || task.owner || task.claim || reservation.recovery_id !== proof.recoveryId || reservation.request_id !== proof.requestId || reservation.replacement_worker !== workerName || reservation.replacement_generation !== proof.replacementGeneration || !deps.verifyAdoptionToken(proof.adoptionToken, reservation.adoption_token_hash))
                return { ok: false, error: 'claim_conflict' };
            const checkpoint = await deps.readRecoveryCheckpoint(reservation.checkpoint_path);
            if (!checkpoint.ok || checkpoint.checkpoint.resume_payload_hash !== reservation.checkpoint_hash || checkpoint.checkpoint.sequence !== reservation.continuation_sequence)
                return { ok: false, error: checkpointError(checkpoint.ok ? 'stale' : checkpoint.error) };
            const claimToken = randomUUID();
            const adoptedAt = new Date().toISOString();
            const updated = { ...task, status: 'in_progress', owner: workerName, claim: {
                    owner: workerName,
                    token: claimToken,
                    leased_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                    ...(deps.launchAttemptId ? { launch_attempt_id: deps.launchAttemptId } : {}),
                }, version: task.version + 1, recovery_reservation: undefined, recovery_adoption: { recovery_id: reservation.recovery_id, request_id: reservation.request_id, continuation_sequence: reservation.continuation_sequence, checkpoint_path: reservation.checkpoint_path, checkpoint_hash: reservation.checkpoint_hash, replacement_worker: workerName, replacement_generation: reservation.replacement_generation, adopted_at: adoptedAt } };
            await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
            return { ok: true, task: updated, claimToken, checkpoint: checkpoint.checkpoint, replayed: false };
        });
        const result = lock.ok ? lock.value : { ok: false, error: 'claim_conflict' };
        results.push(result);
        if (!result.ok)
            break;
    }
    return results;
}
//# sourceMappingURL=tasks.js.map