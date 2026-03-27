import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  TEAM_NAME_SAFE_PATTERN,
  WORKER_NAME_SAFE_PATTERN,
  TASK_ID_SAFE_PATTERN,
  TEAM_TASK_STATUSES,
  TEAM_EVENT_TYPES,
  TEAM_TASK_APPROVAL_STATUSES,
  type TeamTaskStatus,
  type TeamEventType,
  type TeamTaskApprovalStatus,
} from './contracts.js';
import {
  teamSendMessage as sendDirectMessage,
  teamBroadcast as broadcastMessage,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageDelivered as markMessageDelivered,
  teamMarkMessageNotified as markMessageNotified,
  teamCreateTask,
  teamReadTask,
  teamListTasks,
  teamUpdateTask,
  teamClaimTask,
  teamTransitionTaskStatus,
  teamReleaseTaskClaim,
  teamReadConfig,
  teamReadManifest,
  teamReadWorkerStatus,
  teamReadWorkerHeartbeat,
  teamUpdateWorkerHeartbeat,
  teamWriteWorkerInbox,
  teamWriteWorkerIdentity,
  teamAppendEvent,
  teamGetSummary,
  teamCleanup,
  teamWriteShutdownRequest,
  teamReadShutdownAck,
  teamReadMonitorSnapshot,
  teamWriteMonitorSnapshot,
  teamReadTaskApproval,
  teamWriteTaskApproval,
  type TeamMonitorSnapshotState,
} from './team-ops.js';
import { queueBroadcastMailboxMessage, queueDirectMailboxMessage, type DispatchOutcome } from './mcp-comm.js';
import { injectToLeaderPane, sendToWorker } from './tmux-session.js';
import { listDispatchRequests, markDispatchRequestDelivered, markDispatchRequestNotified } from './dispatch-queue.js';
import { generateMailboxTriggerMessage } from './worker-bootstrap.js';
import { shutdownTeam } from './runtime.js';
import { shutdownTeamV2 } from './runtime-v2.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';

const TEAM_UPDATE_TASK_MUTABLE_FIELDS = new Set(['subject', 'description', 'blocked_by', 'requires_code_change']);
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
  'team_write_shutdown_request',
  'team_read_shutdown_ack',
  'team_read_monitor_snapshot',
  'team_write_monitor_snapshot',
  'team_read_task_approval',
  'team_write_task_approval',
] as const;

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
] as const;

export type TeamApiOperation = typeof TEAM_API_OPERATIONS[number];

