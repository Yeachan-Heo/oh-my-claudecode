/**
 * OMC-OMX Worker Adapter
 *
 * Bidirectional translation between OMC and OMX state formats at
 * worker lifecycle boundaries. Composes omx-team-state.ts read functions
 * for OMX data access.
 *
 * Design: .omc/plans/interop-design.md (issue #1117)
 *
 * Write policy (Principle 2 + 2a):
 *   - Ongoing operation: READ .omx/, WRITE only to .omc/
 *   - Spawn initialization: may WRITE to .omx/ when interopMode === 'active'
 */

import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWriteJson } from '../lib/atomic-write.js';
import type { TaskFile, DoneSignal, OutboxMessage } from '../team/types.js';
import type { CliAgentType } from '../team/model-contract.js';
import type { TeamConfig } from '../team/runtime.js';
import {
  readOmxTeamConfig, readOmxTask, listOmxTasks,
  appendOmxTeamEvent,
  type OmxTeamConfig, type OmxTeamTask, type OmxTeamMailboxMessage,
} from './omx-team-state.js';
import type {
  AdapterContext, StatusAnnotation, WorkerInteropConfig,
} from './adapter-types.js';
import {
  generateWorkerOverlay, composeInitialInbox, ensureWorkerStateDir,
  writeWorkerOverlay,
} from '../team/worker-bootstrap.js';

// ============================================================================
// Status Mapping (Step 1 + Step 3)
// ============================================================================

/**
 * Map OMX task status to OMC TaskFile status.
 *
 * OMX has 5 statuses: pending | blocked | in_progress | completed | failed
 * OMC has 4 statuses: pending | in_progress | completed | failed
 *
 * Only lossy mapping: OMX 'blocked' → OMC 'pending' (with metadata annotation)
 */
export function omxStatusToOmc(
  status: OmxTeamTask['status'],
): { status: TaskFile['status']; annotation: StatusAnnotation } {
  const now = new Date().toISOString();

  if (status === 'blocked') {
    return {
      status: 'pending',
      annotation: {
        originalSystem: 'omx',
        originalStatus: 'blocked',
        mappedStatus: 'pending',
        mappedAt: now,
        lossy: true,
      },
    };
  }

  // Direct mappings: pending, in_progress, completed, failed
  const directMap: Record<string, TaskFile['status']> = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
    failed: 'failed',
  };

  const mapped = directMap[status] ?? 'pending';
  return {
    status: mapped,
    annotation: {
      originalSystem: 'omx',
      originalStatus: status,
      mappedStatus: mapped,
      mappedAt: now,
      lossy: false,
    },
  };
}

/**
 * Map OMC TaskFile status to OMX task status.
 *
 * Checks metadata for round-trip recovery of lossy mappings (e.g., 'blocked').
 */
export function omcStatusToOmx(
  status: TaskFile['status'],
  metadata?: Record<string, unknown>,
): OmxTeamTask['status'] {
  // Check for round-trip recovery via metadata annotation
  const interop = metadata?._interop as StatusAnnotation | undefined;
  if (interop?.lossy && interop.originalSystem === 'omx' && interop.originalStatus) {
    return interop.originalStatus as OmxTeamTask['status'];
  }

  // Direct mappings
  const directMap: Record<string, OmxTeamTask['status']> = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
    failed: 'failed',
  };

  return directMap[status] ?? 'pending';
}

// ============================================================================
// Config Translation (Step 2)
// ============================================================================

/**
 * Map OMX worker role string to OMC CliAgentType.
 */
export function mapOmxRoleToCliAgent(role: string): CliAgentType {
  const normalized = role.toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'gemini') return 'gemini';
  // executor, coder, developer, and anything else → claude
  return 'claude';
}

/**
 * Translate OMC TeamConfig to OMX OmxTeamConfig.
 */
export function teamConfigToOmx(config: TeamConfig): OmxTeamConfig {
  return {
    name: config.teamName,
    task: config.tasks.map(t => t.subject).join('; '),
    agent_type: config.agentTypes[0] ?? 'claude',
    worker_count: config.workerCount,
    max_workers: config.workerCount,
    workers: config.agentTypes.map((type, i) => ({
      name: `worker-${i + 1}`,
      index: i,
      role: type,
      assigned_tasks: [] as string[],
    })),
    created_at: new Date().toISOString(),
    tmux_session: `omc-team-${config.teamName}`,
    next_task_id: config.tasks.length + 1,
  };
}

