// src/team/audit-log.ts

/**
 * Structured audit logging for MCP Team Bridge.
 *
 * All events are logged to append-only JSONL files with 0o600 permissions.
 * Automatic rotation when log exceeds size threshold.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, statSync, renameSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { appendFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';

export type AuditEventType =
  | 'bridge_start'
  | 'bridge_shutdown'
  | 'task_claimed'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_permanently_failed'
  | 'worker_quarantined'
  | 'worker_idle'
  | 'inbox_rotated'
  | 'outbox_rotated'
  | 'cli_spawned'
  | 'cli_timeout'
  | 'cli_error'
  | 'shutdown_received'
  | 'shutdown_ack'
  | 'permission_violation'
  | 'permission_audit';

export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  teamName: string;
  workerName: string;
  taskId?: string;
  details?: Record<string, unknown>;
}

const DEFAULT_MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function getLogPath(workingDirectory: string, teamName: string): string {
  return join(workingDirectory, '.omc', 'logs', `team-bridge-${teamName}.jsonl`);
}

/**
 * Append an audit event to the team's audit log.
 * Append-only JSONL format with 0o600 permissions.
 */
export function logAuditEvent(
  workingDirectory: string,
  event: AuditEvent
): void {
  const logPath = getLogPath(workingDirectory, event.teamName);
  const dir = join(workingDirectory, '.omc', 'logs');
  validateResolvedPath(logPath, workingDirectory);
  ensureDirWithMode(dir);
  const line = JSON.stringify(event) + '\n';
  appendFileWithMode(logPath, line);
}

/**
 * Read audit events with optional filtering.
 */
export function readAuditLog(
  workingDirectory: string,
  teamName: string,
  filter?: {
    eventType?: AuditEventType;
    workerName?: string;
    since?: string;
    limit?: number;
  }
): AuditEvent[] {
  const logPath = getLogPath(workingDirectory, teamName);
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const maxResults = filter?.limit;
  const events: AuditEvent[] = [];

  for (const line of lines) {
    let event: AuditEvent;
    try {
      event = JSON.parse(line);
    } catch { continue; /* skip malformed */ }

    // Apply filters inline for early-exit optimization
    if (filter) {
      if (filter.eventType && event.eventType !== filter.eventType) continue;
      if (filter.workerName && event.workerName !== filter.workerName) continue;
      if (filter.since && event.timestamp < filter.since) continue;
    }

    events.push(event);

    // Early exit when limit is reached
    if (maxResults !== undefined && events.length >= maxResults) break;
  }

  return events;
}

/**
 * Rotate audit log if it exceeds maxSizeBytes.
 * Keeps the most recent half of entries.
 */
export function rotateAuditLog(
  workingDirectory: string,
  teamName: string,
  maxSizeBytes: number = DEFAULT_MAX_LOG_SIZE
): void {
  const logPath = getLogPath(workingDirectory, teamName);
  if (!existsSync(logPath)) return;

  const stat = statSync(logPath);
  if (stat.size <= maxSizeBytes) return;

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Keep the most recent half
  const keepFrom = Math.floor(lines.length / 2);
  const rotated = lines.slice(keepFrom).join('\n') + '\n';

  // Atomic write: write to temp, then rename
  const tmpPath = logPath + '.tmp';
  const logsDir = join(workingDirectory, '.omc', 'logs');
  validateResolvedPath(tmpPath, logsDir);

  // Prevent symlink attacks: if tmp path exists as symlink, remove it
  if (existsSync(tmpPath)) {
    const tmpStat = lstatSync(tmpPath);
    if (tmpStat.isSymbolicLink()) {
      unlinkSync(tmpPath);
    }
  }

  writeFileSync(tmpPath, rotated, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, logPath);
}
