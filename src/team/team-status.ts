// src/team/team-status.ts

/**
 * Team Status Aggregator for MCP Team Bridge
 *
 * Provides a unified view of team state by combining worker registration,
 * heartbeat data, task progress, and outbox messages.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { listMcpWorkers } from './team-registration.js';
import { readHeartbeat, isWorkerAlive } from './heartbeat.js';
import { listTaskIds, readTask } from './task-file-ops.js';
import { sanitizeName } from './tmux-session.js';
import type { HeartbeatData, TaskFile, OutboxMessage, McpWorkerMember } from './types.js';

/**
 * Read the last N messages from a worker's outbox file without advancing any cursor.
 * This is a side-effect-free alternative to readNewOutboxMessages for status queries.
 */
function peekRecentOutboxMessages(
  teamName: string,
  workerName: string,
  maxMessages: number = 10
): OutboxMessage[] {
  const safeName = sanitizeName(teamName);
  const safeWorker = sanitizeName(workerName);
  const outboxPath = join(homedir(), '.claude', 'teams', safeName, 'outbox', `${safeWorker}.jsonl`);

  if (!existsSync(outboxPath)) return [];

  try {
    const content = readFileSync(outboxPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const recentLines = lines.slice(-maxMessages);
    const messages: OutboxMessage[] = [];
    for (const line of recentLines) {
      try {
        messages.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return messages;
  } catch {
    return [];
  }
}

export interface WorkerStatus {
  workerName: string;
  provider: 'codex' | 'gemini';
  heartbeat: HeartbeatData | null;
  isAlive: boolean;
  currentTask: TaskFile | null;
  recentMessages: OutboxMessage[];
  taskStats: {
    completed: number;
    failed: number;
    pending: number;
    inProgress: number;
  };
}

export interface TeamStatus {
  teamName: string;
  workers: WorkerStatus[];
  taskSummary: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    inProgress: number;
  };
  lastUpdated: string;
}

export function getTeamStatus(
  teamName: string,
  workingDirectory: string,
  heartbeatMaxAgeMs: number = 30000
): TeamStatus {
  // Get all workers
  const mcpWorkers = listMcpWorkers(teamName, workingDirectory);

  // Get all tasks for the team
  const taskIds = listTaskIds(teamName);
  const tasks: TaskFile[] = [];
  for (const id of taskIds) {
    const task = readTask(teamName, id);
    if (task) tasks.push(task);
  }

  // Build per-worker status
  const workers: WorkerStatus[] = mcpWorkers.map(w => {
    const heartbeat = readHeartbeat(workingDirectory, teamName, w.name);
    const alive = isWorkerAlive(workingDirectory, teamName, w.name, heartbeatMaxAgeMs);
    const recentMessages = peekRecentOutboxMessages(teamName, w.name);

    // Compute per-worker task stats
    const workerTasks = tasks.filter(t => t.owner === w.name);
    const failed = workerTasks.filter(t => t.status === 'completed' && t.metadata?.permanentlyFailed === true).length;
    const taskStats = {
      completed: workerTasks.filter(t => t.status === 'completed').length - failed,
      failed,
      pending: workerTasks.filter(t => t.status === 'pending').length,
      inProgress: workerTasks.filter(t => t.status === 'in_progress').length,
    };

    const currentTask = workerTasks.find(t => t.status === 'in_progress') || null;
    const provider = w.agentType.replace('mcp-', '') as 'codex' | 'gemini';

    return {
      workerName: w.name,
      provider,
      heartbeat,
      isAlive: alive,
      currentTask,
      recentMessages,
      taskStats,
    };
  });

  // Build team summary
  const totalFailed = tasks.filter(t => t.status === 'completed' && t.metadata?.permanentlyFailed === true).length;
  const taskSummary = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === 'completed').length - totalFailed,
    failed: totalFailed,
    pending: tasks.filter(t => t.status === 'pending').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
  };

  return {
    teamName,
    workers,
    taskSummary,
    lastUpdated: new Date().toISOString(),
  };
}
