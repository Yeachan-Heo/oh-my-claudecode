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
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TeamPaths, absPath } from './state-paths.js';
import { normalizeTeamManifest } from './governance.js';
import { normalizeTeamGovernance } from './governance.js';
import { isTerminalTeamTaskStatus, canTransitionTeamTaskStatus, } from './contracts.js';
import { claimTask as claimTaskImpl, transitionTaskStatus as transitionTaskStatusImpl, releaseTaskClaim as releaseTaskClaimImpl, listTasks as listTasksImpl, } from './state/tasks.js';
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
// Simple file-based lock (best-effort, non-blocking)
async function withLock(lockDir, fn) {
    const STALE_MS = 30_000;
    try {
        await mkdir(lockDir, { recursive: false });
    }
    catch (err) {
        if (err.code === 'EEXIST') {
            // Check staleness
            try {
                const { stat } = await import('node:fs/promises');
                const s = await stat(lockDir);
                if (Date.now() - s.mtimeMs > STALE_MS) {
                    await rm(lockDir, { recursive: true, force: true });
                    try {
                        await mkdir(lockDir, { recursive: false });
                    }
                    catch {
                        return { ok: false };
                    }
                }
                else {
                    return { ok: false };
                }
            }
            catch {
                return { ok: false };
            }
        }
        else {
            throw err;
        }
    }
    try {
        const result = await fn();
        return { ok: true, value: result };
    }
    finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => { });
    }
}
async function withTaskClaimLock(teamName, taskId, cwd, fn) {
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
export async function teamReadConfig(teamName, cwd) {
    // Try manifest first, fall back to config.json
    const manifest = await teamReadManifest(teamName, cwd);
    if (manifest) {
        return canonicalizeTeamConfigWorkers({
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
            leader_pane_id: manifest.leader_pane_id,
            hud_pane_id: manifest.hud_pane_id,
            resize_hook_name: manifest.resize_hook_name,
            resize_hook_target: manifest.resize_hook_target,
            next_worker_index: manifest.next_worker_index,
        });
    }
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const config = await readJsonSafe(configPath);
    return config ? canonicalizeTeamConfigWorkers(config) : null;
}
export async function teamReadManifest(teamName, cwd) {
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    const manifest = await readJsonSafe(manifestPath);
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
    const cfg = await teamReadConfig(teamName, cwd);
    if (!cfg)
        throw new Error(`Team ${teamName} not found`);
    const nextId = String(cfg.next_task_id ?? 1);
    const created = {
        ...task,
        id: nextId,
        status: task.status ?? 'pending',
        depends_on: task.depends_on ?? task.blocked_by ?? [],
        version: 1,
        created_at: new Date().toISOString(),
    };
    const taskPath = absPath(cwd, TeamPaths.tasks(teamName));
    await mkdir(taskPath, { recursive: true });
    await writeAtomic(join(taskPath, `task-${nextId}.json`), JSON.stringify(created, null, 2));
    // Advance counter
    cfg.next_task_id = Number(nextId) + 1;
    await writeAtomic(absPath(cwd, TeamPaths.config(teamName)), JSON.stringify(cfg, null, 2));
    return created;
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
}
export async function teamClaimTask(teamName, taskId, workerName, expectedVersion, cwd) {
    const manifest = await teamReadManifest(teamName, cwd);
    const governance = normalizeTeamGovernance(manifest?.governance, manifest?.policy);
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
        readTeamConfig: teamReadConfig,
        withTaskClaimLock,
        normalizeTask,
        isTerminalTaskStatus: isTerminalTeamTaskStatus,
        taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
        writeAtomic,
    });
}
export async function teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd) {
    return transitionTaskStatusImpl(taskId, from, to, claimToken, {
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
        if (!hb) {
            nonReporting.push(w.name);
            workerEntries.push({ name: w.name, alive: false, lastTurnAt: null, turnsWithoutProgress: 0 });
        }
        else {
            workerEntries.push({
                name: w.name,
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