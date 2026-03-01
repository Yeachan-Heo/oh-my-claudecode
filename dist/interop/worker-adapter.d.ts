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
import type { TaskFile, DoneSignal, OutboxMessage } from '../team/types.js';
import type { CliAgentType } from '../team/model-contract.js';
import type { TeamConfig } from '../team/runtime.js';
import { type OmxTeamConfig, type OmxTeamTask, type OmxTeamMailboxMessage } from './omx-team-state.js';
import type { AdapterContext, StatusAnnotation, WorkerInteropConfig } from './adapter-types.js';
/**
 * Map OMX task status to OMC TaskFile status.
 *
 * OMX has 5 statuses: pending | blocked | in_progress | completed | failed
 * OMC has 4 statuses: pending | in_progress | completed | failed
 *
 * Only lossy mapping: OMX 'blocked' → OMC 'pending' (with metadata annotation)
 */
export declare function omxStatusToOmc(status: OmxTeamTask['status']): {
    status: TaskFile['status'];
    annotation: StatusAnnotation;
};
/**
 * Map OMC TaskFile status to OMX task status.
 *
 * Checks metadata for round-trip recovery of lossy mappings (e.g., 'blocked').
 */
export declare function omcStatusToOmx(status: TaskFile['status'], metadata?: Record<string, unknown>): OmxTeamTask['status'];
/**
 * Map OMX worker role string to OMC CliAgentType.
 */
export declare function mapOmxRoleToCliAgent(role: string): CliAgentType;
/**
 * Translate OMC TeamConfig to OMX OmxTeamConfig.
 */
export declare function teamConfigToOmx(config: TeamConfig): OmxTeamConfig;
/**
 * Translate OMX OmxTeamConfig to OMC TeamConfig.
 * Caller should override `cwd` on the returned config.
 */
export declare function omxConfigToTeam(config: OmxTeamConfig, tasks: OmxTeamTask[], cwd: string): TeamConfig;
/**
 * Translate OMX OmxTeamTask to OMC TaskFile.
 */
export declare function omxTaskToTaskFile(task: OmxTeamTask): TaskFile;
/**
 * Translate OMC TaskFile to OMX OmxTeamTask.
 */
export declare function taskFileToOmxTask(task: TaskFile): OmxTeamTask;
/**
 * Bootstrap an OMX-format worker from an OMC lead.
 *
 * Writes an OMX-format mailbox message so the OMX worker can read its
 * assignment in native format.
 *
 * NARROW EXCEPTION (Principle 2a): writes to .omx/ during spawn initialization
 * only when interopMode === 'active'.
 */
export declare function bridgeBootstrapToOmx(ctx: AdapterContext, workerName: string, task: {
    id: string;
    subject: string;
    description: string;
}): Promise<void>;
/**
 * Bootstrap an OMC-format worker from an OMX lead.
 *
 * Creates AGENTS.md overlay + inbox.md so the OMC worker can bootstrap
 * in its native format.
 */
export declare function bridgeBootstrapToOmc(ctx: AdapterContext, workerName: string, agentType: CliAgentType, task: {
    id: string;
    subject: string;
    description: string;
}): Promise<void>;
/**
 * Poll OMX task file for completion and synthesize a DoneSignal.
 *
 * READS from .omx/ (allowed in any mode).
 * WRITES synthesized done.json to .omc/ worker state dir (Principle 2 compliant).
 *
 * Returns the DoneSignal if the task is terminal, null otherwise.
 */
export declare function pollOmxCompletion(ctx: AdapterContext, workerName: string, taskId: string): Promise<DoneSignal | null>;
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
export declare function bridgeDoneSignalToOmx(ctx: AdapterContext, workerName: string, doneSignal: DoneSignal): Promise<void>;
/**
 * Translate OMC OutboxMessage to OMX OmxTeamMailboxMessage.
 */
export declare function outboxMessageToOmxMailbox(msg: OutboxMessage, fromWorker: string, toWorker: string): OmxTeamMailboxMessage;
/**
 * Translate OMX OmxTeamMailboxMessage to OMC inbox markdown format.
 * Compatible with appendToInbox() function.
 */
export declare function omxMailboxToInboxMarkdown(msg: OmxTeamMailboxMessage): string;
/**
 * Determine if a worker config indicates OMX state conventions.
 */
export declare function isOmxWorker(config: WorkerInteropConfig): boolean;
//# sourceMappingURL=worker-adapter.d.ts.map