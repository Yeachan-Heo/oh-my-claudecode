import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { TEAM_NAME_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN, TEAM_TASK_STATUSES, TEAM_EVENT_TYPES, TEAM_TASK_APPROVAL_STATUSES, } from './contracts.js';
import { teamSendMessage as sendDirectMessage, teamBroadcast as broadcastMessage, teamListMailbox as listMailboxMessages, teamMarkMessageDelivered as markMessageDelivered, teamMarkMessageNotified as markMessageNotified, teamCreateTask, teamReadTask, teamListTasks, teamUpdateTask, teamClaimTask, teamTransitionTaskStatus, teamReleaseTaskClaim, teamReadConfig, teamReadManifest, teamReadWorkerStatus, teamReadWorkerHeartbeat, teamUpdateWorkerHeartbeat, teamWriteWorkerInbox, teamWriteWorkerIdentity, teamAppendEvent, teamGetSummary, teamCleanup, teamWriteShutdownRequest, teamReadShutdownAck, teamReadMonitorSnapshot, teamWriteMonitorSnapshot, teamReadTaskApproval, teamWriteTaskApproval, } from './team-ops.js';
import { queueBroadcastMailboxMessage, queueDirectMailboxMessage } from './mcp-comm.js';
import { injectToLeaderPane, sendToWorker } from './tmux-session.js';
import { listDispatchRequests, markDispatchRequestDelivered, markDispatchRequestNotified } from './dispatch-queue.js';
import { readTeamEvents, waitForTeamEvent } from './events.js';
import { generateMailboxTriggerMessage } from './worker-bootstrap.js';
import { shutdownTeam } from './runtime.js';
import { shutdownTeamV2 } from './runtime-v2.js';
import { inspectTeamWorktreeCleanupSafety } from './git-worktree.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import { resolveTeamNameForCurrentContext, TeamLookupAmbiguityError } from './team-identity.js';
const TEAM_UPDATE_TASK_MUTABLE_FIELDS = new Set(['subject', 'description', 'blocked_by', 'requires_code_change', 'delegation']);
const TEAM_UPDATE_TASK_REQUEST_FIELDS = new Set(['team_name', 'task_id', 'workingDirectory', ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);
export const LEGACY_TEAM_MCP_TOOLS = [
    'team_send_message',
    'team_broadcast',
    'team_mailbox_list',
    'team_mailbox_mark_delivered',
    'team_mailbox_mark_notified',
    'team_create_task',
    'team_read_task',
    'team_list_tasks',
    'team_update_task',
    'team_claim_task',
    'team_transition_task_status',
    'team_release_task_claim',
    'team_read_config',
    'team_read_manifest',
    'team_read_worker_status',
    'team_read_worker_heartbeat',
    'team_update_worker_heartbeat',
    'team_write_worker_inbox',
    'team_write_worker_identity',
    'team_append_event',
    'team_get_summary',
    'team_cleanup',
    'team_orphan_cleanup',
    'team_write_shutdown_request',
    'team_read_shutdown_ack',
    'team_read_monitor_snapshot',
    'team_write_monitor_snapshot',
    'team_read_task_approval',
    'team_write_task_approval',
];
export const TEAM_API_OPERATIONS = [
    'send-message',
    'broadcast',
    'mailbox-list',
    'mailbox-mark-delivered',
    'mailbox-mark-notified',
    'create-task',
    'read-task',
    'list-tasks',
    'update-task',
    'claim-task',
    'transition-task-status',
    'release-task-claim',
    'read-config',
    'read-manifest',
    'read-worker-status',
    'read-worker-heartbeat',
    'update-worker-heartbeat',
    'write-worker-inbox',
    'write-worker-identity',
    'append-event',
    'read-events',
    'await-event',
    'read-idle-state',
    'read-stall-state',
    'get-summary',
    'cleanup',
    'orphan-cleanup',
    'write-shutdown-request',
    'read-shutdown-ack',
    'read-monitor-snapshot',
    'write-monitor-snapshot',
    'read-task-approval',
    'write-task-approval',
];
const TEAM_STATE_EVENT_WINDOW = 50;
function isFiniteInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}
function parseOptionalNonNegativeInteger(value, fieldName) {
    if (value === undefined)
        return null;
    if (!isFiniteInteger(value) || value < 0) {
        throw new Error(`${fieldName} must be a non-negative integer when provided`);
    }
    return value;
}
function parseOptionalBoolean(value, fieldName) {
    if (value === undefined)
        return null;
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean when provided`);
    }
    return value;
}
function parseOptionalEventType(value) {
    if (value === undefined)
        return null;
    if (typeof value !== 'string') {
        throw new Error('type must be a string when provided');
    }
    const normalized = value.trim();
    if (!normalized) {
        throw new Error('type cannot be empty when provided');
    }
    if (!TEAM_EVENT_TYPES.includes(normalized)) {
        throw new Error(`type must be one of: ${TEAM_EVENT_TYPES.join(', ')}`);
    }
    return normalized;
}
function selectRecentEvents(events) {
    return events.slice(Math.max(0, events.length - TEAM_STATE_EVENT_WINDOW));
}
function listTeamWorkerNames(summary, snapshot) {
    const names = new Set();
    for (const worker of summary?.workers ?? []) {
        names.add(worker.name);
    }
    for (const workerName of Object.keys(snapshot?.workerStateByName ?? {})) {
        names.add(workerName);
    }
    return [...names].sort();
}
function findLatestEventByType(events, types) {
    const allowed = new Set(types);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && allowed.has(event.type))
            return event;
    }
    return null;
}
function findLatestWorkerIdleEvent(events, workerName) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.worker !== workerName)
            continue;
        if (event.type === 'worker_idle')
            return event;
    }
    return null;
}
function summarizeEvent(event) {
    if (!event)
        return null;
    const record = event;
    return {
        event_id: event.event_id,
        type: event.type,
        worker: event.worker,
        task_id: event.task_id ?? null,
        created_at: event.created_at,
        reason: event.reason ?? null,
        state: record.state ?? null,
        prev_state: record.prev_state ?? null,
        source_type: record.source_type ?? null,
        worker_count: record.worker_count ?? null,
    };
}
function buildIdleState(teamName, summary, snapshot, recentEvents) {
    const workerNames = listTeamWorkerNames(summary, snapshot);
    const idleWorkers = workerNames.filter((workerName) => snapshot?.workerStateByName[workerName] === 'idle');
    const nonIdleWorkers = workerNames.filter((workerName) => !idleWorkers.includes(workerName));
    const lastIdleTransitionByWorker = Object.fromEntries(workerNames.map((workerName) => [workerName, summarizeEvent(findLatestWorkerIdleEvent(recentEvents, workerName))]));
    const lastAllWorkersIdleEvent = findLatestEventByType(recentEvents, ['worker_idle']);
    return {
        team_name: teamName,
        worker_count: summary?.workerCount ?? workerNames.length,
        idle_worker_count: idleWorkers.length,
        idle_workers: idleWorkers,
        non_idle_workers: nonIdleWorkers,
        all_workers_idle: workerNames.length > 0 && idleWorkers.length === workerNames.length,
        last_idle_transition_by_worker: lastIdleTransitionByWorker,
        last_all_workers_idle_event: summarizeEvent(lastAllWorkersIdleEvent),
        source: {
            summary_available: summary !== null,
            snapshot_available: snapshot !== null,
            recent_event_count: recentEvents.length,
        },
    };
}
function buildStallState(teamName, summary, snapshot, recentEvents, pendingLeaderDispatchCount) {
    const idleState = buildIdleState(teamName, summary, snapshot, recentEvents);
    const workerNames = listTeamWorkerNames(summary, snapshot);
    const deadWorkers = workerNames.filter((workerName) => summary?.workers.find((worker) => worker.name === workerName)?.alive === false);
    const stalledWorkers = [...(summary?.nonReportingWorkers ?? [])].sort();
    const pendingTaskCount = (summary?.tasks.pending ?? 0) + (summary?.tasks.blocked ?? 0) + (summary?.tasks.in_progress ?? 0);
    const liveWorkers = workerNames.filter((workerName) => summary?.workers.find((worker) => worker.name === workerName)?.alive !== false);
    const leaderAttentionPending = pendingLeaderDispatchCount > 0;
    const teamStalled = stalledWorkers.length > 0 || leaderAttentionPending || (deadWorkers.length > 0 && pendingTaskCount > 0);
    const reasons = [];
    if (stalledWorkers.length > 0)
        reasons.push(`workers_non_reporting:${stalledWorkers.join(',')}`);
    if (deadWorkers.length > 0 && pendingTaskCount > 0)
        reasons.push(`dead_workers_with_pending_work:${deadWorkers.join(',')}`);
    if (pendingLeaderDispatchCount > 0)
        reasons.push('leader_attention_pending:leader_dispatch_pending');
    return {
        team_name: teamName,
        team_stalled: teamStalled,
        leader_stale: false,
        leader_attention_pending: leaderAttentionPending,
        leader_decision_state: 'still_actionable',
        stalled_workers: stalledWorkers,
        dead_workers: deadWorkers,
        live_workers: liveWorkers,
        pending_task_count: pendingTaskCount,
        unread_leader_message_count: 0,
        pending_leader_dispatch_count: pendingLeaderDispatchCount,
        all_workers_idle: idleState.all_workers_idle,
        idle_workers: idleState.idle_workers,
        reasons,
        leader_attention_state: null,
        last_team_leader_nudge_event: summarizeEvent(findLatestEventByType(recentEvents, ['team_leader_nudge'])),
        source: {
            summary_available: summary !== null,
            snapshot_available: snapshot !== null,
            recent_event_count: recentEvents.length,
        },
    };
}
function parseValidatedTaskIdArray(value, fieldName) {
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array of task IDs (strings)`);
    }
    const taskIds = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            throw new Error(`${fieldName} entries must be strings`);
        }
        const normalized = item.trim();
        if (!TASK_ID_SAFE_PATTERN.test(normalized)) {
            throw new Error(`${fieldName} contains invalid task ID: "${item}"`);
        }
        taskIds.push(normalized);
    }
    return taskIds;
}
function parseTaskDelegationPlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('delegation must be an object');
    }
    const raw = value;
    const mode = raw.mode;
    if (mode !== 'none' && mode !== 'optional' && mode !== 'auto' && mode !== 'required') {
        throw new Error('delegation.mode must be one of: none, optional, auto, required');
    }
    const plan = { mode };
    if ('max_parallel_subtasks' in raw) {
        if (!isFiniteInteger(raw.max_parallel_subtasks) || raw.max_parallel_subtasks < 1) {
            throw new Error('delegation.max_parallel_subtasks must be a positive integer when provided');
        }
        plan.max_parallel_subtasks = raw.max_parallel_subtasks;
    }
    if ('required_parallel_probe' in raw) {
        if (typeof raw.required_parallel_probe !== 'boolean')
            throw new Error('delegation.required_parallel_probe must be a boolean when provided');
        plan.required_parallel_probe = raw.required_parallel_probe;
    }
    if ('spawn_before_serial_search_threshold' in raw) {
        if (!isFiniteInteger(raw.spawn_before_serial_search_threshold) || raw.spawn_before_serial_search_threshold < 1) {
            throw new Error('delegation.spawn_before_serial_search_threshold must be a positive integer when provided');
        }
        plan.spawn_before_serial_search_threshold = raw.spawn_before_serial_search_threshold;
    }
    if ('child_model_policy' in raw) {
        const policy = raw.child_model_policy;
        if (policy !== 'standard' && policy !== 'fast' && policy !== 'inherit' && policy !== 'frontier') {
            throw new Error('delegation.child_model_policy must be one of: standard, fast, inherit, frontier');
        }
        plan.child_model_policy = policy;
    }
    if ('child_model' in raw) {
        if (typeof raw.child_model !== 'string')
            throw new Error('delegation.child_model must be a string when provided');
        plan.child_model = raw.child_model;
    }
    if ('subtask_candidates' in raw) {
        if (!Array.isArray(raw.subtask_candidates) || !raw.subtask_candidates.every((item) => typeof item === 'string')) {
            throw new Error('delegation.subtask_candidates must be an array of strings when provided');
        }
        plan.subtask_candidates = raw.subtask_candidates;
    }
    if ('child_report_format' in raw) {
        const format = raw.child_report_format;
        if (format !== 'bullets' && format !== 'json')
            throw new Error('delegation.child_report_format must be bullets or json when provided');
        plan.child_report_format = format;
    }
    if ('skip_allowed_reason_required' in raw) {
        if (typeof raw.skip_allowed_reason_required !== 'boolean')
            throw new Error('delegation.skip_allowed_reason_required must be a boolean when provided');
        plan.skip_allowed_reason_required = raw.skip_allowed_reason_required;
    }
    return plan;
}
function teamStateExists(teamName, candidateCwd) {
    if (!TEAM_NAME_SAFE_PATTERN.test(teamName))
        return false;
    const teamRoot = join(candidateCwd, '.omc', 'state', 'team', teamName);
    return existsSync(join(teamRoot, 'config.json')) || existsSync(join(teamRoot, 'tasks')) || existsSync(teamRoot);
}
function parseTeamWorkerEnv(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw.trim());
    if (!match)
        return null;
    return { teamName: match[1], workerName: match[2] };
}
function parseTeamWorkerContextFromEnv(env = process.env) {
    return parseTeamWorkerEnv(env.OMC_TEAM_WORKER) ?? parseTeamWorkerEnv(env.OMX_TEAM_WORKER);
}
function readTeamStateRootFromEnv(env = process.env) {
    const candidate = typeof env.OMC_TEAM_STATE_ROOT === 'string' && env.OMC_TEAM_STATE_ROOT.trim() !== ''
        ? env.OMC_TEAM_STATE_ROOT.trim()
        : (typeof env.OMX_TEAM_STATE_ROOT === 'string' && env.OMX_TEAM_STATE_ROOT.trim() !== ''
            ? env.OMX_TEAM_STATE_ROOT.trim()
            : '');
    return candidate || null;
}
export function resolveTeamApiCliCommand(_env = process.env) {
    return 'omc team api';
}
function isRuntimeV2Config(config) {
    return !!config && typeof config === 'object' && Array.isArray(config.workers);
}
function isLegacyRuntimeConfig(config) {
    return !!config && typeof config === 'object' && Array.isArray(config.agentTypes);
}
function assertNoNativeWorktreeCleanupEvidence(teamName, cwd) {
    const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
    if (!safety.hasEvidence)
        return;
    const evidence = safety.blockers.length > 0
        ? safety.blockers
        : safety.entries.map((entry) => ({
            workerName: entry.workerName,
            path: entry.path,
            reason: 'worktree_cleanup_evidence_present',
        }));
    const details = evidence
        .map((item) => `${item.workerName}:${item.reason}:${item.path}`)
        .join(';');
    throw new Error(`cleanup_blocked:worktree_cleanup_evidence_present:${details}`);
}
async function executeTeamCleanupViaRuntime(teamName, cwd) {
    const config = await teamReadConfig(teamName, cwd);
    if (!config) {
        assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
        await teamCleanup(teamName, cwd);
        return;
    }
    if (isRuntimeV2Config(config)) {
        await shutdownTeamV2(teamName, cwd);
        return;
    }
    if (isLegacyRuntimeConfig(config)) {
        const legacyConfig = config;
        const sessionName = typeof legacyConfig.tmuxSession === 'string' && legacyConfig.tmuxSession.trim() !== ''
            ? legacyConfig.tmuxSession.trim()
            : `omc-team-${teamName}`;
        const leaderPaneId = typeof legacyConfig.leaderPaneId === 'string' && legacyConfig.leaderPaneId.trim() !== ''
            ? legacyConfig.leaderPaneId.trim()
            : undefined;
        await shutdownTeam(teamName, sessionName, cwd, 30_000, undefined, leaderPaneId, legacyConfig.tmuxOwnsWindow === true);
        return;
    }
    assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
    await teamCleanup(teamName, cwd);
}
function readTeamStateRootFromFile(path) {
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed.team_state_root === 'string' && parsed.team_state_root.trim() !== ''
            ? parsed.team_state_root.trim()
            : null;
    }
    catch {
        return null;
    }
}
function stateRootToWorkingDirectory(stateRoot) {
    const absolute = resolvePath(stateRoot);
    const normalized = absolute.replaceAll('\\', '/');
    for (const marker of ['/.omc/state/team/', '/.omx/state/team/']) {
        const idx = normalized.lastIndexOf(marker);
        if (idx >= 0) {
            const workspaceRoot = absolute.slice(0, idx);
            if (workspaceRoot && workspaceRoot !== '/')
                return workspaceRoot;
            return dirname(dirname(dirname(dirname(absolute))));
        }
    }
    for (const marker of ['/.omc/state', '/.omx/state']) {
        const idx = normalized.lastIndexOf(marker);
        if (idx >= 0) {
            const workspaceRoot = absolute.slice(0, idx);
            if (workspaceRoot && workspaceRoot !== '/')
                return workspaceRoot;
            return dirname(dirname(absolute));
        }
    }
    return dirname(dirname(absolute));
}
function resolveTeamWorkingDirectoryFromMetadata(teamName, candidateCwd, workerContext) {
    const teamRoot = join(candidateCwd, '.omc', 'state', 'team', teamName);
    if (!existsSync(teamRoot))
        return null;
    if (workerContext?.teamName === teamName) {
        const workerRoot = readTeamStateRootFromFile(join(teamRoot, 'workers', workerContext.workerName, 'identity.json'));
        if (workerRoot)
            return stateRootToWorkingDirectory(workerRoot);
    }
    const fromConfig = readTeamStateRootFromFile(join(teamRoot, 'config.json'));
    if (fromConfig)
        return stateRootToWorkingDirectory(fromConfig);
    for (const manifestName of ['manifest.json', 'manifest.v2.json']) {
        const fromManifest = readTeamStateRootFromFile(join(teamRoot, manifestName));
        if (fromManifest)
            return stateRootToWorkingDirectory(fromManifest);
    }
    return null;
}
function resolveTeamWorkingDirectory(teamName, preferredCwd) {
    const normalizedTeamName = String(teamName || '').trim();
    if (!normalizedTeamName)
        return preferredCwd;
    const envTeamStateRoot = readTeamStateRootFromEnv();
    if (typeof envTeamStateRoot === 'string' && envTeamStateRoot.trim() !== '') {
        const envWorkingDirectory = stateRootToWorkingDirectory(envTeamStateRoot.trim());
        if (teamStateExists(normalizedTeamName, envWorkingDirectory)) {
            return envWorkingDirectory;
        }
    }
    const seeds = [];
    for (const seed of [preferredCwd, process.cwd()]) {
        if (typeof seed !== 'string' || seed.trim() === '')
            continue;
        if (!seeds.includes(seed))
            seeds.push(seed);
    }
    const workerContext = parseTeamWorkerContextFromEnv();
    for (const seed of seeds) {
        let cursor = seed;
        while (cursor) {
            if (teamStateExists(normalizedTeamName, cursor)) {
                return resolveTeamWorkingDirectoryFromMetadata(normalizedTeamName, cursor, workerContext) ?? cursor;
            }
            const parent = dirname(cursor);
            if (!parent || parent === cursor)
                break;
            cursor = parent;
        }
    }
    return preferredCwd;
}
function normalizeTeamName(toolOrOperationName) {
    const normalized = toolOrOperationName.trim().toLowerCase();
    const withoutPrefix = normalized.startsWith('team_') ? normalized.slice('team_'.length) : normalized;
    return withoutPrefix.replaceAll('_', '-');
}
export function resolveTeamApiOperation(name) {
    const normalized = normalizeTeamName(name);
    return TEAM_API_OPERATIONS.includes(normalized) ? normalized : null;
}
export function buildLegacyTeamDeprecationHint(legacyName, originalArgs, env = process.env) {
    const operation = resolveTeamApiOperation(legacyName);
    const payload = JSON.stringify(originalArgs ?? {});
    const teamApiCli = resolveTeamApiCliCommand(env);
    if (!operation) {
        return `Use CLI interop: ${teamApiCli} <operation> --input '${payload}' --json`;
    }
    return `Use CLI interop: ${teamApiCli} ${operation} --input '${payload}' --json`;
}
const QUEUED_FOR_HOOK_DISPATCH_REASON = 'queued_for_hook_dispatch';
const LEADER_PANE_MISSING_MAILBOX_PERSISTED_REASON = 'leader_pane_missing_mailbox_persisted';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMC_TEAM_STATE_ROOT';
function resolveInstructionStateRoot(worktreePath) {
    return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}
