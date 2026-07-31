import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { TEAM_NAME_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN, TEAM_TASK_STATUSES, TEAM_EVENT_TYPES, TEAM_TASK_APPROVAL_STATUSES, } from './contracts.js';
import { teamSendMessage as sendDirectMessage, teamBroadcast as broadcastMessage, teamListMailbox as listMailboxMessages, teamMarkMessageDelivered as markMessageDelivered, teamMarkMessageNotified as markMessageNotified, teamCreateTask, teamReadTask, teamListTasks, teamUpdateTask, teamClaimTask, teamTransitionTaskStatus, teamReleaseTaskClaim, teamReadConfig, teamReadManifest, teamReadWorkerStatus, teamReadWorkerHeartbeat, teamUpdateWorkerHeartbeat, teamWriteWorkerInbox, teamWriteWorkerIdentity, teamAppendEvent, teamGetSummary, teamCleanup, teamWriteShutdownRequest, teamReadShutdownAck, teamReadMonitorSnapshot, teamWriteMonitorSnapshot, teamReadTaskApproval, teamWriteTaskApproval, teamPublishTaskRecoveryCheckpoint, teamReadCanonicalMailboxMessageStrict, } from './team-ops.js';
import { queueBroadcastMailboxMessage, queueDirectMailboxMessage, runMailboxNotificationAttempt, } from './mcp-comm.js';
import { verifyTeamTargetOwnership } from './tmux-session.js';
import { readDispatchRequestStrict } from './dispatch-queue.js';
import { readCurrentMailboxNotificationGuard, } from './mailbox-notification-guard.js';
import { listDispatchRequests, markDispatchRequestDelivered, markDispatchRequestNotified } from './dispatch-queue.js';
import { generateMailboxTriggerMessage } from './worker-bootstrap.js';
import { shutdownTeam } from './runtime.js';
import { shutdownTeamV2, recoverDeadWorkerV2, readRecoverDeadWorkerV2Outcome } from './runtime-v2.js';
import { isSafeRecoveryRequestId } from './recovery-request-store.js';
import { inspectTeamWorktreeCleanupSafety } from './git-worktree.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
const TEAM_UPDATE_TASK_MUTABLE_FIELDS = new Set(['subject', 'description', 'blocked_by', 'requires_code_change', 'delegation']);
const TEAM_UPDATE_TASK_REQUEST_FIELDS = new Set(['team_name', 'task_id', 'workingDirectory', ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);
const RECOVER_WORKER_REQUEST_FIELDS = new Set(['team_name', 'worker', 'request_id', 'timeout_ms']);
const WRITE_TASK_CHECKPOINT_REQUEST_FIELDS = new Set([
    'team_name', 'task_id', 'worker', 'claim_token', 'task_version', 'sequence', 'resume_payload',
]);
const READ_RECOVERY_RESULT_REQUEST_FIELDS = new Set(['team_name', 'request_id']);
const RECOVERY_ERROR_CODES = new Set([
    'invalid_input', 'team_not_found', 'worker_not_found', 'worker_not_dead', 'runtime_v2_required',
    'invalid_persisted_state', 'runtime_owner_unavailable', 'runtime_owner_fence_lost',
    'recovery_request_timeout', 'recovery_attempt_conflict', 'team_mutation_busy',
    'team_mutation_resume_required', 'team_shutting_down', 'team_session_dead',
    'worker_liveness_unknown', 'recovery_checkpoint_missing', 'recovery_checkpoint_malformed',
    'recovery_checkpoint_ambiguous', 'recovery_checkpoint_stale', 'task_requeue_failed',
    'launch_metadata_incomplete', 'launch_descriptor_unresolvable', 'spawn_failed',
    'startup_ack_timeout', 'worker_activation_failed', 'auto_merge_unavailable',
    'stale_state_revision', 'config_commit_failed',
]);
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
    'get-summary',
    'cleanup',
    'write-shutdown-request',
    'read-shutdown-ack',
    'read-monitor-snapshot',
    'write-monitor-snapshot',
    'read-task-approval',
    'write-task-approval',
    'orphan-cleanup',
    'recover-worker',
    'write-task-checkpoint',
    'read-recovery-result',
];
function isFiniteInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
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
    const teamRoot = join(getOmcRoot(candidateCwd), 'state', 'team', teamName);
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
export function resolveTeamApiCliCommand(env = process.env) {
    const hasOmcContext = ((typeof env.OMC_TEAM_WORKER === 'string' && env.OMC_TEAM_WORKER.trim() !== '')
        || (typeof env.OMC_TEAM_STATE_ROOT === 'string' && env.OMC_TEAM_STATE_ROOT.trim() !== ''));
    if (hasOmcContext)
        return 'omc team api';
    const hasOmxContext = ((typeof env.OMX_TEAM_WORKER === 'string' && env.OMX_TEAM_WORKER.trim() !== '')
        || (typeof env.OMX_TEAM_STATE_ROOT === 'string' && env.OMX_TEAM_STATE_ROOT.trim() !== ''));
    if (hasOmxContext)
        return 'omx team api';
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
    let config;
    try {
        config = await teamReadConfig(teamName, cwd);
    }
    catch (error) {
        assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
        throw error;
    }
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
    const teamRoot = join(getOmcRoot(candidateCwd), 'state', 'team', teamName);
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
const WORKTREE_TRIGGER_STATE_ROOT = '$OMC_TEAM_STATE_ROOT';
function resolveInstructionStateRoot(worktreePath) {
    return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}
function hasExactText(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}
/**
 * Older leader mailbox requests did not always persist pane_id. The leader
 * target is canonical config metadata, so rehydrate only that optional legacy
 * field for the strict guard; every durable identity field remains exact.
 */
async function readMailboxGuardWithCanonicalLeaderTarget(input, cwd) {
    let configPromise;
    const readConfig = () => {
        configPromise ??= teamReadConfig(input.teamName, cwd);
        return configPromise;
    };
    return readCurrentMailboxNotificationGuard(input, cwd, {
        readConfig,
        readStrictDispatchRequest: async (teamName, requestId, requestCwd) => {
            const [dispatch, config] = await Promise.all([
                readDispatchRequestStrict(teamName, requestId, requestCwd),
                readConfig(),
            ]);
            const canonicalLeaderPaneId = config?.leader_pane_id;
            if (dispatch.kind === 'valid'
                && input.recipient === 'leader-fixed'
                && dispatch.request.to_worker === 'leader-fixed'
                && dispatch.request.pane_id === undefined
                && hasExactText(canonicalLeaderPaneId)) {
                return { kind: 'valid', request: { ...dispatch.request, pane_id: canonicalLeaderPaneId } };
            }
            return dispatch;
        },
        readStrictMailboxMessage: teamReadCanonicalMailboxMessageStrict,
        verifyProviderOwnership: verifyTeamTargetOwnership,
    });
}
async function notifyMailboxTarget(params) {
    return runMailboxNotificationAttempt({
        teamName: params.teamName,
        recipient: params.toWorker,
        requestId: params.requestId,
        messageId: params.messageId,
        triggerMessage: params.triggerMessage,
        cwd: params.cwd,
    }, {
        readGuard: readMailboxGuardWithCanonicalLeaderTarget,
    });
}
function findWorkerDispatchTarget(teamName, toWorker, cwd) {
    return teamReadConfig(teamName, cwd).then((config) => {
        if (toWorker === 'leader-fixed') {
            return { paneId: config?.leader_pane_id ?? undefined };
        }
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
function validateCommonFields(args) {
    const teamName = String(args.team_name || '').trim();
    if (teamName && !TEAM_NAME_SAFE_PATTERN.test(teamName)) {
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
function unsupportedFields(args, allowed) {
    return Object.keys(args).filter((field) => !allowed.has(field));
}
function requiredString(args, field) {
    const value = args[field];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
export async function executeTeamApiOperation(operation, args, fallbackCwd) {
    try {
        validateCommonFields(args);
        const teamNameForCwd = String(args.team_name || '').trim();
        const cwd = teamNameForCwd ? resolveTeamWorkingDirectory(teamNameForCwd, fallbackCwd) : fallbackCwd;
        switch (operation) {
            case 'recover-worker': {
                const unsupported = unsupportedFields(args, RECOVER_WORKER_REQUEST_FIELDS);
                if (unsupported.length > 0) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `recover-worker received unsupported fields: ${unsupported.join(', ')}` } };
                }
                const teamName = requiredString(args, 'team_name');
                const workerName = requiredString(args, 'worker');
                const requestId = args.request_id;
                const timeoutMs = args.timeout_ms;
                const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : undefined;
                if (!teamName || !workerName || (requestId !== undefined && (normalizedRequestId === undefined || !isSafeRecoveryRequestId(normalizedRequestId)))
                    || (timeoutMs !== undefined && (!isFiniteInteger(timeoutMs) || timeoutMs < 180_000 || timeoutMs > 300_000))) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required; request_id must be a path-safe 1-128 character opaque identifier and timeout_ms must be an integer from 180000 through 300000 when provided' } };
                }
                let result;
                try {
                    result = await recoverDeadWorkerV2(teamName, cwd, {
                        workerName,
                        requestId: normalizedRequestId,
                        timeoutMs: timeoutMs,
                    });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (RECOVERY_ERROR_CODES.has(message)) {
                        return { ok: false, operation, error: { code: message, message } };
                    }
                    throw error;
                }
                return { ok: true, operation, data: { result } };
            }
            case 'write-task-checkpoint': {
                const unsupported = unsupportedFields(args, WRITE_TASK_CHECKPOINT_REQUEST_FIELDS);
                if (unsupported.length > 0) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: `write-task-checkpoint received unsupported fields: ${unsupported.join(', ')}` } };
                }
                const teamName = requiredString(args, 'team_name');
                const taskId = requiredString(args, 'task_id');
                const workerName = requiredString(args, 'worker');
                const claimToken = requiredString(args, 'claim_token');
                const taskVersion = args.task_version;
                const sequence = args.sequence;
                if (!teamName || !taskId || !workerName || !claimToken || !Object.hasOwn(args, 'resume_payload')
                    || !isFiniteInteger(taskVersion) || taskVersion <= 0 || !isFiniteInteger(sequence) || sequence <= 0) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, worker, claim_token, positive task_version, positive sequence, and resume_payload are required' } };
                }
                const workerContext = parseTeamWorkerContextFromEnv();
                if (!workerContext) {
                    return { ok: false, operation, error: { code: 'worker_auth_required', message: 'write-task-checkpoint requires OMC_TEAM_WORKER or OMX_TEAM_WORKER authentication' } };
                }
                if (workerContext.teamName !== teamName || workerContext.workerName !== workerName) {
                    return { ok: false, operation, error: { code: 'worker_auth_mismatch', message: 'authenticated worker does not match team_name and worker' } };
                }
                const result = await teamPublishTaskRecoveryCheckpoint({
                    teamName,
                    taskId,
                    workerName,
                    claimToken,
                    taskVersion,
                    sequence,
                    resumePayload: args.resume_payload,
                }, cwd);
                return result.ok
                    ? { ok: true, operation, data: result }
                    : { ok: false, operation, error: { code: result.error, message: result.error } };
            }
            case 'read-recovery-result': {
                const unsupported = unsupportedFields(args, READ_RECOVERY_RESULT_REQUEST_FIELDS);
                const teamName = requiredString(args, 'team_name');
                const requestId = requiredString(args, 'request_id');
                if (unsupported.length > 0 || !teamName || !requestId) {
                    return {
                        ok: false,
                        operation,
                        error: {
                            code: 'invalid_input',
                            message: unsupported.length > 0
                                ? `read-recovery-result received unsupported fields: ${unsupported.join(', ')}`
                                : 'team_name and request_id are required',
                        },
                    };
                }
                const outcome = readRecoverDeadWorkerV2Outcome(cwd, requestId);
                return outcome
                    ? { ok: true, operation, data: { outcome } }
                    : { ok: false, operation, error: { code: 'recovery_result_not_found', message: 'recovery_result_not_found' } };
            }
            case 'send-message': {
                const teamName = String(args.team_name || '').trim();
                const fromWorker = String(args.from_worker || '').trim();
                const toWorker = String(args.to_worker || '').trim();
                const body = String(args.body || '').trim();
                if (!fromWorker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'from_worker is required. You must identify yourself.' } };
                }
                if (!teamName || !toWorker || !body) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, to_worker, body are required' } };
                }
                let message = null;
                const target = await findWorkerDispatchTarget(teamName, toWorker, cwd);
                const notificationOutcome = await queueDirectMailboxMessage({
                    teamName,
                    fromWorker,
                    toWorker,
                    toWorkerIndex: target.workerIndex,
                    toPaneId: target.paneId,
                    body,
                    triggerMessage: generateMailboxTriggerMessage(teamName, toWorker, 1, target.instructionStateRoot),
                    cwd,
                    notify: (_target, resolvedTriggerMessage, context) => notifyMailboxTarget({
                        teamName,
                        toWorker: context.request.to_worker,
                        triggerMessage: resolvedTriggerMessage,
                        requestId: context.request.request_id,
                        messageId: context.message_id ?? context.request.message_id ?? '',
                        cwd,
                    }),
                    deps: {
                        sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
                            message = await sendDirectMessage(resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd);
                            return message;
                        },
                        broadcastMessage,
                        markMessageNotified: (resolvedTeamName, workerName, messageId, resolvedCwd) => markMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd),
                    },
                });
                return { ok: true, operation, data: { message, notification_outcome: notificationOutcome } };
            }
            case 'broadcast': {
                const teamName = String(args.team_name || '').trim();
                const fromWorker = String(args.from_worker || '').trim();
                const body = String(args.body || '').trim();
                if (!teamName || !fromWorker || !body) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, body are required' } };
                }
                const messages = [];
                const config = await teamReadConfig(teamName, cwd);
                if (!config)
                    throw new Error(`Team ${teamName} not found`);
                const recipients = config.workers
                    .filter((worker) => worker.name !== fromWorker)
                    .map((worker) => ({
                    workerName: worker.name,
                    workerIndex: worker.index,
                    paneId: worker.pane_id,
                    instructionStateRoot: resolveInstructionStateRoot(worker.worktree_path),
                }));
                const notificationOutcomes = await queueBroadcastMailboxMessage({
                    teamName,
                    fromWorker,
                    recipients,
                    body,
                    cwd,
                    triggerFor: (workerName) => generateMailboxTriggerMessage(teamName, workerName, 1, recipients.find((recipient) => recipient.workerName === workerName)?.instructionStateRoot),
                    notify: (_target, resolvedTriggerMessage, context) => notifyMailboxTarget({
                        teamName,
                        toWorker: context.request.to_worker,
                        triggerMessage: resolvedTriggerMessage,
                        requestId: context.request.request_id,
                        messageId: context.message_id ?? context.request.message_id ?? '',
                        cwd,
                    }),
                    deps: {
                        sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
                            const message = await sendDirectMessage(resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd);
                            messages.push(message);
                            return message;
                        },
                        // queueBroadcastMailboxMessage persists from the recipient snapshot via sendDirectMessage.
                        broadcastMessage: async () => [],
                        markMessageNotified: (resolvedTeamName, workerName, messageId, resolvedCwd) => markMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd),
                    },
                });
                return { ok: true, operation, data: { count: messages.length, messages, notification_outcomes: notificationOutcomes } };
            }
            case 'mailbox-list': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const includeDelivered = args.include_delivered !== false;
                if (!teamName || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                }
                const all = await listMailboxMessages(teamName, worker, cwd);
                const messages = includeDelivered ? all : all.filter((m) => !m.delivered_at);
                return { ok: true, operation, data: { worker, count: messages.length, messages } };
            }
            case 'mailbox-mark-delivered': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const messageId = String(args.message_id || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const messageId = String(args.message_id || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const subject = String(args.subject || '').trim();
                const description = String(args.description || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                if (!teamName || !taskId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
                }
                const task = await teamReadTask(teamName, taskId, cwd);
                return task
                    ? { ok: true, operation, data: { task } }
                    : { ok: false, operation, error: { code: 'task_not_found', message: 'task_not_found' } };
            }
            case 'list-tasks': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                }
                const tasks = await teamListTasks(teamName, cwd);
                return { ok: true, operation, data: { count: tasks.length, tasks } };
            }
            case 'update-task': {
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                const worker = String(args.worker || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                const from = String(args.from || '').trim();
                const to = String(args.to || '').trim();
                const claimToken = String(args.claim_token || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                const claimToken = String(args.claim_token || '').trim();
                const worker = String(args.worker || '').trim();
                if (!teamName || !taskId || !claimToken || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, claim_token, worker are required' } };
                }
                const result = await teamReleaseTaskClaim(teamName, taskId, claimToken, worker, cwd);
                return { ok: true, operation, data: result };
            }
            case 'read-config': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const config = await teamReadConfig(teamName, cwd);
                return config
                    ? { ok: true, operation, data: { config } }
                    : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
            }
            case 'read-manifest': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const manifest = await teamReadManifest(teamName, cwd);
                return manifest
                    ? { ok: true, operation, data: { manifest } }
                    : { ok: false, operation, error: { code: 'manifest_not_found', message: 'manifest_not_found' } };
            }
            case 'read-worker-status': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                if (!teamName || !worker)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                const status = await teamReadWorkerStatus(teamName, worker, cwd);
                return { ok: true, operation, data: { worker, status } };
            }
            case 'read-worker-heartbeat': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                if (!teamName || !worker)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
                return { ok: true, operation, data: { worker, heartbeat } };
            }
            case 'update-worker-heartbeat': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const content = String(args.content || '').trim();
                if (!teamName || !worker || !content) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, content are required' } };
                }
                await teamWriteWorkerInbox(teamName, worker, content, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'write-worker-identity': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const index = args.index;
                const role = String(args.role || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const eventType = String(args.type || '').trim();
                const worker = String(args.worker || '').trim();
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
            case 'get-summary': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const summary = await teamGetSummary(teamName, cwd);
                return summary
                    ? { ok: true, operation, data: { summary } }
                    : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
            }
            case 'cleanup': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                await executeTeamCleanupViaRuntime(teamName, cwd);
                return { ok: true, operation, data: { team_name: teamName } };
            }
            case 'orphan-cleanup': {
                // Destructive escape hatch: calls teamCleanup directly, bypassing shutdown orchestration.
                // Native worktree recovery metadata/root AGENTS backups are protected unless callers
                // explicitly acknowledge that this force path may delete those recovery records.
                const teamName = String(args.team_name || '').trim();
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
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                const requestedBy = String(args.requested_by || '').trim();
                if (!teamName || !worker || !requestedBy) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, requested_by are required' } };
                }
                await teamWriteShutdownRequest(teamName, worker, requestedBy, cwd);
                return { ok: true, operation, data: { worker } };
            }
            case 'read-shutdown-ack': {
                const teamName = String(args.team_name || '').trim();
                const worker = String(args.worker || '').trim();
                if (!teamName || !worker) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
                }
                const ack = await teamReadShutdownAck(teamName, worker, cwd, args.min_updated_at);
                return { ok: true, operation, data: { worker, ack } };
            }
            case 'read-monitor-snapshot': {
                const teamName = String(args.team_name || '').trim();
                if (!teamName)
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
                const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
                return { ok: true, operation, data: { snapshot } };
            }
            case 'write-monitor-snapshot': {
                const teamName = String(args.team_name || '').trim();
                const snapshot = args.snapshot;
                if (!teamName || !snapshot) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and snapshot are required' } };
                }
                await teamWriteMonitorSnapshot(teamName, snapshot, cwd);
                return { ok: true, operation, data: {} };
            }
            case 'read-task-approval': {
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                if (!teamName || !taskId) {
                    return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
                }
                const approval = await teamReadTaskApproval(teamName, taskId, cwd);
                return { ok: true, operation, data: { approval } };
            }
            case 'write-task-approval': {
                const teamName = String(args.team_name || '').trim();
                const taskId = String(args.task_id || '').trim();
                const status = String(args.status || '').trim();
                const reviewer = String(args.reviewer || '').trim();
                const decisionReason = String(args.decision_reason || '').trim();
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