/**
 * Translate OMX OmxTeamConfig to OMC TeamConfig.
 * Caller should override `cwd` on the returned config.
 */
export function omxConfigToTeam(
  config: OmxTeamConfig,
  tasks: OmxTeamTask[],
  cwd: string,
): TeamConfig {
  return {
    teamName: config.name,
    workerCount: config.worker_count,
    agentTypes: config.workers.map(w => mapOmxRoleToCliAgent(w.role)),
    tasks: tasks.map(t => ({ subject: t.subject, description: t.description })),
    cwd,
  };
}

// ============================================================================
// Task Translation (Step 3)
// ============================================================================

/**
 * Translate OMX OmxTeamTask to OMC TaskFile.
 */
export function omxTaskToTaskFile(task: OmxTeamTask): TaskFile {
  const { status, annotation } = omxStatusToOmc(task.status);
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status,
    owner: task.owner ?? '',
    blocks: [],
    blockedBy: task.blocked_by ?? task.depends_on ?? [],
    metadata: {
      _interop: annotation,
      ...(task.error ? { _interopError: task.error } : {}),
      ...(task.result ? { _interopResult: task.result } : {}),
    },
  };
}

/**
 * Translate OMC TaskFile to OMX OmxTeamTask.
 */
export function taskFileToOmxTask(task: TaskFile): OmxTeamTask {
  // Check for lossy round-trip recovery via metadata annotation
  const interopMeta = task.metadata?._interop as StatusAnnotation | undefined;
  const actualStatus = interopMeta?.lossy && interopMeta.originalStatus
    ? interopMeta.originalStatus as OmxTeamTask['status']
    : omcStatusToOmx(task.status, task.metadata);

  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: actualStatus,
    owner: task.owner || undefined,
    blocked_by: task.blockedBy.length > 0 ? task.blockedBy : undefined,
    depends_on: task.blockedBy.length > 0 ? task.blockedBy : undefined,
    created_at: new Date().toISOString(),
    ...(task.metadata?._interopError ? { error: String(task.metadata._interopError) } : {}),
    ...(task.metadata?._interopResult ? { result: String(task.metadata._interopResult) } : {}),
  };
}

// ============================================================================
// Worker Lifecycle Bridging (Step 4)
// ============================================================================

// --- 4a: Bootstrap Translation ---

/**
 * Bootstrap an OMX-format worker from an OMC lead.
 *
 * Writes an OMX-format mailbox message so the OMX worker can read its
 * assignment in native format.
 *
 * NARROW EXCEPTION (Principle 2a): writes to .omx/ during spawn initialization
 * only when interopMode === 'active'.
 */
export async function bridgeBootstrapToOmx(
  ctx: AdapterContext,
  workerName: string,
  task: { id: string; subject: string; description: string },
): Promise<void> {
  if (ctx.interopMode !== 'active') return;

  const message: OmxTeamMailboxMessage = {
    message_id: randomUUID(),
    from_worker: 'omc-lead',
    to_worker: workerName,
    body: `## Task Assignment\nTask ID: ${task.id}\nSubject: ${task.subject}\n\n${task.description}`,
    created_at: new Date().toISOString(),
  };

  const mailboxPath = join(
    ctx.cwd, '.omx', 'state', 'team', ctx.teamName,
    'mailbox', `${workerName}.json`,
  );
  await mkdir(dirname(mailboxPath), { recursive: true });
  await atomicWriteJson(mailboxPath, { worker: workerName, messages: [message] });
}

/**
 * Bootstrap an OMC-format worker from an OMX lead.
 *
 * Creates AGENTS.md overlay + inbox.md so the OMC worker can bootstrap
 * in its native format.
 */