export type TeamApiEnvelope =
  | { ok: true; operation: TeamApiOperation; data: Record<string, unknown> }
  | { ok: false; operation: TeamApiOperation | 'unknown'; error: { code: string; message: string } };

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function parseValidatedTaskIdArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of task IDs (strings)`);
  }
  const taskIds: string[] = [];
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

function teamStateExists(teamName: string, candidateCwd: string): boolean {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) return false;
  const teamRoot = join(candidateCwd, '.omc', 'state', 'team', teamName);
  return existsSync(join(teamRoot, 'config.json')) || existsSync(join(teamRoot, 'tasks')) || existsSync(teamRoot);
}

function parseTeamWorkerEnv(raw: string | undefined): { teamName: string; workerName: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

function parseTeamWorkerContextFromEnv(env: NodeJS.ProcessEnv = process.env): { teamName: string; workerName: string } | null {
  return parseTeamWorkerEnv(env.OMC_TEAM_WORKER) ?? parseTeamWorkerEnv(env.OMX_TEAM_WORKER);
}

function readTeamStateRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = typeof env.OMC_TEAM_STATE_ROOT === 'string' && env.OMC_TEAM_STATE_ROOT.trim() !== ''
    ? env.OMC_TEAM_STATE_ROOT.trim()
    : (typeof env.OMX_TEAM_STATE_ROOT === 'string' && env.OMX_TEAM_STATE_ROOT.trim() !== ''
      ? env.OMX_TEAM_STATE_ROOT.trim()
      : '');
  return candidate || null;
}

export function resolveTeamApiCliCommand(env: NodeJS.ProcessEnv = process.env): 'omc team api' | 'omx team api' {
  const hasOmcContext = (
    (typeof env.OMC_TEAM_WORKER === 'string' && env.OMC_TEAM_WORKER.trim() !== '')
    || (typeof env.OMC_TEAM_STATE_ROOT === 'string' && env.OMC_TEAM_STATE_ROOT.trim() !== '')
  );
  if (hasOmcContext) return 'omc team api';

  const hasOmxContext = (
    (typeof env.OMX_TEAM_WORKER === 'string' && env.OMX_TEAM_WORKER.trim() !== '')
    || (typeof env.OMX_TEAM_STATE_ROOT === 'string' && env.OMX_TEAM_STATE_ROOT.trim() !== '')
  );
  if (hasOmxContext) return 'omx team api';

  return 'omc team api';
}

function isRuntimeV2Config(config: unknown): config is { workers: unknown[] } {
  return !!config && typeof config === 'object' && Array.isArray((config as { workers?: unknown[] }).workers);
}

function isLegacyRuntimeConfig(config: unknown): config is { tmuxSession?: string; leaderPaneId?: string | null; tmuxOwnsWindow?: boolean } {
  return !!config && typeof config === 'object' && Array.isArray((config as { agentTypes?: unknown[] }).agentTypes);
}

async function executeTeamCleanupViaRuntime(teamName: string, cwd: string): Promise<void> {
  const config = await teamReadConfig(teamName, cwd) as unknown;

  if (!config) {
    await teamCleanup(teamName, cwd);
    return;
  }

  if (isRuntimeV2Config(config)) {
    await shutdownTeamV2(teamName, cwd);
    return;
  }

  if (isLegacyRuntimeConfig(config)) {
    const legacyConfig = config as { tmuxSession?: string; leaderPaneId?: string | null; tmuxOwnsWindow?: boolean };
    const sessionName = typeof legacyConfig.tmuxSession === 'string' && legacyConfig.tmuxSession.trim() !== ''
      ? legacyConfig.tmuxSession.trim()
      : `omc-team-${teamName}`;
    const leaderPaneId = typeof legacyConfig.leaderPaneId === 'string' && legacyConfig.leaderPaneId.trim() !== ''
      ? legacyConfig.leaderPaneId.trim()
      : undefined;
    await shutdownTeam(teamName, sessionName, cwd, 30_000, undefined, leaderPaneId, legacyConfig.tmuxOwnsWindow === true);
    return;
  }

  await teamCleanup(teamName, cwd);
}

function readTeamStateRootFromFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { team_state_root?: unknown };
    return typeof parsed.team_state_root === 'string' && parsed.team_state_root.trim() !== ''
      ? parsed.team_state_root.trim()
      : null;
  } catch {
    return null;
  }
}

function stateRootToWorkingDirectory(stateRoot: string): string {
  const absolute = resolvePath(stateRoot);
  const normalized = absolute.replaceAll('\\', '/');

  for (const marker of ['/.omc/state/team/', '/.omx/state/team/']) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const workspaceRoot = absolute.slice(0, idx);
      if (workspaceRoot && workspaceRoot !== '/') return workspaceRoot;
      return dirname(dirname(dirname(dirname(absolute))));
    }
  }

  for (const marker of ['/.omc/state', '/.omx/state']) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const workspaceRoot = absolute.slice(0, idx);
      if (workspaceRoot && workspaceRoot !== '/') return workspaceRoot;
      return dirname(dirname(absolute));
    }
  }

  return dirname(dirname(absolute));
}

function resolveTeamWorkingDirectoryFromMetadata(
  teamName: string,
  candidateCwd: string,
  workerContext: { teamName: string; workerName: string } | null,
): string | null {
  const teamRoot = join(candidateCwd, '.omc', 'state', 'team', teamName);
  if (!existsSync(teamRoot)) return null;

  if (workerContext?.teamName === teamName) {
    const workerRoot = readTeamStateRootFromFile(join(teamRoot, 'workers', workerContext.workerName, 'identity.json'));
    if (workerRoot) return stateRootToWorkingDirectory(workerRoot);
  }

  const fromConfig = readTeamStateRootFromFile(join(teamRoot, 'config.json'));
  if (fromConfig) return stateRootToWorkingDirectory(fromConfig);

  for (const manifestName of ['manifest.json', 'manifest.v2.json']) {
    const fromManifest = readTeamStateRootFromFile(join(teamRoot, manifestName));
    if (fromManifest) return stateRootToWorkingDirectory(fromManifest);
  }

  return null;
}

function resolveTeamWorkingDirectory(teamName: string, preferredCwd: string): string {
  const normalizedTeamName = String(teamName || '').trim();
  if (!normalizedTeamName) return preferredCwd;
  const envTeamStateRoot = readTeamStateRootFromEnv();
  if (typeof envTeamStateRoot === 'string' && envTeamStateRoot.trim() !== '') {
    return stateRootToWorkingDirectory(envTeamStateRoot.trim());
  }

  const seeds: string[] = [];
  for (const seed of [preferredCwd, process.cwd()]) {
    if (typeof seed !== 'string' || seed.trim() === '') continue;
    if (!seeds.includes(seed)) seeds.push(seed);
  }

  const workerContext = parseTeamWorkerContextFromEnv();
  for (const seed of seeds) {
    let cursor = seed;
    while (cursor) {
      if (teamStateExists(normalizedTeamName, cursor)) {
        return resolveTeamWorkingDirectoryFromMetadata(normalizedTeamName, cursor, workerContext) ?? cursor;
      }
      const parent = dirname(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
    }
  }
  return preferredCwd;
}

function normalizeTeamName(toolOrOperationName: string): string {
  const normalized = toolOrOperationName.trim().toLowerCase();
  const withoutPrefix = normalized.startsWith('team_') ? normalized.slice('team_'.length) : normalized;
  return withoutPrefix.replaceAll('_', '-');
}

export function resolveTeamApiOperation(name: string): TeamApiOperation | null {
  const normalized = normalizeTeamName(name);
  return TEAM_API_OPERATIONS.includes(normalized as TeamApiOperation) ? (normalized as TeamApiOperation) : null;
}

export function buildLegacyTeamDeprecationHint(
  legacyName: string,
  originalArgs?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
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

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

function queuedForHookDispatch(): DispatchOutcome {
  return {
    ok: true,
    transport: 'hook',
    reason: QUEUED_FOR_HOOK_DISPATCH_REASON,
  };
}

async function notifyMailboxTarget(
  teamName: string,
  toWorker: string,
  triggerMessage: string,
  cwd: string,
): Promise<DispatchOutcome> {
  const config = await teamReadConfig(teamName, cwd);
  if (!config) return queuedForHookDispatch();

  const sessionName = typeof config.tmux_session === 'string' ? config.tmux_session.trim() : '';
  if (!sessionName) return queuedForHookDispatch();

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
  if (!workerPaneId) return queuedForHookDispatch();

  const notified = await sendToWorker(sessionName, workerPaneId, triggerMessage);
  return notified
    ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_pane_notified' }
    : queuedForHookDispatch();
}

function findWorkerDispatchTarget(
  teamName: string,
  toWorker: string,
  cwd: string,
): Promise<{ paneId?: string; workerIndex?: number; instructionStateRoot?: string }>
{
  return teamReadConfig(teamName, cwd).then((config) => {
    const recipient = config?.workers.find((worker) => worker.name === toWorker);
    return {
      paneId: recipient?.pane_id,
      workerIndex: recipient?.index,
      instructionStateRoot: resolveInstructionStateRoot(recipient?.worktree_path),
    };
  });
}

async function findMailboxDispatchRequestId(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<string | null> {
  const requests = await listDispatchRequests(
    teamName,
    cwd,
    { kind: 'mailbox', to_worker: workerName },
  );
  const matching = requests
    .filter((request) => request.message_id === messageId)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return matching[0]?.request_id ?? null;
}

async function syncMailboxDispatchNotified(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<void> {
  const logDispatchSyncFailure = createSwallowedErrorLogger(
    'team.api-interop syncMailboxDispatchNotified dispatch state sync failed',
  );
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;
  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: 'mailbox_mark_notified' },
    cwd,
  ).catch(logDispatchSyncFailure);
}

async function syncMailboxDispatchDelivered(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<void> {
  const logDispatchSyncFailure = createSwallowedErrorLogger(
    'team.api-interop syncMailboxDispatchDelivered dispatch state sync failed',
  );
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;

  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: 'mailbox_mark_delivered' },
    cwd,
  ).catch(logDispatchSyncFailure);
  await markDispatchRequestDelivered(
    teamName,
    requestId,
    { message_id: messageId, last_reason: 'mailbox_mark_delivered' },
    cwd,
  ).catch(logDispatchSyncFailure);
}

function validateCommonFields(args: Record<string, unknown>): void {
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

export async function executeTeamApiOperation(
  operation: TeamApiOperation,
  args: Record<string, unknown>,
  fallbackCwd: string,
): Promise<TeamApiEnvelope> {
  try {
    validateCommonFields(args);
    const teamNameForCwd = String(args.team_name || '').trim();
    const cwd = teamNameForCwd ? resolveTeamWorkingDirectory(teamNameForCwd, fallbackCwd) : fallbackCwd;

    switch (operation) {
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

        let message: Awaited<ReturnType<typeof sendDirectMessage>> | null = null;
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
        const teamName = String(args.team_name || '').trim();
        const fromWorker = String(args.from_worker || '').trim();
        const body = String(args.body || '').trim();
        if (!teamName || !fromWorker || !body) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, body are required' } };
        }

        let messages: Awaited<ReturnType<typeof broadcastMessage>> = [];
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
          triggerFor: (workerName) => generateMailboxTriggerMessage(
            teamName,
            workerName,
            1,
            recipients.find((recipient) => recipient.workerName === workerName)?.instructionStateRoot,
          ),
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
        const owner = args.owner as string | undefined;
        const blockedBy = args.blocked_by as string[] | undefined;
        const requiresCodeChange = args.requires_code_change as boolean | undefined;
        const task = await teamCreateTask(teamName, {
          subject, description, status: 'pending', owner: owner || undefined, blocked_by: blockedBy, requires_code_change: requiresCodeChange,
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
        const lifecycleFields = ['status', 'owner', 'result', 'error'] as const;
        const presentLifecycleFields = lifecycleFields.filter((f) => f in args);
        if (presentLifecycleFields.length > 0) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task cannot mutate lifecycle fields: ${presentLifecycleFields.join(', ')}` } };
        }
        const unexpectedFields = Object.keys(args).filter((field) => !TEAM_UPDATE_TASK_REQUEST_FIELDS.has(field));
        if (unexpectedFields.length > 0) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task received unsupported fields: ${unexpectedFields.join(', ')}` } };
        }
        const updates: Record<string, unknown> = {};
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
          } catch (error) {
            return { ok: false, operation, error: { code: 'invalid_input', message: (error as Error).message } };
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
        const result = await teamClaimTask(teamName, taskId, worker, (rawExpectedVersion as number | undefined) ?? null, cwd);
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
      }
      case 'transition-task-status': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        const from = String(args.from || '').trim();
        const to = String(args.to || '').trim();
        const claimToken = String(args.claim_token || '').trim();
        if (!teamName || !taskId || !from || !to || !claimToken) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, from, to, claim_token are required' } };
        }
        const allowed = new Set<string>(TEAM_TASK_STATUSES);
        if (!allowed.has(from) || !allowed.has(to)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'from and to must be valid task statuses' } };
        }
        const result = await teamTransitionTaskStatus(teamName, taskId, from as TeamTaskStatus, to as TeamTaskStatus, claimToken, cwd);
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
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
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
      }
      case 'read-config': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const config = await teamReadConfig(teamName, cwd);
        return config
          ? { ok: true, operation, data: { config } }
          : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
      }
      case 'read-manifest': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const manifest = await teamReadManifest(teamName, cwd);
        return manifest
          ? { ok: true, operation, data: { manifest } }
          : { ok: false, operation, error: { code: 'manifest_not_found', message: 'manifest_not_found' } };
      }
      case 'read-worker-status': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        const status = await teamReadWorkerStatus(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, status } };
      }
      case 'read-worker-heartbeat': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, heartbeat } };
      }
      case 'update-worker-heartbeat': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const pid = args.pid as number;
        const turnCount = args.turn_count as number;
        const alive = args.alive as boolean;
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
        const index = args.index as number;
        const role = String(args.role || '').trim();
        if (!teamName || !worker || typeof index !== 'number' || !role) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, index, role are required' } };
        }
        await teamWriteWorkerIdentity(teamName, worker, {
          name: worker,
          index,
          role,
          assigned_tasks: (args.assigned_tasks as string[] | undefined) ?? [],
          pid: args.pid as number | undefined,
          pane_id: args.pane_id as string | undefined,
          working_dir: args.working_dir as string | undefined,
          worktree_path: args.worktree_path as string | undefined,
          worktree_branch: args.worktree_branch as string | undefined,
          worktree_detached: args.worktree_detached as boolean | undefined,
          team_state_root: args.team_state_root as string | undefined,
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
        if (!TEAM_EVENT_TYPES.includes(eventType as TeamEventType)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `type must be one of: ${TEAM_EVENT_TYPES.join(', ')}` } };
        }
        const event = await teamAppendEvent(teamName, {
          type: eventType as TeamEventType,
          worker,
          task_id: args.task_id as string | undefined,
          message_id: (args.message_id as string | undefined) ?? null,
          reason: args.reason as string | undefined,
        }, cwd);
        return { ok: true, operation, data: { event } };
      }
      case 'get-summary': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const summary = await teamGetSummary(teamName, cwd);
        return summary
          ? { ok: true, operation, data: { summary } }
          : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
      }
      case 'cleanup': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        await executeTeamCleanupViaRuntime(teamName, cwd);
        return { ok: true, operation, data: { team_name: teamName } };
      }
      case 'orphan-cleanup': {
        // Destructive escape hatch: always calls teamCleanup directly, bypasses shutdown orchestration
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
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
        const ack = await teamReadShutdownAck(teamName, worker, cwd, args.min_updated_at as string | undefined);
        return { ok: true, operation, data: { worker, ack } };
      }
      case 'read-monitor-snapshot': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
        return { ok: true, operation, data: { snapshot } };
      }
      case 'write-monitor-snapshot': {
        const teamName = String(args.team_name || '').trim();
        const snapshot = args.snapshot as TeamMonitorSnapshotState | undefined;
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
        if (!TEAM_TASK_APPROVAL_STATUSES.includes(status as TeamTaskApprovalStatus)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `status must be one of: ${TEAM_TASK_APPROVAL_STATUSES.join(', ')}` } };
        }
        const rawRequired = args.required;
        if (rawRequired !== undefined && typeof rawRequired !== 'boolean') {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'required must be a boolean when provided' } };
        }
        await teamWriteTaskApproval(teamName, {
          task_id: taskId,
          required: rawRequired !== false,
          status: status as TeamTaskApprovalStatus,
          reviewer,
          decision_reason: decisionReason,
          decided_at: new Date().toISOString(),
        }, cwd);
        return { ok: true, operation, data: { task_id: taskId, status } };
      }
    }
  } catch (error) {
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
