// src/team/worker-health.ts

/**
 * Worker health dashboard utility.
 * Aggregates heartbeat, tmux session, task history, and audit log data
 * to provide a comprehensive health report for each worker.
 */

import type { HeartbeatData } from './types.js';
import { listMcpWorkers } from './team-registration.js';
import { readHeartbeat, isWorkerAlive } from './heartbeat.js';
import { isSessionAlive } from './tmux-session.js';
import { readAuditLog } from './audit-log.js';

export interface WorkerHealthReport {
  workerName: string;
  isAlive: boolean;
  tmuxSessionAlive: boolean;
  heartbeatAge: number | null; // milliseconds since last heartbeat
  status: HeartbeatData['status'] | 'dead' | 'unknown';
  consecutiveErrors: number;
  currentTaskId: string | null;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  uptimeMs: number | null;
}

/**
 * Generate health report for all workers in a team.
 * Combines: heartbeat freshness, tmux session check, task history, audit log.
 */
export function getWorkerHealthReports(
  teamName: string,
  workingDirectory: string,
  heartbeatMaxAgeMs: number = 30000
): WorkerHealthReport[] {
  const workers = listMcpWorkers(teamName, workingDirectory);
  const reports: WorkerHealthReport[] = [];

  for (const worker of workers) {
    const heartbeat = readHeartbeat(workingDirectory, teamName, worker.name);
    const alive = isWorkerAlive(workingDirectory, teamName, worker.name, heartbeatMaxAgeMs);

    let tmuxAlive = false;
    try {
      tmuxAlive = isSessionAlive(teamName, worker.name);
    } catch { /* tmux not available */ }

    // Calculate heartbeat age
    let heartbeatAge: number | null = null;
    if (heartbeat?.lastPollAt) {
      heartbeatAge = Date.now() - new Date(heartbeat.lastPollAt).getTime();
    }

    // Determine status
    let status: WorkerHealthReport['status'] = 'unknown';
    if (heartbeat) {
      status = heartbeat.status;
    }
    if (!alive && !tmuxAlive) {
      status = 'dead';
    }

    // Count tasks from audit log
    let totalTasksCompleted = 0;
    let totalTasksFailed = 0;
    try {
      const auditEvents = readAuditLog(workingDirectory, teamName, { workerName: worker.name });
      for (const event of auditEvents) {
        if (event.eventType === 'task_completed') totalTasksCompleted++;
        if (event.eventType === 'task_permanently_failed') totalTasksFailed++;
      }
    } catch { /* audit log may not exist */ }

    // Calculate uptime from audit log bridge_start
    let uptimeMs: number | null = null;
    try {
      const startEvents = readAuditLog(workingDirectory, teamName, {
        workerName: worker.name,
        eventType: 'bridge_start',
      });
      if (startEvents.length > 0) {
        const lastStart = startEvents[startEvents.length - 1];
        uptimeMs = Date.now() - new Date(lastStart.timestamp).getTime();
      }
    } catch { /* ignore */ }

    reports.push({
      workerName: worker.name,
      isAlive: alive,
      tmuxSessionAlive: tmuxAlive,
      heartbeatAge,
      status,
      consecutiveErrors: heartbeat?.consecutiveErrors ?? 0,
      currentTaskId: heartbeat?.currentTaskId ?? null,
      totalTasksCompleted,
      totalTasksFailed,
      uptimeMs,
    });
  }

  return reports;
}

/**
 * Check if a specific worker needs intervention.
 * Returns reason string if intervention needed, null otherwise.
 */
export function checkWorkerHealth(
  teamName: string,
  workerName: string,
  workingDirectory: string,
  heartbeatMaxAgeMs: number = 30000
): string | null {
  const heartbeat = readHeartbeat(workingDirectory, teamName, workerName);
  const alive = isWorkerAlive(workingDirectory, teamName, workerName, heartbeatMaxAgeMs);

  let tmuxAlive = false;
  try {
    tmuxAlive = isSessionAlive(teamName, workerName);
  } catch { /* tmux not available */ }

  if (!alive && !tmuxAlive) {
    const age = heartbeat?.lastPollAt
      ? Math.round((Date.now() - new Date(heartbeat.lastPollAt).getTime()) / 1000)
      : 'unknown';
    return `Worker is dead: heartbeat stale for ${age}s, tmux session not found`;
  }

  if (!alive && tmuxAlive) {
    return `Heartbeat stale but tmux session exists — worker may be hung`;
  }

  if (heartbeat?.status === 'quarantined') {
    return `Worker self-quarantined after ${heartbeat.consecutiveErrors} consecutive errors`;
  }

  if (heartbeat && heartbeat.consecutiveErrors >= 2) {
    return `Worker has ${heartbeat.consecutiveErrors} consecutive errors — at risk of quarantine`;
  }

  return null;
}
