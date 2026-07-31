import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
export async function computeTaskReadiness(teamName, taskId, cwd, deps) {
    const task = await deps.readTask(teamName, taskId, cwd);
    if (!task)
        return { ready: false, reason: 'blocked_dependency', dependencies: [] };
    const depIds = task.depends_on ?? task.blocked_by ?? [];
    if (depIds.length === 0)
        return { ready: true };
    const depTasks = await Promise.all(depIds.map((depId) => deps.readTask(teamName, depId, cwd)));
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
            claim: { owner: workerName, token: claimToken, leased_until: new Date(Date.now() + 15 * 60 * 1000).toISOString() },
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
        if (!v.owner || !v.claim || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
            return { ok: false, error: 'claim_conflict' };
        }
        if (new Date(v.claim.leased_until) <= new Date())
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
        };
        await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
        if (to === 'completed') {
            await deps.appendTeamEvent(deps.teamName, { type: 'task_completed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: undefined }, deps.cwd);
        }
        else if (to === 'failed') {
            await deps.appendTeamEvent(deps.teamName, { type: 'task_failed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: updated.error || 'task_failed' }, deps.cwd);
        }
        return { ok: true, task: updated };
    });
    if (!lock.ok)
        return { ok: false, error: 'claim_conflict' };
    if (to === 'completed') {
        const existing = await deps.readMonitorSnapshot(deps.teamName, deps.cwd);
        const updated = existing
            ? { ...existing, completedEventTaskIds: { ...(existing.completedEventTaskIds ?? {}), [taskId]: true } }
            : {
                taskStatusById: {},
                workerAliveByName: {},
                workerLivenessByName: {},
                workerStateByName: {},
                workerTurnCountByName: {},
                workerTaskIdByName: {},
                mailboxNotifiedByMessageId: {},
                completedEventTaskIds: { [taskId]: true },
            };
        await deps.writeMonitorSnapshot(deps.teamName, updated, deps.cwd);
    }
    return lock.value;
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
        if (!v.owner || !v.claim || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
            return { ok: false, error: 'claim_conflict' };
        }
        if (new Date(v.claim.leased_until) <= new Date())
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
    if (!existsSync(tasksRoot))
        return [];
    const entries = await readdir(tasksRoot, { withFileTypes: true });
    const matched = entries.flatMap((entry) => {
        if (!entry.isFile())
            return [];
        const match = /^(?:task-)?(\d+)\.json$/.exec(entry.name);
        if (!match)
            return [];
        return [{ id: match[1], fileName: entry.name }];
    });
    const loaded = await Promise.all(matched.map(async ({ id, fileName }) => {
        try {
            const raw = await readFile(join(tasksRoot, fileName), 'utf8');
            const parsed = JSON.parse(raw);
            if (!deps.isTeamTask(parsed))
                return null;
            const normalized = deps.normalizeTask(parsed);
            if (normalized.id !== id)
                return null;
            return normalized;
        }
        catch {
            return null;
        }
    }));
    const tasks = [];
    for (const task of loaded) {
        if (task)
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
                    return checkpoint.ok ? { ok: true, task, claimToken: task.claim.token, checkpoint: checkpoint.checkpoint, replayed: true } : { ok: false, error: checkpointError(checkpoint.error) };
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
            const updated = { ...task, status: 'in_progress', owner: workerName, claim: { owner: workerName, token: claimToken, leased_until: new Date(Date.now() + 15 * 60 * 1000).toISOString() }, version: task.version + 1, recovery_reservation: undefined, recovery_adoption: { recovery_id: reservation.recovery_id, request_id: reservation.request_id, continuation_sequence: reservation.continuation_sequence, checkpoint_path: reservation.checkpoint_path, checkpoint_hash: reservation.checkpoint_hash, replacement_worker: workerName, replacement_generation: reservation.replacement_generation, adopted_at: adoptedAt } };
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