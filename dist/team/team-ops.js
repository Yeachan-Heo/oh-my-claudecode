/**
 * MCP-aligned gateway for all team operations.
 *
 * Both the MCP server and the runtime import from this module instead of
 * the lower-level persistence layers directly. Every exported function
 * corresponds to (or backs) an MCP tool with the same semantic name,
 * ensuring the runtime contract matches the external MCP surface.
 *
 * Modeled after oh-my-codex/src/team/team-ops.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TeamPaths, absPath } from './state-paths.js';
import { normalizeTeamManifest } from './governance.js';
import { normalizeTeamGovernance } from './governance.js';
import { migrateTeamConfigRevision, readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { isTerminalTeamTaskStatus, canTransitionTeamTaskStatus, } from './contracts.js';
import { adoptRecoveryReservations as adoptRecoveryReservationsImpl, claimTask as claimTaskImpl, requeueRecoveredTask as requeueRecoveredTaskImpl, transitionTaskStatus as transitionTaskStatusImpl, releaseTaskClaim as releaseTaskClaimImpl, listTasks as listTasksImpl, } from './state/tasks.js';
import { publishTaskRecoveryCheckpoint as publishTaskRecoveryCheckpointImpl, readTaskRecoveryCheckpoint, selectTaskRecoveryCheckpoint, } from './task-recovery-checkpoint.js';
import { canonicalizeTeamConfigWorkers } from './worker-canonicalization.js';
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function teamDir(teamName, cwd) {
    return absPath(cwd, TeamPaths.root(teamName));
}
function normalizeTaskId(taskId) {
    const raw = String(taskId).trim();
    return raw.startsWith('task-') ? raw.slice('task-'.length) : raw;
}
function canonicalTaskFilePath(teamName, taskId, cwd) {
    const normalizedTaskId = normalizeTaskId(taskId);
    return join(absPath(cwd, TeamPaths.tasks(teamName)), `task-${normalizedTaskId}.json`);
}
function legacyTaskFilePath(teamName, taskId, cwd) {
    const normalizedTaskId = normalizeTaskId(taskId);
    return join(absPath(cwd, TeamPaths.tasks(teamName)), `${normalizedTaskId}.json`);
}
function taskFileCandidates(teamName, taskId, cwd) {
    const canonical = canonicalTaskFilePath(teamName, taskId, cwd);
    const legacy = legacyTaskFilePath(teamName, taskId, cwd);
    return canonical === legacy ? [canonical] : [canonical, legacy];
}
async function writeAtomic(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, data, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
}
async function readJsonSafe(path) {
    try {
        if (!existsSync(path))
            return null;
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function normalizeTask(task) {
    return { ...task, version: task.version ?? 1 };
}
function isTeamTask(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.id === 'string' && typeof v.subject === 'string' && typeof v.status === 'string';
}
// Process-identity lock: live holders are never stolen by elapsed time alone.
async function withLock(lockPath, fn) {
    try {
        const value = await withProcessIdentityFileLock(lockPath, fn, 1);
        return { ok: true, value };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'process_identity_lock_timeout')
            return { ok: false };
        throw error;
    }
}
export async function withTaskClaimLock(teamName, taskId, cwd, fn) {
    const lockDir = join(teamDir(teamName, cwd), 'tasks', `.lock-${taskId}`);
    return withLock(lockDir, fn);
}
async function withMailboxLock(teamName, workerName, cwd, fn) {
    const lockDir = absPath(cwd, TeamPaths.mailboxLockDir(teamName, workerName));
    const timeoutMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    let delayMs = 20;
    while (Date.now() < deadline) {
        const result = await withLock(lockDir, fn);
        if (result.ok)
            return result.value;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 200);
    }
    throw new Error(`Failed to acquire mailbox lock for ${workerName} after ${timeoutMs}ms`);
}
// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------
function configFromManifest(manifest) {
    return {
        name: manifest.name,
        task: manifest.task,
        agent_type: 'claude',
        policy: manifest.policy,
        governance: manifest.governance,
        worker_launch_mode: manifest.policy.worker_launch_mode,
        worker_count: manifest.worker_count,
        max_workers: 20,
        workers: manifest.workers,
        created_at: manifest.created_at,
        tmux_session: manifest.tmux_session,
        next_task_id: manifest.next_task_id,
        leader_cwd: manifest.leader_cwd,
        team_state_root: manifest.team_state_root,
        workspace_mode: manifest.workspace_mode,
        worktree_mode: manifest.worktree_mode,
        leader_pane_id: manifest.leader_pane_id,
        hud_pane_id: manifest.hud_pane_id,
        resize_hook_name: manifest.resize_hook_name,
        resize_hook_target: manifest.resize_hook_target,
        next_worker_index: manifest.next_worker_index,
    };
}
function mergeTeamConfigSources(config, manifest) {
    if (!config && !manifest)
        return null;
    if (config && typeof config.state_revision === 'number' && Number.isSafeInteger(config.state_revision)) {
        return canonicalizeTeamConfigWorkers(config);
    }
    if (!manifest)
        return config ? canonicalizeTeamConfigWorkers(config) : null;
    if (!config)
        return canonicalizeTeamConfigWorkers(configFromManifest(manifest));
    return canonicalizeTeamConfigWorkers({
        ...configFromManifest(manifest),
        ...config,
        workers: [...(config.workers ?? []), ...(manifest.workers ?? [])],
        worker_count: Math.max(config.worker_count ?? 0, manifest.worker_count ?? 0),
        next_task_id: Math.max(config.next_task_id ?? 1, manifest.next_task_id ?? 1),
        max_workers: Math.max(config.max_workers ?? 0, 20),
    });
}
export async function teamReadConfig(teamName, cwd) {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    const [manifest, config] = await Promise.all([
        teamReadManifest(teamName, cwd),
        readJsonSafe(configPath),
    ]);
    if (!config && existsSync(configPath))
        throw new Error('invalid_persisted_state');
    if (config && typeof config.state_revision === 'number' && Number.isSafeInteger(config.state_revision)) {
        return canonicalizeTeamConfigWorkers(config);
    }
    if (!manifest && existsSync(manifestPath))
        throw new Error('invalid_persisted_state');
    return mergeTeamConfigSources(config, manifest);
}
export async function teamReadManifest(teamName, cwd) {
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    const manifest = await readJsonSafe(manifestPath);
    if (!manifest && existsSync(manifestPath))
        throw new Error('invalid_persisted_state');
    return manifest ? normalizeTeamManifest(manifest) : null;
}
export async function teamCleanup(teamName, cwd) {
    await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}
// ---------------------------------------------------------------------------
// Worker operations
// ---------------------------------------------------------------------------
export async function teamWriteWorkerIdentity(teamName, workerName, identity, cwd) {
    const p = absPath(cwd, TeamPaths.workerIdentity(teamName, workerName));
    await writeAtomic(p, JSON.stringify(identity, null, 2));
}
export async function teamReadWorkerHeartbeat(teamName, workerName, cwd) {
    const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
    return readJsonSafe(p);
}
export async function teamUpdateWorkerHeartbeat(teamName, workerName, heartbeat, cwd) {
    const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
    await writeAtomic(p, JSON.stringify(heartbeat, null, 2));
}
export async function teamReadWorkerStatus(teamName, workerName, cwd) {
    const unknownStatus = { state: 'unknown', updated_at: '1970-01-01T00:00:00.000Z' };
    const p = absPath(cwd, TeamPaths.workerStatus(teamName, workerName));
    const status = await readJsonSafe(p);
    return status ?? unknownStatus;
}
export async function teamWriteWorkerInbox(teamName, workerName, prompt, cwd) {
    const p = absPath(cwd, TeamPaths.inbox(teamName, workerName));
    await writeAtomic(p, prompt);
}
// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------
export async function teamCreateTask(teamName, task, cwd) {
    const lockDir = join(teamDir(teamName, cwd), '.lock-create-task');
    const timeoutMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    let delayMs = 20;
    while (Date.now() < deadline) {
        const result = await withLock(lockDir, async () => {
            const revisioned = await migrateTeamConfigRevision(teamName, cwd);
            if (!revisioned)
                throw new Error(`Team ${teamName} not found`);
            if (revisioned.config.lifecycle_state === 'shutting_down' || revisioned.config.lifecycle_state === 'stopped') {
                throw new Error('team_mutation_busy');
            }
            const nextId = String(revisioned.config.next_task_id ?? 1);
            const created = {
                ...task,
                id: nextId,
                status: task.status ?? 'pending',
                depends_on: task.depends_on ?? task.blocked_by ?? [],
                version: 1,
                created_at: new Date().toISOString(),
            };
            const serializedTask = JSON.stringify(created, null, 2);
            const createdTaskPath = join(absPath(cwd, TeamPaths.tasks(teamName)), `task-${nextId}.json`);
            const taskLock = await withTaskClaimLock(teamName, nextId, cwd, async () => {
                await mkdir(dirname(createdTaskPath), { recursive: true });
                await writeAtomic(createdTaskPath, serializedTask);
                const nextConfig = {
                    ...revisioned.config,
                    next_task_id: Number(nextId) + 1,
                    state_revision: revisioned.stateRevision + 1,
                };
                try {
                    if (!await saveTeamConfigAtRevision(nextConfig, revisioned.stateRevision, cwd)) {
                        throw new Error('stale_state_revision');
                    }
                }
                catch (error) {
                    // A manifest projection can fail after config.json commits. Preserve a task
                    // that the authoritative counter/revision already admits.
                    const persisted = await readRevisionedTeamConfig(teamName, cwd).catch(() => null);
                    const configCommitted = persisted?.stateRevision === nextConfig.state_revision
                        && persisted?.config.next_task_id === nextConfig.next_task_id;
                    if (!configCommitted && await readFile(createdTaskPath, 'utf8').catch(() => null) === serializedTask) {
                        await rm(createdTaskPath, { force: true });
                    }
                    throw error;
                }
                return created;
            });
            if (!taskLock.ok)
                throw new Error(`Failed to acquire task claim lock for task ${nextId}`);
            return taskLock.value;
        });
        if (result.ok)
            return result.value;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 200);
    }
    throw new Error(`Failed to acquire task creation lock for team ${teamName} after ${timeoutMs}ms`);
}
export async function teamReadTask(teamName, taskId, cwd) {
    for (const candidate of taskFileCandidates(teamName, taskId, cwd)) {
        const task = await readJsonSafe(candidate);
        if (!task || !isTeamTask(task))
            continue;
        return normalizeTask(task);
    }
    return null;
}
export async function teamListTasks(teamName, cwd) {
    return listTasksImpl(teamName, cwd, {
        teamDir: (tn, c) => teamDir(tn, c),
        isTeamTask,
        normalizeTask,
    });
}
export async function teamUpdateTask(teamName, taskId, updates, cwd) {
    const timeoutMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    let delayMs = 20;
    while (Date.now() < deadline) {
        const result = await withTaskClaimLock(teamName, taskId, cwd, async () => {
            const existing = await teamReadTask(teamName, taskId, cwd);
            if (!existing)
                return null;
            const merged = {
                ...normalizeTask(existing),
                ...updates,
                id: existing.id,
                created_at: existing.created_at,
                version: Math.max(1, existing.version ?? 1) + 1,
            };
            const p = canonicalTaskFilePath(teamName, taskId, cwd);
            await writeAtomic(p, JSON.stringify(merged, null, 2));
            return merged;
        });
        if (result.ok)
            return result.value;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 200);
    }
    throw new Error(`Failed to acquire task update lock for task ${taskId} in team ${teamName} after ${timeoutMs}ms`);
}
export async function teamClaimTask(teamName, taskId, workerName, expectedVersion, cwd) {
    const config = await teamReadConfig(teamName, cwd);
    const governance = normalizeTeamGovernance(config?.governance, config?.policy);
    if (governance.plan_approval_required) {
        const task = await teamReadTask(teamName, taskId, cwd);
        if (task?.requires_code_change) {
            const approval = await teamReadTaskApproval(teamName, taskId, cwd);
            if (!approval || approval.status !== 'approved') {
                return { ok: false, error: 'blocked_dependency', dependencies: ['approval-required'] };
            }
        }
    }
    return claimTaskImpl(taskId, workerName, expectedVersion, {
        teamName,
        cwd,
        readTask: teamReadTask,
        readTeamConfig: async (tn, c) => {
            const cfg = await teamReadConfig(tn, c);
            if (!cfg)
                return null;
            if (cfg.workers.length > 0)
                return cfg;
            const match = /^worker-(\d+)$/.exec(workerName);
            const workerIndex = match ? Number.parseInt(match[1], 10) : 0;
            if (workerIndex >= 1 && workerIndex <= (cfg.worker_count ?? 0)) {
                return {
                    ...cfg,
                    workers: Array.from({ length: cfg.worker_count ?? 0 }, (_, index) => ({
                        name: `worker-${index + 1}`,
                    })),
                };
            }
            return cfg;
        },
        withTaskClaimLock,
        normalizeTask,
        isTerminalTaskStatus: isTerminalTeamTaskStatus,
        taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
        writeAtomic,
    });
}
export async function teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd, terminalData) {
    return transitionTaskStatusImpl(taskId, from, to, claimToken, terminalData, {
        teamName,
        cwd,
        readTask: teamReadTask,
        readTeamConfig: teamReadConfig,
        withTaskClaimLock,
        normalizeTask,
        isTerminalTaskStatus: isTerminalTeamTaskStatus,
        canTransitionTaskStatus: canTransitionTeamTaskStatus,
        taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
        writeAtomic,
        appendTeamEvent: teamAppendEvent,
        readMonitorSnapshot: teamReadMonitorSnapshot,
        writeMonitorSnapshot: teamWriteMonitorSnapshot,
    });
}
export async function teamReleaseTaskClaim(teamName, taskId, claimToken, workerName, cwd) {
    return releaseTaskClaimImpl(taskId, claimToken, workerName, {
        teamName,
        cwd,
        readTask: teamReadTask,
        readTeamConfig: teamReadConfig,
        withTaskClaimLock,
        normalizeTask,
        isTerminalTaskStatus: isTerminalTeamTaskStatus,
        taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
        writeAtomic,
    });
}
function recoveryTransitionDeps(teamName, cwd) {
    return {
        teamName, cwd, readTask: teamReadTask,
        readTeamConfig: teamReadConfig,
        withTaskClaimLock, normalizeTask, isTerminalTaskStatus: isTerminalTeamTaskStatus,
        taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c), writeAtomic,
        readRecoverySidecar: async (tn, recoveryId, tid, c) => {
            const path = absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid));
            if (!existsSync(path))
                return null;
            try {
                return JSON.parse(await readFile(path, 'utf8'));
            }
            catch {
                return 'malformed';
            }
        },
        writeRecoverySidecar: (tn, recoveryId, tid, sidecar, c) => writeAtomic(absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid)), JSON.stringify(sidecar, null, 2)),
        selectRecoveryCheckpoint: selectTaskRecoveryCheckpoint, readRecoveryCheckpoint: readTaskRecoveryCheckpoint,
        verifyAdoptionToken: (token, hash) => createHash('sha256').update(token).digest('hex') === hash,
    };
}
export async function teamPublishTaskRecoveryCheckpoint(input, cwd) {
    return publishTaskRecoveryCheckpointImpl(input, cwd, { readTask: async (tn, tid, c) => {
            const task = await teamReadTask(tn, tid, c);
            return task ? normalizeTask(task) : null;
        }, withTaskLock: withTaskClaimLock });
}
export async function teamRequeueRecoveredTask(teamName, cwd, input) {
    return requeueRecoveredTaskImpl(input, recoveryTransitionDeps(teamName, cwd));
}
/** Runtime-owner-only continuation adoption; call before provider launch. */
export async function teamAdoptRecoveryReservations(teamName, cwd, taskIds, workerName, proof) {
    return adoptRecoveryReservationsImpl(taskIds, workerName, proof, recoveryTransitionDeps(teamName, cwd));
}
// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
function normalizeLegacyMailboxMessage(raw) {
    if (raw.type === 'notified')
        return null;
    const messageId = typeof raw.message_id === 'string' && raw.message_id.trim() !== ''
        ? raw.message_id
        : (typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : '');
    const fromWorker = typeof raw.from_worker === 'string' && raw.from_worker.trim() !== ''
        ? raw.from_worker
        : (typeof raw.from === 'string' ? raw.from : '');
    const toWorker = typeof raw.to_worker === 'string' && raw.to_worker.trim() !== ''
        ? raw.to_worker
        : (typeof raw.to === 'string' ? raw.to : '');
    const body = typeof raw.body === 'string' ? raw.body : '';
    const createdAt = typeof raw.created_at === 'string' && raw.created_at.trim() !== ''
        ? raw.created_at
        : (typeof raw.createdAt === 'string' ? raw.createdAt : '');
    if (!messageId || !fromWorker || !toWorker || !body || !createdAt)
        return null;
    return {
        message_id: messageId,
        from_worker: fromWorker,
        to_worker: toWorker,
        body,
        created_at: createdAt,
        ...(typeof raw.notified_at === 'string' ? { notified_at: raw.notified_at } : {}),
        ...(typeof raw.notifiedAt === 'string' ? { notified_at: raw.notifiedAt } : {}),
        ...(typeof raw.delivered_at === 'string' ? { delivered_at: raw.delivered_at } : {}),
        ...(typeof raw.deliveredAt === 'string' ? { delivered_at: raw.deliveredAt } : {}),
    };
}
async function readLegacyMailboxJsonl(teamName, workerName, cwd) {
    const legacyPath = absPath(cwd, TeamPaths.mailbox(teamName, workerName).replace(/\.json$/i, '.jsonl'));
    if (!existsSync(legacyPath))
        return { worker: workerName, messages: [] };
    try {
        const raw = await readFile(legacyPath, 'utf8');
        const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        const byMessageId = new Map();
        for (const line of lines) {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!parsed || typeof parsed !== 'object')
                continue;
            const normalized = normalizeLegacyMailboxMessage(parsed);
            if (!normalized)
                continue;
            byMessageId.set(normalized.message_id, normalized);
        }
        return { worker: workerName, messages: [...byMessageId.values()] };
    }
    catch {
        return { worker: workerName, messages: [] };
    }
}
async function readMailbox(teamName, workerName, cwd) {
    const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
    const mailbox = await readJsonSafe(p);
    if (mailbox && Array.isArray(mailbox.messages)) {
        return { worker: workerName, messages: mailbox.messages };
    }
    return readLegacyMailboxJsonl(teamName, workerName, cwd);
}
function isStrictCanonicalMailboxRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function isStrictCanonicalMailboxText(value) {
    return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}