function queuedForHookDispatch() {
    return {
        ok: true,
        transport: 'hook',
        reason: QUEUED_FOR_HOOK_DISPATCH_REASON,
    };
}
async function notifyMailboxTarget(teamName, toWorker, triggerMessage, cwd) {
    const config = await teamReadConfig(teamName, cwd);
    if (!config)
        return queuedForHookDispatch();
    const sessionName = typeof config.tmux_session === 'string' ? config.tmux_session.trim() : '';
    if (!sessionName)
        return queuedForHookDispatch();
    if (toWorker === 'leader-fixed') {
        const leaderPaneId = typeof config.leader_pane_id === 'string' ? config.leader_pane_id.trim() : '';
        if (!leaderPaneId) {
            return {
                ok: true,
                transport: 'mailbox',
                reason: LEADER_PANE_MISSING_MAILBOX_PERSISTED_REASON,
            };
        }
        const injected = await injectToLeaderPane(sessionName, leaderPaneId, triggerMessage);
        return injected
            ? { ok: true, transport: 'tmux_send_keys', reason: 'leader_pane_notified' }
            : queuedForHookDispatch();
    }
    const workerPaneId = config.workers.find((worker) => worker.name === toWorker)?.pane_id?.trim();
    if (!workerPaneId)
        return queuedForHookDispatch();
    const notified = await sendToWorker(sessionName, workerPaneId, triggerMessage);
    return notified
        ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_pane_notified' }
        : queuedForHookDispatch();
}
function findWorkerDispatchTarget(teamName, toWorker, cwd) {
    return teamReadConfig(teamName, cwd).then((config) => {
        const recipient = config?.workers.find((worker) => worker.name === toWorker);
        return {
            paneId: recipient?.pane_id,
            workerIndex: recipient?.index,
            instructionStateRoot: resolveInstructionStateRoot(recipient?.worktree_path),
        };
    });
}
async function findMailboxDispatchRequestId(teamName, workerName, messageId, cwd) {
    const requests = await listDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: workerName });
    const matching = requests
        .filter((request) => request.message_id === messageId)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    return matching[0]?.request_id ?? null;
}
async function syncMailboxDispatchNotified(teamName, workerName, messageId, cwd) {
    const logDispatchSyncFailure = createSwallowedErrorLogger('team.api-interop syncMailboxDispatchNotified dispatch state sync failed');
    const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
    if (!requestId)
        return;
    await markDispatchRequestNotified(teamName, requestId, { message_id: messageId, last_reason: 'mailbox_mark_notified' }, cwd).catch(logDispatchSyncFailure);
}
async function syncMailboxDispatchDelivered(teamName, workerName, messageId, cwd) {
    const logDispatchSyncFailure = createSwallowedErrorLogger('team.api-interop syncMailboxDispatchDelivered dispatch state sync failed');
    const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
    if (!requestId)
        return;
    await markDispatchRequestNotified(teamName, requestId, { message_id: messageId, last_reason: 'mailbox_mark_delivered' }, cwd).catch(logDispatchSyncFailure);
    await markDispatchRequestDelivered(teamName, requestId, { message_id: messageId, last_reason: 'mailbox_mark_delivered' }, cwd).catch(logDispatchSyncFailure);
}
function validateCommonFields(args, options = {}) {
    const teamName = String(args.team_name || '').trim();
    if (!options.skipTeamName && teamName && !TEAM_NAME_SAFE_PATTERN.test(teamName)) {
        throw new Error(`Invalid team_name: "${teamName}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).`);
    }
    for (const workerField of ['worker', 'from_worker', 'to_worker']) {
        const workerVal = String(args[workerField] || '').trim();
        if (workerVal && !WORKER_NAME_SAFE_PATTERN.test(workerVal)) {
            throw new Error(`Invalid ${workerField}: "${workerVal}". Must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase alphanumeric + hyphens, max 64 chars).`);
        }
    }
    const rawTaskId = String(args.task_id || '').trim();
    if (rawTaskId && !TASK_ID_SAFE_PATTERN.test(rawTaskId)) {
        throw new Error(`Invalid task_id: "${rawTaskId}". Must be a positive integer (digits only, max 20 digits).`);
    }
}
export async function executeTeamApiOperation(operation, args, fallbackCwd) {
    try {
        validateCommonFields(args, { skipTeamName: true });
        const rawTeamNameForCwd = String(args.team_name || '').trim();
        const resolvedTeamName = rawTeamNameForCwd ? resolveTeamNameForCurrentContext(rawTeamNameForCwd, fallbackCwd) : '';
        const cwd = resolvedTeamName ? resolveTeamWorkingDirectory(resolvedTeamName, fallbackCwd) : fallbackCwd;
        const opArgs = resolvedTeamName ? { ...args, team_name: resolvedTeamName } : args;
        validateCommonFields(opArgs);
        switch (operation) {
            case 'send-message': {
                const teamName = String(opArgs.team_name || '').trim();
                const fromWorker = String(opArgs.from_worker || '').trim();
                const toWorker = String(opArgs.to_worker || '').trim();
                const body = String(opArgs.body || '').trim();
                if (!fromWorker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'from_worker is required. You must identify yourself.' } };
                }
                if (!teamName || !toWorker || !body) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, to_worker, body are required' } };
                }
                let message = null;
                const target = await findWorkerDispatchTarget(teamName, toWorker, cwd);
                await queueDirectMailboxMessage({
                    teamName,
                    fromWorker,
                    toWorker,
                    toWorkerIndex: target.workerIndex,
                    toPaneId: target.paneId,
                    body,
                    triggerMessage: generateMailboxTriggerMessage(teamName, toWorker, 1, target.instructionStateRoot),
                    cwd,
                    notify: ({ workerName }, triggerMessage) => notifyMailboxTarget(teamName, workerName, triggerMessage, cwd),
                    deps: {
                        sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
                            message = await sendDirectMessage(resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd);
                            return message;
                        },
                        broadcastMessage,
                        markMessageNotified: async (resolvedTeamName, workerName, messageId, resolvedCwd) => {
                            await markMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd);
                        },
                    },
                });
                return { ok: true, operation, data: { message } };
            }
            case 'broadcast': {
                const teamName = String(opArgs.team_name || '').trim();
                const fromWorker = String(opArgs.from_worker || '').trim();
                const body = String(opArgs.body || '').trim();
                if (!teamName || !fromWorker || !body) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, body are required' } };
                }
                let messages = [];
                const config = await teamReadConfig(teamName, cwd);
                const recipients = (config?.workers ?? [])
                    .filter((worker) => worker.name !== fromWorker)
                    .map((worker) => ({
                    workerName: worker.name,
                    workerIndex: worker.index,
                    paneId: worker.pane_id,
                    instructionStateRoot: resolveInstructionStateRoot(worker.worktree_path),
                }));
                await queueBroadcastMailboxMessage({
                    teamName,
                    fromWorker,
                    recipients,
                    body,
                    cwd,
                    triggerFor: (workerName) => generateMailboxTriggerMessage(teamName, workerName, 1, recipients.find((recipient) => recipient.workerName === workerName)?.instructionStateRoot),
                    notify: ({ workerName }, triggerMessage) => notifyMailboxTarget(teamName, workerName, triggerMessage, cwd),
                    deps: {
                        sendDirectMessage,
                        broadcastMessage: async (resolvedTeamName, resolvedFromWorker, resolvedBody, resolvedCwd) => {
                            messages = await broadcastMessage(resolvedTeamName, resolvedFromWorker, resolvedBody, resolvedCwd);
                            return messages;
                        },
                        markMessageNotified: async (resolvedTeamName, workerName, messageId, resolvedCwd) => {
                            await markMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd);
                        },
                    },
                });
                return { ok: true, operation, data: { count: messages.length, messages } };
            }
            case 'mailbox-list': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const includeDelivered = args.include_delivered !== false;
                if (!teamName || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                }
                const all = await listMailboxMessages(teamName, worker, cwd);
                const messages = includeDelivered ? all : all.filter((m) => !m.delivered_at);
                return { ok: true, operation, data: { worker, count: messages.length, messages } };
            }
            case 'mailbox-mark-delivered': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const messageId = String(opArgs.message_id || '').trim();
                if (!teamName || !worker || !messageId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, message_id are required' } };
                }
                const updated = await markMessageDelivered(teamName, worker, messageId, cwd);
                if (updated) {
                    await syncMailboxDispatchDelivered(teamName, worker, messageId, cwd);
                }
                return { ok: true, operation, data: { worker, message_id: messageId, updated } };
            }
            case 'mailbox-mark-notified': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const messageId = String(opArgs.message_id || '').trim();
                if (!teamName || !worker || !messageId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, message_id are required' } };
                }
                const notified = await markMessageNotified(teamName, worker, messageId, cwd);
                if (notified) {
                    await syncMailboxDispatchNotified(teamName, worker, messageId, cwd);
                }
                return { ok: true, operation, data: { worker, message_id: messageId, notified } };
            }
            case 'create-task': {
                const teamName = String(opArgs.team_name || '').trim();
                const subject = String(opArgs.subject || '').trim();
                const description = String(opArgs.description || '').trim();
                if (!teamName || !subject || !description) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, subject, description are required' } };
                }
                const owner = args.owner;
                const blockedBy = args.blocked_by;
                const requiresCodeChange = args.requires_code_change;
                let delegation;
                if ('delegation' in args) {
                    try {
                        delegation = parseTaskDelegationPlan(args.delegation);
                    }
                    catch (error) {
                        return { ok: false, operation, error: { code: 'invalid_input', message: error.message } };
                    }
                }
                const task = await teamCreateTask(teamName, {
                    subject, description, status: 'pending', owner: owner || undefined, blocked_by: blockedBy, requires_code_change: requiresCodeChange,
                    ...(delegation ? { delegation } : {}),
                }, cwd);
                return { ok: true, operation, data: { task } };
            }
            case 'read-task': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                if (!teamName || !taskId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
                }
                const task = await teamReadTask(teamName, taskId, cwd);
                return task
                    ? { ok: true, operation, data: { task } }
                    : { ok: false, operation, error: { code: 'task_not_found', message: 'task_not_found' } };
            }
            case 'list-tasks': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                }
                const tasks = await teamListTasks(teamName, cwd);
                return { ok: true, operation, data: { count: tasks.length, tasks } };
            }
            case 'update-task': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                if (!teamName || !taskId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
                }
                const lifecycleFields = ['status', 'owner', 'result', 'error'];
                const presentLifecycleFields = lifecycleFields.filter((f) => f in args);
                if (presentLifecycleFields.length > 0) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task cannot mutate lifecycle fields: ${presentLifecycleFields.join(', ')}` } };
                }
                const unexpectedFields = Object.keys(args).filter((field) => !TEAM_UPDATE_TASK_REQUEST_FIELDS.has(field));
                if (unexpectedFields.length > 0) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task received unsupported fields: ${unexpectedFields.join(', ')}` } };
                }
                const updates = {};
                if ('subject' in args) {
                    if (typeof args.subject !== 'string') {
                        return { ok: false, operation, error: { code: 'invalid_input', message: 'subject must be a string when provided' } };
                    }
                    updates.subject = args.subject.trim();
                }
                if ('description' in args) {
                    if (typeof args.description !== 'string') {
                        return { ok: false, operation, error: { code: 'invalid_input', message: 'description must be a string when provided' } };
                    }
                    updates.description = args.description.trim();
                }
                if ('requires_code_change' in args) {
                    if (typeof args.requires_code_change !== 'boolean') {
                        return { ok: false, operation, error: { code: 'invalid_input', message: 'requires_code_change must be a boolean when provided' } };
                    }
                    updates.requires_code_change = args.requires_code_change;
                }
                if ('blocked_by' in args) {
                    try {
                        updates.blocked_by = parseValidatedTaskIdArray(args.blocked_by, 'blocked_by');
                    }
                    catch (error) {
                        return { ok: false, operation, error: { code: 'invalid_input', message: error.message } };
                    }
                }
                if ('delegation' in args) {
                    try {
                        updates.delegation = parseTaskDelegationPlan(args.delegation);
                    }
                    catch (error) {
                        return { ok: false, operation, error: { code: 'invalid_input', message: error.message } };
                    }
                }
                const task = await teamUpdateTask(teamName, taskId, updates, cwd);
                return task
                    ? { ok: true, operation, data: { task } }
                    : { ok: false, operation, error: { code: 'task_not_found', message: 'task_not_found' } };
            }
            case 'claim-task': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !taskId || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, worker are required' } };
                }
                const rawExpectedVersion = args.expected_version;
                if (rawExpectedVersion !== undefined && (!isFiniteInteger(rawExpectedVersion) || rawExpectedVersion < 1)) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'expected_version must be a positive integer when provided' } };
                }
                const result = await teamClaimTask(teamName, taskId, worker, rawExpectedVersion ?? null, cwd);
                return { ok: true, operation, data: result };
            }
            case 'transition-task-status': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                const from = String(opArgs.from || '').trim();
                const to = String(opArgs.to || '').trim();
                const claimToken = String(opArgs.claim_token || '').trim();
                const transitionResult = args.result;
                const transitionError = args.error;
                if (!teamName || !taskId || !from || !to || !claimToken) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, from, to, claim_token are required' } };
                }
                const allowed = new Set(TEAM_TASK_STATUSES);
                if (!allowed.has(from) || !allowed.has(to)) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'from and to must be valid task statuses' } };
                }
                if (transitionResult !== undefined && typeof transitionResult !== 'string') {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'result must be a string when provided' } };
                }
                if (transitionError !== undefined && typeof transitionError !== 'string') {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'error must be a string when provided' } };
                }
                const result = await teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd, {
                    result: typeof transitionResult === 'string' ? transitionResult : undefined,
                    error: typeof transitionError === 'string' ? transitionError : undefined,
                });
                return { ok: true, operation, data: result };
            }
            case 'release-task-claim': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                const claimToken = String(opArgs.claim_token || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !taskId || !claimToken || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, claim_token, worker are required' } };
                }
                const result = await teamReleaseTaskClaim(teamName, taskId, claimToken, worker, cwd);
                return { ok: true, operation, data: result };
            }
            case 'read-config': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const config = await teamReadConfig(teamName, cwd);
                return config
                    ? { ok: true, operation, data: { config } }
                    : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
            }
            case 'read-manifest': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const manifest = await teamReadManifest(teamName, cwd);
                return manifest
                    ? { ok: true, operation, data: { manifest } }
                    : { ok: false, operation, error: { code: 'manifest_not_found', message: 'manifest_not_found' } };
            }
            case 'read-worker-status': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !worker)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                const status = await teamReadWorkerStatus(teamName, worker, cwd);
                return { ok: true, operation, data: { worker, status } };
            }
            case 'read-worker-heartbeat': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !worker)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
                return { ok: true, operation, data: { worker, heartbeat } };
            }
            case 'update-worker-heartbeat': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const pid = args.pid;
                const turnCount = args.turn_count;
                const alive = args.alive;
                if (!teamName || !worker || typeof pid !== 'number' || typeof turnCount !== 'number' || typeof alive !== 'boolean') {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, pid, turn_count, alive are required' } };
                }
                await teamUpdateWorkerHeartbeat(teamName, worker, { pid, turn_count: turnCount, alive, last_turn_at: new Date().toISOString() }, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'write-worker-inbox': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const content = String(opArgs.content || '').trim();
                if (!teamName || !worker || !content) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, content are required' } };
                }
                await teamWriteWorkerInbox(teamName, worker, content, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'write-worker-identity': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const index = args.index;
                const role = String(opArgs.role || '').trim();
                if (!teamName || !worker || typeof index !== 'number' || !role) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, index, role are required' } };
                }
                await teamWriteWorkerIdentity(teamName, worker, {
                    name: worker,
                    index,
                    role,
                    assigned_tasks: args.assigned_tasks ?? [],
                    pid: args.pid,
                    pane_id: args.pane_id,
                    working_dir: args.working_dir,
                    worktree_repo_root: args.worktree_repo_root,
                    worktree_path: args.worktree_path,
                    worktree_branch: args.worktree_branch,
                    worktree_detached: args.worktree_detached,
                    worktree_created: args.worktree_created,
                    team_state_root: args.team_state_root,
                }, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'append-event': {
                const teamName = String(opArgs.team_name || '').trim();
                const eventType = String(opArgs.type || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !eventType || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, type, worker are required' } };
                }
                if (!TEAM_EVENT_TYPES.includes(eventType)) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `type must be one of: ${TEAM_EVENT_TYPES.join(', ')}` } };
                }
                const event = await teamAppendEvent(teamName, {
                    type: eventType,
                    worker,
                    task_id: args.task_id,
                    message_id: args.message_id ?? null,
                    reason: args.reason,
                }, cwd);
                return { ok: true, operation, data: { event } };
            }
            case 'read-events': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const wakeableOnly = parseOptionalBoolean(args.wakeable_only, 'wakeable_only');
                const eventType = parseOptionalEventType(args.type);
                const worker = typeof args.worker === 'string' ? args.worker.trim() : '';
                const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
                const afterEventId = typeof args.after_event_id === 'string' ? args.after_event_id.trim() : '';
                const events = await readTeamEvents(teamName, cwd, {
                    afterEventId: afterEventId || undefined,
                    wakeableOnly: wakeableOnly ?? false,
                    type: eventType ?? undefined,
                    worker: worker || undefined,
                    taskId: taskId || undefined,
                });
                return { ok: true, operation, data: { count: events.length, cursor: events.at(-1)?.event_id ?? afterEventId, events } };
            }
            case 'await-event': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const timeoutMs = parseOptionalNonNegativeInteger(args.timeout_ms, 'timeout_ms') ?? 30_000;
                const pollMs = parseOptionalNonNegativeInteger(args.poll_ms, 'poll_ms');
                const wakeableOnly = parseOptionalBoolean(args.wakeable_only, 'wakeable_only');
                const eventType = parseOptionalEventType(args.type);
                const worker = typeof args.worker === 'string' ? args.worker.trim() : '';
                const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
                const result = await waitForTeamEvent(teamName, cwd, {
                    afterEventId: typeof args.after_event_id === 'string' ? args.after_event_id.trim() || undefined : undefined,
                    timeoutMs,
                    pollMs: pollMs ?? undefined,
                    wakeableOnly: wakeableOnly ?? false,
                    type: eventType ?? undefined,
                    worker: worker || undefined,
                    taskId: taskId || undefined,
                });
                return { ok: true, operation, data: { status: result.status, cursor: result.cursor, event: result.event ?? null } };
            }
            case 'read-idle-state': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const [summary, snapshot, events] = await Promise.all([
                    teamGetSummary(teamName, cwd),
                    teamReadMonitorSnapshot(teamName, cwd),
                    readTeamEvents(teamName, cwd),
                ]);
                if (!summary)
                    return { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
                const recentEvents = selectRecentEvents(events);
                return { ok: true, operation, data: buildIdleState(teamName, summary, snapshot, recentEvents) };
            }
            case 'read-stall-state': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const [summary, snapshot, events, pendingLeaderDispatch] = await Promise.all([
                    teamGetSummary(teamName, cwd),
                    teamReadMonitorSnapshot(teamName, cwd),
                    readTeamEvents(teamName, cwd),
                    listDispatchRequests(teamName, cwd, { status: 'pending', to_worker: 'leader-fixed' }),
                ]);
                if (!summary)
                    return { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
                const recentEvents = selectRecentEvents(events);
                return { ok: true, operation, data: buildStallState(teamName, summary, snapshot, recentEvents, pendingLeaderDispatch.length) };
            }
            case 'get-summary': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const summary = await teamGetSummary(teamName, cwd);
                return summary
                    ? { ok: true, operation, data: { summary } }
                    : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
            }
            case 'cleanup': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                await executeTeamCleanupViaRuntime(teamName, cwd);
                return { ok: true, operation, data: { team_name: teamName } };
            }
            case 'orphan-cleanup': {
                // Destructive escape hatch: calls teamCleanup directly, bypassing shutdown orchestration.
                // Native worktree recovery metadata/root AGENTS backups are protected unless callers
                // explicitly acknowledge that this force path may delete those recovery records.
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
                if (safety.hasEvidence && args.acknowledge_lost_worktree_recovery !== true) {
                    return {
                        ok: false,
                        operation,
                        error: {
                            code: 'invalid_input',
                            message: 'orphan_cleanup_blocked:worktree_recovery_evidence_present; pass acknowledge_lost_worktree_recovery=true only after manually preserving or intentionally discarding worker worktrees and root AGENTS backups',
                        },
                    };
                }
                await teamCleanup(teamName, cwd);
                return { ok: true, operation, data: { team_name: teamName } };
            }
            case 'write-shutdown-request': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                const requestedBy = String(opArgs.requested_by || '').trim();
                if (!teamName || !worker || !requestedBy) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, requested_by are required' } };
                }
                await teamWriteShutdownRequest(teamName, worker, requestedBy, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'read-shutdown-ack': {
                const teamName = String(opArgs.team_name || '').trim();
                const worker = String(opArgs.worker || '').trim();
                if (!teamName || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                }
                const ack = await teamReadShutdownAck(teamName, worker, cwd, opArgs.min_updated_at);
                return { ok: true, operation, data: { worker, ack } };
            }
            case 'read-monitor-snapshot': {
                const teamName = String(opArgs.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
                return { ok: true, operation, data: { snapshot } };
            }
            case 'write-monitor-snapshot': {
                const teamName = String(opArgs.team_name || '').trim();
                const snapshot = opArgs.snapshot;
                if (!teamName || !snapshot) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and snapshot are required' } };
                }
                await teamWriteMonitorSnapshot(teamName, snapshot, cwd);
                return { ok: true, operation, data: {} };
            }
            case 'read-task-approval': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                if (!teamName || !taskId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
                }
                const approval = await teamReadTaskApproval(teamName, taskId, cwd);
                return { ok: true, operation, data: { approval } };
            }
            case 'write-task-approval': {
                const teamName = String(opArgs.team_name || '').trim();
                const taskId = String(opArgs.task_id || '').trim();
                const status = String(opArgs.status || '').trim();
                const reviewer = String(opArgs.reviewer || '').trim();
                const decisionReason = String(opArgs.decision_reason || '').trim();
                if (!teamName || !taskId || !status || !reviewer || !decisionReason) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, status, reviewer, decision_reason are required' } };
                }
                if (!TEAM_TASK_APPROVAL_STATUSES.includes(status)) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `status must be one of: ${TEAM_TASK_APPROVAL_STATUSES.join(', ')}` } };
                }
                const rawRequired = args.required;
                if (rawRequired !== undefined && typeof rawRequired !== 'boolean') {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'required must be a boolean when provided' } };
                }
                await teamWriteTaskApproval(teamName, {
                    task_id: taskId,
                    required: rawRequired !== false,
                    status: status,
                    reviewer,
                    decision_reason: decisionReason,
                    decided_at: new Date().toISOString(),
                }, cwd);
                return { ok: true, operation, data: { task_id: taskId, status } };
            }
        }
    }
    catch (error) {
        if (error instanceof TeamLookupAmbiguityError) {
            return { ok: false, operation, error: { code: 'ambiguous_team_name', message: error.message, details: { candidates: error.candidates } } };
        }
        return {
            ok: false,
            operation,
            error: {
                code: 'operation_failed',
                message: error instanceof Error ? error.message : String(error),
            },
        };
    }
}
//# sourceMappingURL=api-interop.js.map