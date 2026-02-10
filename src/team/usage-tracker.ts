// src/team/usage-tracker.ts

/**
 * Usage tracker for team sessions.
 *
 * Tracks wall-clock time and prompt/response character counts per task.
 * NOTE: Token counts are not available from Codex/Gemini CLI output.
 * Character counts serve as a rough proxy for usage estimation.
 *
 * Storage: append-only JSONL at .omc/logs/team-usage-{team}.jsonl
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';

export interface TaskUsageRecord {
  taskId: string;
  workerName: string;
  provider: 'codex' | 'gemini';
  model: string;
  startedAt: string;
  completedAt: string;
  wallClockMs: number;
  promptChars: number;
  responseChars: number;
}

export interface WorkerUsageSummary {
  workerName: string;
  provider: 'codex' | 'gemini';
  model: string;
  taskCount: number;
  totalWallClockMs: number;
  totalPromptChars: number;
  totalResponseChars: number;
}

export interface TeamUsageReport {
  teamName: string;
  totalWallClockMs: number;
  taskCount: number;
  workers: WorkerUsageSummary[];
}

function getUsageLogPath(workingDirectory: string, teamName: string): string {
  return join(workingDirectory, '.omc', 'logs', `team-usage-${teamName}.jsonl`);
}

/**
 * Record usage for a completed task.
 */
export function recordTaskUsage(
  workingDirectory: string,
  teamName: string,
  record: TaskUsageRecord
): void {
  const logPath = getUsageLogPath(workingDirectory, teamName);
  const dir = join(workingDirectory, '.omc', 'logs');
  validateResolvedPath(logPath, workingDirectory);
  ensureDirWithMode(dir);
  appendFileWithMode(logPath, JSON.stringify(record) + '\n');
}

/**
 * Compute character counts from prompt and output files.
 * Returns { promptChars, responseChars }. Returns 0 for missing files.
 */
export function measureCharCounts(
  promptFilePath: string,
  outputFilePath: string
): { promptChars: number; responseChars: number } {
  let promptChars = 0;
  let responseChars = 0;

  try {
    if (existsSync(promptFilePath)) {
      promptChars = statSync(promptFilePath).size;
    }
  } catch { /* missing file */ }

  try {
    if (existsSync(outputFilePath)) {
      responseChars = statSync(outputFilePath).size;
    }
  } catch { /* missing file */ }

  return { promptChars, responseChars };
}

/**
 * Read all usage records from the JSONL log.
 */
function readUsageRecords(workingDirectory: string, teamName: string): TaskUsageRecord[] {
  const logPath = getUsageLogPath(workingDirectory, teamName);
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const records: TaskUsageRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }

  return records;
}

/**
 * Generate usage report for a team session.
 * Aggregates TaskUsageRecords from the JSONL log.
 */
export function generateUsageReport(
  workingDirectory: string,
  teamName: string
): TeamUsageReport {
  const records = readUsageRecords(workingDirectory, teamName);

  // Aggregate per worker
  const workerMap = new Map<string, WorkerUsageSummary>();

  for (const r of records) {
    const existing = workerMap.get(r.workerName);
    if (existing) {
      existing.taskCount++;
      existing.totalWallClockMs += r.wallClockMs;
      existing.totalPromptChars += r.promptChars;
      existing.totalResponseChars += r.responseChars;
    } else {
      workerMap.set(r.workerName, {
        workerName: r.workerName,
        provider: r.provider,
        model: r.model,
        taskCount: 1,
        totalWallClockMs: r.wallClockMs,
        totalPromptChars: r.promptChars,
        totalResponseChars: r.responseChars,
      });
    }
  }

  const workers = Array.from(workerMap.values());

  return {
    teamName,
    totalWallClockMs: workers.reduce((sum, w) => sum + w.totalWallClockMs, 0),
    taskCount: workers.reduce((sum, w) => sum + w.taskCount, 0),
    workers,
  };
}
