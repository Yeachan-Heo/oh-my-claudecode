// src/lib/event-logger.ts

/**
 * Structured event logging for OMC runtime observability.
 *
 * Opt-in via OMC_ENABLE_EVENT_LOG=1 environment variable.
 * Reuses the same append-only JSONL pattern and security model
 * as team/audit-log.ts (0o600 permissions, validated paths).
 *
 * Events are written to .omc/logs/events-{YYYY-MM-DD}.jsonl
 */

import { join } from 'node:path';
import { existsSync, readFileSync, statSync, renameSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendFileWithMode, ensureDirWithMode, validateResolvedPath } from '../team/fs-utils.js';
import { resolveLogsPath } from './worktree-paths.js';

export type OMCEventType =
  | 'skill:route'
  | 'skill:execute'
  | 'skill:complete'
  | 'skill:error'
  | 'keyword:detect'
  | 'hook:enter'
  | 'hook:exit'
  | 'agent:delegate'
  | 'mode:enter'
  | 'mode:exit';

export interface OMCEvent {
  timestamp: string;
  type: OMCEventType;
  source: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

let _enabled: boolean | undefined;

function isEnabled(): boolean {
  if (_enabled === undefined) {
    _enabled = process.env.OMC_ENABLE_EVENT_LOG === '1';
  }
  return _enabled;
}

function getLogPath(worktreeRoot?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(resolveLogsPath(worktreeRoot), `events-${date}.jsonl`);
}

/**
 * Log a structured OMC event. No-op when OMC_ENABLE_EVENT_LOG !== '1'.
 */
export function logEvent(
  type: OMCEventType,
  source: string,
  payload?: Record<string, unknown>,
  worktreeRoot?: string,
): void {
  if (!isEnabled()) return;

  const logsDir = resolveLogsPath(worktreeRoot);
  const logPath = getLogPath(worktreeRoot);

  try {
    validateResolvedPath(logPath, logsDir);
    ensureDirWithMode(logsDir);

    const event: OMCEvent = {
      timestamp: new Date().toISOString(),
      type,
      source,
      payload: payload && Object.keys(payload).length > 0 ? payload : undefined,
    };

    appendFileWithMode(logPath, JSON.stringify(event) + '\n');
  } catch {
    // Silent fail — logging must never break the host process
  }
}

/**
 * Read events from a specific date's log file.
 */
export function readEvents(
  date: string,
  filter?: {
    type?: OMCEventType;
    source?: string;
    limit?: number;
  },
  worktreeRoot?: string,
): OMCEvent[] {
  const logPath = join(resolveLogsPath(worktreeRoot), `events-${date}.jsonl`);
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: OMCEvent[] = [];

  for (const line of lines) {
    let event: OMCEvent;
    try {
      event = JSON.parse(line);
    } catch { continue; }

    if (filter) {
      if (filter.type && event.type !== filter.type) continue;
      if (filter.source && event.source !== filter.source) continue;
    }

    events.push(event);
    if (filter?.limit !== undefined && events.length >= filter.limit) break;
  }

  return events;
}

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Rotate event log if it exceeds maxSizeBytes. Keeps the most recent half.
 */
export function rotateEventLog(
  date: string,
  maxSizeBytes: number = DEFAULT_MAX_SIZE,
  worktreeRoot?: string,
): void {
  const logPath = join(resolveLogsPath(worktreeRoot), `events-${date}.jsonl`);
  if (!existsSync(logPath)) return;

  const stat = statSync(logPath);
  if (stat.size <= maxSizeBytes) return;

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const keepFrom = Math.floor(lines.length / 2);
  const rotated = lines.slice(keepFrom).join('\n') + '\n';

  const logsDir = resolveLogsPath(worktreeRoot);
  const tmpPath = logPath + '.' + randomUUID() + '.tmp';
  validateResolvedPath(tmpPath, logsDir);

  if (existsSync(tmpPath)) {
    const tmpStat = lstatSync(tmpPath);
    if (tmpStat.isSymbolicLink()) unlinkSync(tmpPath);
  }

  writeFileSync(tmpPath, rotated, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, logPath);
}