export async function bridgeBootstrapToOmc(
  ctx: AdapterContext,
  workerName: string,
  agentType: CliAgentType,
  task: { id: string; subject: string; description: string },
): Promise<void> {
  await ensureWorkerStateDir(ctx.teamName, workerName, ctx.cwd);
  await writeWorkerOverlay({
    teamName: ctx.teamName,
    workerName,
    agentType,
    tasks: [task],
    cwd: ctx.cwd,
  });

  const instruction = [
    `# Task Assignment`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Subject:** ${task.subject}`,
    ``,
    task.description,
  ].join('\n');
  await composeInitialInbox(ctx.teamName, workerName, instruction, ctx.cwd);
}

// --- 4b: Completion Signal Translation (done.json shim) ---

/**
 * Poll OMX task file for completion and synthesize a DoneSignal.
 *
 * READS from .omx/ (allowed in any mode).
 * WRITES synthesized done.json to .omc/ worker state dir (Principle 2 compliant).
 *
 * Returns the DoneSignal if the task is terminal, null otherwise.
 */
export async function pollOmxCompletion(
  ctx: AdapterContext,
  workerName: string,
  taskId: string,
): Promise<DoneSignal | null> {
  const task = await readOmxTask(ctx.teamName, taskId, ctx.cwd);
  if (!task) return null;

  if (task.status === 'completed' || task.status === 'failed') {
    const signal: DoneSignal = {
      taskId: task.id,
      status: task.status,
      summary: task.result ?? task.error ?? `Task ${task.status}`,
      completedAt: task.completed_at ?? new Date().toISOString(),
    };

    // Write done.json shim to .omc/ (not .omx/) so existing watchdog picks it up
    const donePath = join(
      ctx.cwd, '.omc', 'state', 'team', ctx.teamName,
      'workers', workerName, 'done.json',
    );
    await mkdir(dirname(donePath), { recursive: true });
    await atomicWriteJson(donePath, signal);

    return signal;
  }
  return null;
}

/**
 * Bridge an OMC worker's DoneSignal to OMX task file format.
 *
 * Used when OMX is the lead: translates done.json into an OMX task file
 * status update + event log entry.
 *
 * Note: appendOmxTeamEvent is marked @deprecated for the old interop pattern,
 * but is intentionally used here — the adapter is the new canonical write path
 * for the OMX-lead direction.
 */
export async function bridgeDoneSignalToOmx(
  ctx: AdapterContext,
  workerName: string,
  doneSignal: DoneSignal,
): Promise<void> {
  const task = await readOmxTask(ctx.teamName, doneSignal.taskId, ctx.cwd);
  if (task) {
    task.status = doneSignal.status;
    task.result = doneSignal.summary;
    task.completed_at = doneSignal.completedAt;
    if (doneSignal.status === 'failed') {
      task.error = doneSignal.summary;
    }
    const taskPath = join(
      ctx.cwd, '.omx', 'state', 'team', ctx.teamName,
      'tasks', `task-${doneSignal.taskId}.json`,
    );
    await atomicWriteJson(taskPath, task);
  }

  // Append event to OMX event log
  await appendOmxTeamEvent(ctx.teamName, {
    type: 'task_completed',
    worker: workerName,
    task_id: doneSignal.taskId,
  }, ctx.cwd);
}

// ============================================================================
// Message Format Bridging (Step 5)
// ============================================================================

/**
 * Translate OMC OutboxMessage to OMX OmxTeamMailboxMessage.
 */
export function outboxMessageToOmxMailbox(
  msg: OutboxMessage,
  fromWorker: string,
  toWorker: string,
): OmxTeamMailboxMessage {
  return {
    message_id: randomUUID(),
    from_worker: fromWorker,
    to_worker: toWorker,
    body: msg.message ?? msg.summary ?? JSON.stringify(msg),
    created_at: msg.timestamp,
  };
}

/**
 * Translate OMX OmxTeamMailboxMessage to OMC inbox markdown format.
 * Compatible with appendToInbox() function.
 */
export function omxMailboxToInboxMarkdown(msg: OmxTeamMailboxMessage): string {
  return [
    `---`,
    `## Message from ${msg.from_worker}`,
    `*${msg.created_at}*`,
    ``,
    msg.body,
  ].join('\n');
}

// ============================================================================
// Utility: check if a worker uses OMX conventions
// ============================================================================

/**
 * Determine if a worker config indicates OMX state conventions.
 */
export function isOmxWorker(config: WorkerInteropConfig): boolean {
  return config.interopMode === 'omx';
}
