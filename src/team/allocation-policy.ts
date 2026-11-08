// src/team/allocation-policy.ts

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Allocate tasks to workers using role-aware load balancing.
 *
 * When all workers share the same role (uniform pool), tasks are distributed
 * round-robin ordered by current load so no single worker is overloaded.
 *
 * When the pool is mixed, tasks are scored by role match + load penalty.
 */
export function allocateTasksToWorkers(
  tasks: TaskAllocationInput[],
  workers: WorkerAllocationInput[]
): AllocationResult[] {
  if (tasks.length === 0 || workers.length === 0) return [];

  const uniformRolePool = isUniformRolePool(workers);
  const results: AllocationResult[] = [];
  // Track in-flight assignments to keep load estimates current
  const loadMap = new Map<string, number>(workers.map(w => [w.name, w.currentLoad]));

  if (uniformRolePool) {
    for (const task of tasks) {
      const target = pickLeastLoaded(workers, loadMap);
      results.push({
        taskId: task.id,
        workerName: target.name,
        reason: `uniform pool round-robin (role=${target.role}, load=${loadMap.get(target.name)})`,
      });
      loadMap.set(target.name, (loadMap.get(target.name) ?? 0) + 1);
    }
  } else {
    for (const task of tasks) {
      const target = pickBestWorker(task, workers, loadMap);
      results.push({
        taskId: task.id,
        workerName: target.name,
        reason: `role match (task.role=${task.role ?? 'any'}, worker.role=${target.role}, load=${loadMap.get(target.name)})`,
      });
      loadMap.set(target.name, (loadMap.get(target.name) ?? 0) + 1);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when all workers share the same role.
 */
function isUniformRolePool(workers: WorkerAllocationInput[]): boolean {
  if (workers.length === 0) return true;
  const firstRole = workers[0].role;
  return workers.every(w => w.role === firstRole);
}

/**
 * Pick the worker with the lowest current load (ties broken by array order).
 */
function pickLeastLoaded(
  workers: WorkerAllocationInput[],
  loadMap: Map<string, number>
): WorkerAllocationInput {
  let best = workers[0];
  let bestLoad = loadMap.get(best.name) ?? 0;

  for (const w of workers) {
    const load = loadMap.get(w.name) ?? 0;
    if (load < bestLoad) {
      best = w;
      bestLoad = load;
    }
  }

  return best;
}

/**
 * Score each worker by role match + load penalty, pick the best.
 *
 * Scoring:
 * - Role exact match: +1.0
 * - No role hint on task (any worker acceptable): +0.5 base
 * - Load penalty: -0.2 per unit of current load
 */
function pickBestWorker(
  task: TaskAllocationInput,
  workers: WorkerAllocationInput[],
  loadMap: Map<string, number>
): WorkerAllocationInput {
  const scored = workers.map(w => {
    const load = loadMap.get(w.name) ?? 0;
    const roleScore = task.role
      ? w.role === task.role ? 1.0 : 0.0
      : 0.5; // no role hint — neutral
    const score = roleScore - load * 0.2;
    return { worker: w, score };
  });

  // Sort descending; stable tie-break by original array order (already stable in V8)
  scored.sort((a, b) => b.score - a.score);

  return scored[0].worker;
}
