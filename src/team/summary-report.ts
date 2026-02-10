// src/team/summary-report.ts

/**
 * Team summary report generator.
 *
 * Generates comprehensive markdown reports combining:
 * - Activity log
 * - Usage statistics
 * - Audit event history
 */

import { join } from 'node:path';
import { writeFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { getActivityLog, formatActivityTimeline } from './activity-log.js';
import { generateUsageReport } from './usage-tracker.js';
import { readAuditLog } from './audit-log.js';

/**
 * Generate a markdown summary report for a team session.
 */
export function generateTeamReport(
  workingDirectory: string,
  teamName: string
): string {
  // Gather data
  const activities = getActivityLog(workingDirectory, teamName);
  const usage = generateUsageReport(workingDirectory, teamName);
  const auditEvents = readAuditLog(workingDirectory, teamName);

  // Compute stats
  const taskCompleted = auditEvents.filter(e => e.eventType === 'task_completed').length;
  const taskFailed = auditEvents.filter(e => e.eventType === 'task_permanently_failed').length;
  const taskTotal = taskCompleted + taskFailed;
  const workerCount = new Set(auditEvents.map(e => e.workerName)).size;

  // Duration
  const startEvents = auditEvents.filter(e => e.eventType === 'bridge_start');
  const endEvents = auditEvents.filter(e => e.eventType === 'bridge_shutdown');
  let durationStr = 'unknown';
  if (startEvents.length > 0) {
    const startTime = new Date(startEvents[0].timestamp).getTime();
    const endTime = endEvents.length > 0
      ? new Date(endEvents[endEvents.length - 1].timestamp).getTime()
      : Date.now();
    const durationMin = Math.round((endTime - startTime) / 60000);
    durationStr = `${durationMin} minutes`;
  }

  // Build report
  const lines: string[] = [];

  lines.push(`# Team Report: ${teamName}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Duration: ${durationStr}`);
  lines.push(`- Workers: ${workerCount}`);
  lines.push(`- Tasks: ${taskCompleted} completed, ${taskFailed} failed, ${taskTotal} total`);
  lines.push('');

  // Task results table
  const taskEvents = auditEvents.filter(e =>
    e.eventType === 'task_completed' || e.eventType === 'task_permanently_failed'
  );
  if (taskEvents.length > 0) {
    lines.push('## Task Results');
    lines.push('| Task | Worker | Status |');
    lines.push('|------|--------|--------|');
    for (const event of taskEvents) {
      const status = event.eventType === 'task_completed' ? 'Completed' : 'Failed';
      lines.push(`| ${event.taskId || 'N/A'} | ${event.workerName} | ${status} |`);
    }
    lines.push('');
  }

  // Worker performance table
  if (usage.workers.length > 0) {
    lines.push('## Worker Performance');
    lines.push('| Worker | Tasks | Wall-Clock Time | Prompt Chars | Response Chars |');
    lines.push('|--------|-------|-----------------|--------------|----------------|');
    for (const w of usage.workers) {
      const timeStr = `${Math.round(w.totalWallClockMs / 1000)}s`;
      lines.push(`| ${w.workerName} | ${w.taskCount} | ${timeStr} | ${w.totalPromptChars.toLocaleString()} | ${w.totalResponseChars.toLocaleString()} |`);
    }
    lines.push('');
  }

  // Activity timeline
  lines.push('## Activity Timeline');
  const timeline = formatActivityTimeline(activities.slice(-50)); // Last 50 entries
  lines.push(timeline);
  lines.push('');

  // Usage totals
  lines.push('## Usage Totals');
  lines.push(`- Total wall-clock time: ${Math.round(usage.totalWallClockMs / 1000)}s`);
  lines.push(`- Total tasks: ${usage.taskCount}`);
  lines.push('');

  lines.push('---');
  lines.push(`*Generated at ${new Date().toISOString()}*`);

  return lines.join('\n');
}

/**
 * Write the report to disk.
 * Path: .omc/reports/team-{teamName}-{timestamp}.md
 * Returns the file path.
 */
export function saveTeamReport(
  workingDirectory: string,
  teamName: string
): string {
  const report = generateTeamReport(workingDirectory, teamName);
  const dir = join(workingDirectory, '.omc', 'reports');
  ensureDirWithMode(dir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(dir, `team-${teamName}-${timestamp}.md`);
  validateResolvedPath(filePath, workingDirectory);
  writeFileWithMode(filePath, report);
  return filePath;
}
