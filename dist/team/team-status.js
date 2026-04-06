// src/team/team-status.ts
/**
 * Team Status Aggregator for MCP Team Bridge
 *
 * Provides a unified view of team state by combining worker registration,
 * heartbeat data, task progress, and outbox messages.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { listMcpWorkers } from './team-registration.js';
import { readHeartbeat, isWorkerAlive } from './heartbeat.js';
import { listTaskIds, readTask } from './task-file-ops.js';
import { sanitizeName } from './tmux-session.js';
import { generateUsageReport } from './usage-tracker.js';
function emptyUsageReport(teamName) {
    return {
        teamName,
        totalWallClockMs: 0,
        taskCount: 0,
        workers: [],
    };
}
/**
 * Read the last N messages from a worker's outbox file without advancing any cursor.
 * This is a side-effect-free alternative to readNewOutboxMessages for status queries.
 */
function peekRecentOutboxMessages(teamName, workerName, maxMessages = 10) {
    const safeName = sanitizeName(teamName);
    const safeWorker = sanitizeName(workerName);
    const outboxPath = join(getClaudeConfigDir(), 'teams', safeName, 'outbox', `${safeWorker}.jsonl`);
    if (!existsSync(outboxPath))
        return [];
    try {
        const content = readFileSync(outboxPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const recentLines = lines.slice(-maxMessages);
        const messages = [];
        for (const line of recentLines) {
            try {
                messages.push(JSON.parse(line));
            }
            catch { /* skip malformed lines */ }
        }
        return messages;
    }
    catch {
        return [];
    }
}
export function getTeamStatus(teamName, workingDirectory, heartbeatMaxAgeMs = 30000, options) {
    const startedAt = Date.now();
    // Get all workers
    const mcpWorkers = listMcpWorkers(teamName, workingDirectory);
    // Get all tasks for the team
    const taskScanStartedAt = Date.now();
    const taskIds = listTaskIds(teamName, { cwd: workingDirectory });
    const tasks = [];
    for (const id of taskIds) {
        const task = readTask(teamName, id, { cwd: workingDirectory });
        if (task)
            tasks.push(task);
    }
    const taskScanMs = Date.now() - taskScanStartedAt;
    // Build per-worker status
    const workerScanStartedAt = Date.now();
    const workers = mcpWorkers.map(w => {
        const heartbeat = readHeartbeat(workingDirectory, teamName, w.name);
        const alive = isWorkerAlive(workingDirectory, teamName, w.name, heartbeatMaxAgeMs);
        const recentMessages = peekRecentOutboxMessages(teamName, w.name);
        // Compute per-worker task stats
        const workerTasks = tasks.filter(t => t.owner === w.name);
        const failed = workerTasks.filter(t => t.status === 'failed' || (t.status === 'completed' && t.metadata?.permanentlyFailed === true)).length;
        const completedClean = workerTasks.filter(t => t.status === 'completed' && !t.metadata?.permanentlyFailed).length;
        const taskStats = {
            completed: completedClean,
            failed,
            pending: workerTasks.filter(t => t.status === 'pending').length,
            inProgress: workerTasks.filter(t => t.status === 'in_progress').length,
        };
        const currentTask = workerTasks.find(t => t.status === 'in_progress') || null;
        const provider = w.agentType.replace(/^(?:mcp|tmux)-/, '');
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
    const workerScanMs = Date.now() - workerScanStartedAt;
    const includeUsage = options?.includeUsage ?? true;
    let usage = emptyUsageReport(teamName);
    let usageReadMs = 0;
    if (includeUsage) {
        const usageReadStartedAt = Date.now();
        usage = generateUsageReport(workingDirectory, teamName);
        usageReadMs = Date.now() - usageReadStartedAt;
    }
    // Build team summary
    const permanentlyFailed = tasks.filter(t => t.status === 'completed' && t.metadata?.permanentlyFailed === true).length;
    const statusFailed = tasks.filter(t => t.status === 'failed').length;
    const totalFailed = permanentlyFailed + statusFailed;
    const taskSummary = {
        total: tasks.length,
        completed: tasks.filter(t => t.status === 'completed').length - permanentlyFailed,
        failed: totalFailed,
        pending: tasks.filter(t => t.status === 'pending').length,
        inProgress: tasks.filter(t => t.status === 'in_progress').length,
    };
    return {
        teamName,
        workers,
        taskSummary,
        usage,
        performance: {
            taskScanMs,
            workerScanMs,
            usageReadMs,
            totalMs: Date.now() - startedAt,
        },
        lastUpdated: new Date().toISOString(),
    };
}
//# sourceMappingURL=team-status.js.map