function isStrictCanonicalMailboxTimestamp(value) {
    return isStrictCanonicalMailboxText(value) && Number.isFinite(Date.parse(value));
}
function materializeStrictCanonicalMailboxMessage(raw) {
    const message = {
        message_id: raw.message_id,
        from_worker: raw.from_worker,
        to_worker: raw.to_worker,
        body: raw.body,
        created_at: raw.created_at,
    };
    if ('notified_at' in raw)
        message.notified_at = raw.notified_at;
    if ('delivered_at' in raw)
        message.delivered_at = raw.delivered_at;
    return message;
}
function validateStrictCanonicalMailboxMessage(raw, messageIndex) {
    if (!isStrictCanonicalMailboxRecord(raw))
        return { kind: 'malformed_message', messageIndex, field: '$' };
    if (!isStrictCanonicalMailboxText(raw.message_id))
        return { kind: 'malformed_message', messageIndex, field: 'message_id' };
    if (!isStrictCanonicalMailboxText(raw.from_worker))
        return { kind: 'malformed_message', messageIndex, field: 'from_worker' };
    if (!isStrictCanonicalMailboxText(raw.to_worker))
        return { kind: 'malformed_message', messageIndex, field: 'to_worker' };
    if (!isStrictCanonicalMailboxText(raw.body))
        return { kind: 'malformed_message', messageIndex, field: 'body' };
    if (!isStrictCanonicalMailboxTimestamp(raw.created_at))
        return { kind: 'malformed_message', messageIndex, field: 'created_at' };
    if ('notified_at' in raw && !isStrictCanonicalMailboxTimestamp(raw.notified_at)) {
        return { kind: 'malformed_message', messageIndex, field: 'notified_at' };
    }
    if ('delivered_at' in raw && !isStrictCanonicalMailboxTimestamp(raw.delivered_at)) {
        return { kind: 'malformed_message', messageIndex, field: 'delivered_at' };
    }
    return materializeStrictCanonicalMailboxMessage(raw);
}
/**
 * Reads one exact message from the canonical JSON mailbox without using the
 * compatibility JSONL fallback. It validates every canonical record first so
 * a corrupt or ambiguous mailbox cannot authorize a pane notification.
 */
