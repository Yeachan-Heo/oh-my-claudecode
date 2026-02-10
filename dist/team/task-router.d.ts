/**
 * Smart task routing based on worker capabilities and availability.
 *
 * Assigns unassigned tasks to the best available workers by combining:
 * - Capability fitness scoring
 * - Worker availability (not dead, not quarantined)
 * - Current load (prefer idle workers)
 */
import type { TaskFile, WorkerCapability, WorkerBackend } from './types.js';
export interface TaskRoutingDecision {
    taskId: string;
    assignedTo: string;
    backend: WorkerBackend;
    reason: string;
    confidence: number;
}
/**
 * Automatically assign tasks to the best available workers.
 * Uses capability scoring + worker availability + current load.
 *
 * @param teamName - Team identifier
 * @param workingDirectory - Working directory for team data
 * @param unassignedTasks - Tasks without an owner
 * @param requiredCapabilities - Optional map of taskId -> required capabilities
 * @returns Array of routing decisions
 */
export declare function routeTasks(teamName: string, workingDirectory: string, unassignedTasks: TaskFile[], requiredCapabilities?: Record<string, WorkerCapability[]>): TaskRoutingDecision[];
//# sourceMappingURL=task-router.d.ts.map