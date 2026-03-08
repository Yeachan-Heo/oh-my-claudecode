/**
 * Team event system — JSONL-based append-only event log.
 *
 * Mirrors OMX appendTeamEvent semantics. All team-significant actions
 * (task completions, failures, worker state changes, shutdown gates)
 * are recorded as structured events for observability and replay.
 *
 * Events are appended to: .omc/state/team/{teamName}/events.jsonl
 */
import type { TeamEventType } from './contracts.js';
import type { TeamEvent } from './types.js';
/**
 * Append a team event to the JSONL event log.
 * Thread-safe via atomic append (O_WRONLY|O_APPEND|O_CREAT).
 */
export declare function appendTeamEvent(teamName: string, event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>, cwd: string): Promise<TeamEvent>;
/**
 * Read all events for a team from the JSONL log.
 * Returns empty array if no events exist.
 */
export declare function readTeamEvents(teamName: string, cwd: string): Promise<TeamEvent[]>;
/**
 * Read events of a specific type for a team.
 */
export declare function readTeamEventsByType(teamName: string, eventType: TeamEventType, cwd: string): Promise<TeamEvent[]>;
/**
 * Emit monitor-derived events by comparing current task/worker state
 * against the previous monitor snapshot. This detects:
 * - task_completed: task transitioned to 'completed'
 * - task_failed: task transitioned to 'failed'
 * - worker_idle: worker was working but is now idle
 * - worker_stopped: worker was alive but is now dead
 */
export declare function emitMonitorDerivedEvents(teamName: string, tasks: Array<{
    id: string;
    status: string;
}>, workers: Array<{
    name: string;
    alive: boolean;
    status: {
        state: string;
    };
}>, previousSnapshot: {
    taskStatusById?: Record<string, string>;
    workerAliveByName?: Record<string, boolean>;
    workerStateByName?: Record<string, string>;
    completedEventTaskIds?: Record<string, boolean>;
} | null, cwd: string): Promise<void>;
//# sourceMappingURL=events.d.ts.map