export async function teamReadCanonicalMailboxMessageStrict(teamName, workerName, messageId, cwd) {
    const path = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        const code = error.code;
        return code === 'ENOENT'
            ? { kind: 'store_missing' }
            : { kind: 'malformed_store', cause: 'json' };
    }
    if (!isStrictCanonicalMailboxRecord(parsed))
        return { kind: 'malformed_store', cause: 'non_object' };
    if (parsed.worker !== workerName)
        return { kind: 'wrong_owner' };
    if (!Array.isArray(parsed.messages))
        return { kind: 'malformed_store', cause: 'messages_non_array' };
    const messages = [];
    for (let messageIndex = 0; messageIndex < parsed.messages.length; messageIndex += 1) {
        const validated = validateStrictCanonicalMailboxMessage(parsed.messages[messageIndex], messageIndex);
        if (!('message_id' in validated))
            return validated;
        messages.push(validated);
    }
    const indexesByMessageId = new Map();
    for (const [messageIndex, message] of messages.entries()) {
        const indexes = indexesByMessageId.get(message.message_id) ?? [];
        indexes.push(messageIndex);
        indexesByMessageId.set(message.message_id, indexes);
    }
    const requestedIndexes = indexesByMessageId.get(messageId) ?? [];
    if (requestedIndexes.length > 1) {
        return { kind: 'duplicate_message_id', messageId, messageIndexes: requestedIndexes };
    }
    const duplicate = [...indexesByMessageId.entries()].find(([, indexes]) => indexes.length > 1);
    if (duplicate)
        return { kind: 'duplicate_message_id', messageId: duplicate[0], messageIndexes: duplicate[1] };
    if (requestedIndexes.length === 0)
        return { kind: 'message_missing' };
    const messageIndex = requestedIndexes[0];
    const message = messages[messageIndex];
    if (message.to_worker !== workerName)
        return { kind: 'recipient_mismatch', messageIndex };
    if (message.notified_at)
        return { kind: 'replay_suppressed', message: { ...message }, marker: 'notified_at' };
    if (message.delivered_at)
        return { kind: 'replay_suppressed', message: { ...message }, marker: 'delivered_at' };
    return { kind: 'valid', message: { ...message } };
}
async function writeMailbox(teamName, workerName, mailbox, cwd) {
    const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
    await writeAtomic(p, JSON.stringify(mailbox, null, 2));
}
export async function teamSendMessage(teamName, fromWorker, toWorker, body, cwd) {
    return withMailboxLock(teamName, toWorker, cwd, async () => {
        const mailbox = await readMailbox(teamName, toWorker, cwd);
        const message = {
            message_id: randomUUID(),
            from_worker: fromWorker,
            to_worker: toWorker,
            body,
            created_at: new Date().toISOString(),
        };
        mailbox.messages.push(message);
        await writeMailbox(teamName, toWorker, mailbox, cwd);
        await teamAppendEvent(teamName, {
            type: 'message_received',
            worker: toWorker,
            message_id: message.message_id,
        }, cwd);
        return message;
    });
}
export async function teamBroadcast(teamName, fromWorker, body, cwd) {
    const cfg = await teamReadConfig(teamName, cwd);
    if (!cfg)
        throw new Error(`Team ${teamName} not found`);
    const messages = [];
    for (const worker of cfg.workers) {
        if (worker.name === fromWorker)
            continue;
        const msg = await teamSendMessage(teamName, fromWorker, worker.name, body, cwd);
        messages.push(msg);
    }
    return messages;
}
export async function teamListMailbox(teamName, workerName, cwd) {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    return mailbox.messages;
}
export async function teamMarkMessageDelivered(teamName, workerName, messageId, cwd) {
    return withMailboxLock(teamName, workerName, cwd, async () => {
        const mailbox = await readMailbox(teamName, workerName, cwd);
        const msg = mailbox.messages.find((m) => m.message_id === messageId);
        if (!msg)
            return false;
        msg.delivered_at = new Date().toISOString();
        await writeMailbox(teamName, workerName, mailbox, cwd);
        return true;
    });
}
export async function teamMarkMessageNotified(teamName, workerName, messageId, cwd) {
    return withMailboxLock(teamName, workerName, cwd, async () => {
        const mailbox = await readMailbox(teamName, workerName, cwd);
        const msg = mailbox.messages.find((m) => m.message_id === messageId);
        if (!msg)
            return false;
        msg.notified_at = new Date().toISOString();
        await writeMailbox(teamName, workerName, mailbox, cwd);
        return true;
    });
}
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export async function teamAppendEvent(teamName, event, cwd) {
    const full = {
        event_id: randomUUID(),
        team: teamName,
        created_at: new Date().toISOString(),
        ...event,
    };
    const p = absPath(cwd, TeamPaths.events(teamName));
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
}
// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
export async function teamReadTaskApproval(teamName, taskId, cwd) {
    const p = absPath(cwd, TeamPaths.approval(teamName, taskId));
    return readJsonSafe(p);
}
export async function teamWriteTaskApproval(teamName, approval, cwd) {
    const p = absPath(cwd, TeamPaths.approval(teamName, approval.task_id));
    await writeAtomic(p, JSON.stringify(approval, null, 2));
    await teamAppendEvent(teamName, {
        type: 'approval_decision',
        worker: approval.reviewer,
        task_id: approval.task_id,
        reason: `${approval.status}: ${approval.decision_reason}`,
    }, cwd);
}
// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export async function teamGetSummary(teamName, cwd) {
    const startMs = Date.now();
    const cfg = await teamReadConfig(teamName, cwd);
    if (!cfg)
        return null;
    const tasksStartMs = Date.now();
    const tasks = await teamListTasks(teamName, cwd);
    const tasksLoadedMs = Date.now() - tasksStartMs;
    const counts = {
        total: tasks.length,
        pending: 0,
        blocked: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
    };
    for (const t of tasks) {
        if (t.status in counts)
            counts[t.status]++;
    }
    const workersStartMs = Date.now();
    const workerEntries = [];
    const nonReporting = [];
    for (const w of cfg.workers) {
        const hb = await teamReadWorkerHeartbeat(teamName, w.name, cwd);
        const baseWorkerSummary = {
            name: w.name,
            working_dir: w.working_dir,
            worktree_repo_root: w.worktree_repo_root,
            worktree_path: w.worktree_path,
            worktree_branch: w.worktree_branch,
            worktree_detached: w.worktree_detached,
            worktree_created: w.worktree_created,
            team_state_root: w.team_state_root,
        };
        if (!hb) {
            nonReporting.push(w.name);
            workerEntries.push({ ...baseWorkerSummary, alive: false, lastTurnAt: null, turnsWithoutProgress: 0 });
        }
        else {
            workerEntries.push({
                ...baseWorkerSummary,
                alive: hb.alive,
                lastTurnAt: hb.last_turn_at,
                turnsWithoutProgress: 0,
            });
        }
    }
    const workersPollMs = Date.now() - workersStartMs;
    const performance = {
        total_ms: Date.now() - startMs,
        tasks_loaded_ms: tasksLoadedMs,
        workers_polled_ms: workersPollMs,
        task_count: tasks.length,
        worker_count: cfg.workers.length,
    };
    return {
        teamName,
        workerCount: cfg.workers.length,
        team_state_root: cfg.team_state_root,
        workspace_mode: cfg.workspace_mode,
        worktree_mode: cfg.worktree_mode,
        tasks: counts,
        workers: workerEntries,
        nonReportingWorkers: nonReporting,
        performance,
    };
}
// ---------------------------------------------------------------------------
// Shutdown control
// ---------------------------------------------------------------------------
export async function teamWriteShutdownRequest(teamName, workerName, requestedBy, cwd) {
    const p = absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName));
    await writeAtomic(p, JSON.stringify({ requested_at: new Date().toISOString(), requested_by: requestedBy }, null, 2));
}
export async function teamReadShutdownAck(teamName, workerName, cwd, minUpdatedAt) {
    const ackPath = absPath(cwd, TeamPaths.shutdownAck(teamName, workerName));
    const parsed = await readJsonSafe(ackPath);
    if (!parsed || (parsed.status !== 'accept' && parsed.status !== 'reject'))
        return null;
    if (typeof minUpdatedAt === 'string' && minUpdatedAt.trim() !== '') {
        const minTs = Date.parse(minUpdatedAt);
        const ackTs = Date.parse(parsed.updated_at ?? '');
        if (!Number.isFinite(minTs) || !Number.isFinite(ackTs) || ackTs < minTs)
            return null;
    }
    return parsed;
}
// ---------------------------------------------------------------------------
// Monitor snapshot
// ---------------------------------------------------------------------------
export async function teamReadMonitorSnapshot(teamName, cwd) {
    const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
    return readJsonSafe(p);
}
export async function teamWriteMonitorSnapshot(teamName, snapshot, cwd) {
    const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
    await writeAtomic(p, JSON.stringify(snapshot, null, 2));
}
// Atomic write re-export for other modules
export { writeAtomic };
//# sourceMappingURL=team-ops.js.map