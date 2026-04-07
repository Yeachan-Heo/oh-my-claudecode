import type { TeamConfig, WorkerInfo } from './types.js';

export interface WorkerCanonicalizationResult {
  workers: WorkerInfo[];
  duplicateNames: string[];
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAssignedTasks(worker: WorkerInfo): boolean {
  return Array.isArray(worker.assigned_tasks) && worker.assigned_tasks.length > 0;
}

function workerPriority(worker: WorkerInfo): number {
  if (hasText(worker.pane_id)) return 4;
  if (typeof worker.pid === 'number' && Number.isFinite(worker.pid)) return 3;
  if (hasAssignedTasks(worker)) return 2;
  if (typeof worker.index === 'number' && worker.index > 0) return 1;
  return 0;
}

function mergeAssignedTasks(primary: string[] | undefined, secondary: string[] | undefined): string[] {
  const merged: string[] = [];
  for (const taskId of [...(primary ?? []), ...(secondary ?? [])]) {
    if (typeof taskId !== 'string' || taskId.trim() === '' || merged.includes(taskId)) continue;
    merged.push(taskId);
  }
  return merged;
}

function backfillText(primary: string | undefined, secondary: string | undefined): string | undefined {
  return hasText(primary) ? primary : secondary;
}

function backfillBoolean(primary: boolean | undefined, secondary: boolean | undefined): boolean | undefined {
  return typeof primary === 'boolean' ? primary : secondary;
}

function backfillNumber(primary: number | undefined, secondary: number | undefined, predicate?: (value: number) => boolean): number | undefined {
  const isUsable = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && (predicate ? predicate(value) : true);
  return isUsable(primary) ? primary : isUsable(secondary) ? secondary : undefined;
}

function chooseWinningWorker(existing: WorkerInfo, incoming: WorkerInfo): { winner: WorkerInfo; loser: WorkerInfo } {
  const existingPriority = workerPriority(existing);
  const incomingPriority = workerPriority(incoming);
  if (incomingPriority > existingPriority) return { winner: incoming, loser: existing };
  if (incomingPriority < existingPriority) return { winner: existing, loser: incoming };
  if ((incoming.index ?? 0) >= (existing.index ?? 0)) return { winner: incoming, loser: existing };
  return { winner: existing, loser: incoming };
}

export function canonicalizeWorkers(workers: WorkerInfo[]): WorkerCanonicalizationResult {
  const byName = new Map<string, WorkerInfo>();
  const duplicateNames = new Set<string>();

  for (const worker of workers) {
    const name = typeof worker.name === 'string' ? worker.name.trim() : '';
    if (!name) continue;

    const normalized: WorkerInfo = {
      ...worker,
      name,
      assigned_tasks: Array.isArray(worker.assigned_tasks) ? worker.assigned_tasks : [],
    };

    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, normalized);
      continue;
    }

    duplicateNames.add(name);
    const { winner, loser } = chooseWinningWorker(existing, normalized);
    byName.set(name, {
      ...winner,
      name,
      assigned_tasks: mergeAssignedTasks(winner.assigned_tasks, loser.assigned_tasks),
      pane_id: backfillText(winner.pane_id, loser.pane_id),
      pid: backfillNumber(winner.pid, loser.pid),
      index: backfillNumber(winner.index, loser.index, (value) => value > 0) ?? 0,
      role: backfillText(winner.role, loser.role) ?? winner.role,
      worker_cli: backfillText(winner.worker_cli, loser.worker_cli) as WorkerInfo['worker_cli'],
      working_dir: backfillText(winner.working_dir, loser.working_dir),
      worktree_path: backfillText(winner.worktree_path, loser.worktree_path),
      worktree_branch: backfillText(winner.worktree_branch, loser.worktree_branch),
      worktree_detached: backfillBoolean(winner.worktree_detached, loser.worktree_detached),
      team_state_root: backfillText(winner.team_state_root, loser.team_state_root),
    });
  }

  return {
    workers: Array.from(byName.values()),
    duplicateNames: Array.from(duplicateNames.values()),
  };
}

export function canonicalizeTeamConfigWorkers(config: TeamConfig): TeamConfig {
  const { workers, duplicateNames } = canonicalizeWorkers(config.workers ?? []);
  if (duplicateNames.length > 0) {
    console.warn(
      `[team] canonicalized duplicate worker entries: ${duplicateNames.join(', ')}`
    );
  }
  return {
    ...config,
    workers,
    worker_count: workers.length,
  };
}
