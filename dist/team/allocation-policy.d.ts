/**
 * Task allocation policy for team worker assignment.
 *
 * Handles two distribution strategies:
 * - Uniform role pool: round-robin by current load (avoids piling on worker-1)
 * - Mixed roles: score by role match + load balancing
 */
export interface TaskAllocationInput {
    id: string;
    subject: string;
    description: string;
    /** Desired role hint (from role-router or explicit assignment) */
    role?: string;
}
export interface WorkerAllocationInput {
    name: string;
    role: string;
    currentLoad: number;
}
export interface AllocationResult {
    taskId: string;
    workerName: string;
    reason: string;
}
/**
 * Allocate tasks to workers using role-aware load balancing.
 *
 * When all workers share the same role (uniform pool), tasks are distributed
 * round-robin ordered by current load so no single worker is overloaded.
 *
 * When the pool is mixed, tasks are scored by role match + load penalty.
 */
export declare function allocateTasksToWorkers(tasks: TaskAllocationInput[], workers: WorkerAllocationInput[]): AllocationResult[];
//# sourceMappingURL=allocation-policy.d.ts.map