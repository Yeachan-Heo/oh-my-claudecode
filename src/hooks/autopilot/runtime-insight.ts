import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getOmcRoot, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import { readHudState } from '../../hud/state.js';
import type { BackgroundTask } from '../../hud/types.js';
import type { TeamTask, WorkerStatus } from '../../team/types.js';

interface MissingDependencyIssue {
  teamName: string;
  taskId: string;
  missingDependencyIds: string[];
}

interface WorkerIssue {
  teamName: string;
  workerName: string;
  state: WorkerStatus['state'];
  reason: string;
}

interface RuntimeInsightSnapshot {
  missingDependencyIssues: MissingDependencyIssue[];
  workerIssues: WorkerIssue[];
  failedBackgroundTasks: BackgroundTask[];
  runningBackgroundTasks: BackgroundTask[];
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getTaskDependencyIds(task: TeamTask): string[] {
  return task.depends_on ?? task.blocked_by ?? [];
}

function getTeamNamesForRuntimeInsight(directory: string, sessionId?: string): string[] {
  const teamRoot = join(getOmcRoot(directory), 'state', 'team');
  if (!existsSync(teamRoot)) {
    return [];
  }

  const teamNames = readdirSync(teamRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (!sessionId) {
    return teamNames;
  }

  const scopedTeamNames = new Set<string>();
  const teamState = readJsonSafe<Record<string, unknown>>(
    resolveSessionStatePath('team', sessionId, directory),
  );
  const activeTeamName = teamState?.team_name ?? teamState?.teamName;
  if (typeof activeTeamName === 'string' && activeTeamName.trim().length > 0) {
    scopedTeamNames.add(activeTeamName.trim());
  }

  for (const teamName of teamNames) {
    const manifest = readJsonSafe<{ leader?: { session_id?: unknown } }>(
      join(teamRoot, teamName, 'manifest.json'),
    );
    if (manifest?.leader?.session_id === sessionId) {
      scopedTeamNames.add(teamName);
    }
  }

  return teamNames.filter((teamName) => scopedTeamNames.has(teamName));
}

function collectRuntimeInsight(directory: string, sessionId?: string): RuntimeInsightSnapshot {
  const missingDependencyIssues: MissingDependencyIssue[] = [];
  const workerIssues: WorkerIssue[] = [];

  const teamRoot = join(getOmcRoot(directory), 'state', 'team');
  for (const teamName of getTeamNamesForRuntimeInsight(directory, sessionId)) {
    const teamDir = join(teamRoot, teamName);
    const tasksDir = join(teamDir, 'tasks');
    const workersDir = join(teamDir, 'workers');

    const tasks: TeamTask[] = existsSync(tasksDir)
      ? readdirSync(tasksDir)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => readJsonSafe<TeamTask>(join(tasksDir, entry)))
          .filter((task): task is TeamTask => Boolean(task))
      : [];

    const taskById = new Map(tasks.map((task) => [task.id, task] as const));
    for (const task of tasks) {
      const missingDependencyIds = getTaskDependencyIds(task)
        .filter((dependencyId) => !taskById.has(dependencyId));
      if (missingDependencyIds.length > 0) {
        missingDependencyIssues.push({
          teamName,
          taskId: task.id,
          missingDependencyIds,
        });
      }
    }

    if (existsSync(workersDir)) {
      for (const workerName of readdirSync(workersDir)) {
        const status = readJsonSafe<WorkerStatus>(join(workersDir, workerName, 'status.json'));
        if (!status || typeof status.reason !== 'string' || status.reason.trim().length === 0) {
          continue;
        }
        if (status.state !== 'blocked' && status.state !== 'failed') {
          continue;
        }
        workerIssues.push({
          teamName,
          workerName,
          state: status.state,
          reason: status.reason.trim(),
        });
      }
    }
  }

  const hudState = readHudState(directory, sessionId);
  const backgroundTasks = hudState?.backgroundTasks ?? [];
  const failedBackgroundTasks = backgroundTasks
    .filter((task) => task.status === 'failed')
    .sort((left, right) => {
      const leftAt = new Date(left.completedAt ?? left.startedAt).getTime();
      const rightAt = new Date(right.completedAt ?? right.startedAt).getTime();
      return rightAt - leftAt;
    });
  const runningBackgroundTasks = backgroundTasks.filter((task) => task.status === 'running');

  return {
    missingDependencyIssues,
    workerIssues,
    failedBackgroundTasks,
    runningBackgroundTasks,
  };
}

export function formatAutopilotRuntimeInsight(
  directory: string,
  sessionId?: string,
): string {
  const snapshot = collectRuntimeInsight(directory, sessionId);
  const lines: string[] = [];

  if (snapshot.missingDependencyIssues.length > 0) {
    lines.push('Current blockers:');
    for (const issue of snapshot.missingDependencyIssues.slice(0, 3)) {
      lines.push(
        `- [${issue.teamName}] task-${issue.taskId} depends on missing task ids [${issue.missingDependencyIds.join(', ')}]`,
      );
    }
  }

  if (snapshot.workerIssues.length > 0) {
    if (lines.length === 0) {
      lines.push('Current blockers:');
    }
    for (const issue of snapshot.workerIssues.slice(0, 3)) {
      lines.push(
        `- [${issue.teamName}] ${issue.workerName} is ${issue.state}: ${issue.reason}`,
      );
    }
  }

  if (snapshot.failedBackgroundTasks.length > 0) {
    lines.push(lines.length === 0 ? 'Recent errors:' : 'Recent errors:');
    for (const task of snapshot.failedBackgroundTasks.slice(0, 3)) {
      const agentLabel = task.agentType ? ` (${task.agentType})` : '';
      lines.push(`- background task failed${agentLabel}: ${task.description}`);
    }
  }

  if (snapshot.runningBackgroundTasks.length > 0) {
    lines.push('Live progress:');
    for (const task of snapshot.runningBackgroundTasks.slice(0, 3)) {
      const agentLabel = task.agentType ? ` (${task.agentType})` : '';
      lines.push(`- running${agentLabel}: ${task.description}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}
