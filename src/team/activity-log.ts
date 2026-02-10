// src/team/activity-log.ts

/**
 * Human-readable activity log built on top of audit events.
 *
 * Transforms structured audit events into categorized activity entries
 * with human-readable descriptions suitable for reports and timelines.
 */

import { readAuditLog } from './audit-log.js';
import type { AuditEvent, AuditEventType } from './audit-log.js';

export interface ActivityEntry {
  timestamp: string;
  actor: string;
  action: string;
  target?: string;
  details?: string;
  category: 'task' | 'file' | 'message' | 'lifecycle' | 'error';
}

/** Map audit event types to activity categories */
const CATEGORY_MAP: Record<AuditEventType, ActivityEntry['category']> = {
  bridge_start: 'lifecycle',
  bridge_shutdown: 'lifecycle',
  task_claimed: 'task',
  task_started: 'task',
  task_completed: 'task',
  task_failed: 'error',
  task_permanently_failed: 'error',
  worker_quarantined: 'error',
  worker_idle: 'lifecycle',
  inbox_rotated: 'lifecycle',
  outbox_rotated: 'lifecycle',
  cli_spawned: 'task',
  cli_timeout: 'error',
  cli_error: 'error',
  shutdown_received: 'lifecycle',
  shutdown_ack: 'lifecycle',
  permission_violation: 'error',
  permission_audit: 'task',
};

/** Map audit event types to human-readable action descriptions */
function describeEvent(event: AuditEvent): string {
  switch (event.eventType) {
    case 'bridge_start': return 'Started bridge daemon';
    case 'bridge_shutdown': return 'Shut down bridge daemon';
    case 'task_claimed': return `Claimed task ${event.taskId || '(unknown)'}`;
    case 'task_started': return `Started working on task ${event.taskId || '(unknown)'}`;
    case 'task_completed': return `Completed task ${event.taskId || '(unknown)'}`;
    case 'task_failed': return `Task ${event.taskId || '(unknown)'} failed`;
    case 'task_permanently_failed': return `Task ${event.taskId || '(unknown)'} permanently failed`;
    case 'worker_quarantined': return 'Self-quarantined due to errors';
    case 'worker_idle': return 'Standing by (idle)';
    case 'inbox_rotated': return 'Rotated inbox log';
    case 'outbox_rotated': return 'Rotated outbox log';
    case 'cli_spawned': return `Spawned CLI process`;
    case 'cli_timeout': return `CLI process timed out`;
    case 'cli_error': return `CLI process error`;
    case 'shutdown_received': return 'Received shutdown signal';
    case 'shutdown_ack': return 'Acknowledged shutdown';
    case 'permission_violation': return `Permission violation on task ${event.taskId || '(unknown)'}`;
    case 'permission_audit': return `Permission audit warning on task ${event.taskId || '(unknown)'}`;
    default: return event.eventType;
  }
}

/**
 * Get structured activity log from audit events.
 * Enriches audit events with human-readable descriptions.
 */
export function getActivityLog(
  workingDirectory: string,
  teamName: string,
  options?: {
    since?: string;
    limit?: number;
    category?: ActivityEntry['category'];
    actor?: string;
  }
): ActivityEntry[] {
  // Read raw audit events
  const auditFilter: { since?: string; workerName?: string } = {};
  if (options?.since) auditFilter.since = options.since;
  if (options?.actor) auditFilter.workerName = options.actor;

  const events = readAuditLog(workingDirectory, teamName, auditFilter);

  // Transform to activity entries
  let activities: ActivityEntry[] = events.map(event => ({
    timestamp: event.timestamp,
    actor: event.workerName,
    action: describeEvent(event),
    target: event.taskId,
    details: event.details ? JSON.stringify(event.details) : undefined,
    category: CATEGORY_MAP[event.eventType] || 'lifecycle',
  }));

  // Apply category filter
  if (options?.category) {
    activities = activities.filter(a => a.category === options.category);
  }

  // Apply limit
  if (options?.limit && options.limit > 0) {
    activities = activities.slice(-options.limit);
  }

  return activities;
}

/**
 * Generate a human-readable activity timeline.
 */
export function formatActivityTimeline(activities: ActivityEntry[]): string {
  if (activities.length === 0) return '(no activity recorded)';

  const lines: string[] = [];
  for (const a of activities) {
    // Include full YYYY-MM-DD HH:MM timestamp for clarity across multi-day timelines
    const time = a.timestamp.slice(0, 16).replace('T', ' '); // YYYY-MM-DD HH:MM
    const target = a.target ? ` [${a.target}]` : '';
    lines.push(`[${time}] ${a.actor}: ${a.action}${target}`);
  }

  return lines.join('\n');
}
