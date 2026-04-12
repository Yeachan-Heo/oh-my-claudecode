/**
 * Team leader nudge hook: detect stale leader and nudge via tmux.
 *
 * Mirrors OMX idle-nudge.ts behavior adapted for the leader pane.
 * Called on worker hook ticks when the leader pane appears stale
 * (no heartbeat update for a threshold period).
 *
 * This hook checks all workers' status and if all are idle while
 * tasks remain incomplete, nudges the leader pane to take action.
 */
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { appendTeamEvent } from '../team/events.js';
import { deriveTeamLeaderGuidance } from '../team/leader-nudge-guidance.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
// ── Helpers ────────────────────────────────────────────────────────────────
function safeString(value, fallback = '') {
    if (typeof value === 'string')
        return value;
    if (value === null || value === undefined)
        return fallback;
    return String(value);
}
function asNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
async function readJsonSafe(path, fallback) {
    try {
        if (!existsSync(path))
            return fallback;
        const raw = await readFile(path, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
async function writeJsonAtomic(path, value) {
    const dir = join(path, '..');
    await mkdir(dir, { recursive: true }).catch(() => { });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(value, null, 2));
    await rename(tmpPath, path);
}
async function defaultTmuxSendKeys(target, text, literal = false) {
    const { tmuxExecAsync } = await import('../cli/tmux-utils.js');
    const args = literal
        ? ['send-keys', '-t', target, '-l', text]
        : ['send-keys', '-t', target, text];
    await tmuxExecAsync(args, { timeout: 3000 });
}
const defaultTmux = {
    async sendKeys(target, text, literal = false) {
        await defaultTmuxSendKeys(target, text, literal);
    },
};
// ── Config ─────────────────────────────────────────────────────────────────
const DEFAULT_LEADER_STALE_MS = 120_000; // 2 minutes
const DEFAULT_NUDGE_COOLDOWN_MS = 60_000; // 1 minute between nudges
const DEFAULT_MAX_NUDGE_COUNT = 5;
const INJECT_MARKER = '[OMC_TMUX_INJECT]';
function resolveLeaderStaleMs() {
    const raw = safeString(process.env.OMC_TEAM_LEADER_STALE_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 10_000 && parsed <= 600_000)
        return parsed;
    return DEFAULT_LEADER_STALE_MS;
}
function resolveNudgeCooldownMs() {
    const raw = safeString(process.env.OMC_TEAM_LEADER_NUDGE_COOLDOWN_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 5_000 && parsed <= 600_000)
        return parsed;
    return DEFAULT_NUDGE_COOLDOWN_MS;
}
function resolveMaxNudgeCount() {
    const raw = safeString(process.env.OMC_TEAM_LEADER_MAX_NUDGE_COUNT || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 1 && parsed <= 100)
        return parsed;
    return DEFAULT_MAX_NUDGE_COUNT;
}
export async function checkLeaderStaleness(params) {
    const { stateDir, teamName, nowMs = Date.now() } = params;
    const teamDir = join(stateDir, 'team', teamName);
    const notStale = {
        stale: false,
        reason: 'ok',
        pendingTaskCount: 0,
        blockedTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
        failedTaskCount: 0,
        idleWorkerCount: 0,
        aliveWorkerCount: 0,
        nonReportingWorkerCount: 0,
        totalWorkerCount: 0,
    };
    // Read config to get worker list
    const configPath = join(teamDir, 'config.json');
    const manifestPath = join(teamDir, 'manifest.v2.json');
    const srcPath = existsSync(manifestPath) ? manifestPath : existsSync(configPath) ? configPath : null;
    if (!srcPath)
        return { ...notStale, reason: 'no_config' };
    const config = await readJsonSafe(srcPath, { workers: [] });
    const workers = config.workers ?? [];
    if (workers.length === 0)
        return { ...notStale, reason: 'no_workers' };
    const staleThresholdMs = resolveLeaderStaleMs();
    let idleWorkerCount = 0;
    let aliveWorkerCount = 0;
    let nonReportingWorkerCount = 0;
    for (const worker of workers) {
        const statusPath = join(teamDir, 'workers', worker.name, 'status.json');
        const status = await readJsonSafe(statusPath, {});
        const heartbeatPath = join(teamDir, 'workers', worker.name, 'heartbeat.json');
        const heartbeat = await readJsonSafe(heartbeatPath, {});
        if (heartbeat.alive !== false) {
            aliveWorkerCount++;
            const lastTurnMs = heartbeat.last_turn_at ? Date.parse(heartbeat.last_turn_at) : 0;
            const isFresh = Number.isFinite(lastTurnMs) && (nowMs - lastTurnMs) < staleThresholdMs;
            if (!isFresh) {
                nonReportingWorkerCount++;
            }
        }
        if (status.state === 'idle' || status.state === 'done') {
            idleWorkerCount++;
        }
    }
    // Count pending/in_progress tasks
    const tasksDir = join(teamDir, 'tasks');
    let pendingTaskCount = 0;
    let blockedTaskCount = 0;
    let inProgressTaskCount = 0;
    let completedTaskCount = 0;
    let failedTaskCount = 0;
    try {
        if (existsSync(tasksDir)) {
            const { readdir } = await import('fs/promises');
            const entries = await readdir(tasksDir);
            for (const entry of entries) {
                if (!entry.endsWith('.json') || entry.startsWith('.'))
                    continue;
                const task = await readJsonSafe(join(tasksDir, entry), {});
                if (task.status === 'pending') {
                    pendingTaskCount++;
                }
                else if (task.status === 'blocked') {
                    blockedTaskCount++;
                }
                else if (task.status === 'in_progress') {
                    inProgressTaskCount++;
                }
                else if (task.status === 'completed') {
                    completedTaskCount++;
                }
                else if (task.status === 'failed') {
                    failedTaskCount++;
                }
            }
        }
    }
    catch { /* ignore */ }
    const totalWorkerCount = workers.length;
    const activeTaskCount = pendingTaskCount + blockedTaskCount + inProgressTaskCount;
    // Leader should step in if the team has reached a terminal task state and all workers are idle.
    if (idleWorkerCount === totalWorkerCount && activeTaskCount === 0 && (completedTaskCount + failedTaskCount) > 0) {
        return {
            stale: true,
            reason: `all_workers_idle_with_terminal_tasks:idle=${idleWorkerCount},completed=${completedTaskCount},failed=${failedTaskCount}`,
            pendingTaskCount,
            blockedTaskCount,
            inProgressTaskCount,
            completedTaskCount,
            failedTaskCount,
            idleWorkerCount,
            aliveWorkerCount,
            nonReportingWorkerCount,
            totalWorkerCount,
        };
    }
    // Leader is stale if: all workers are idle AND active tasks remain
    if (idleWorkerCount === totalWorkerCount && activeTaskCount > 0) {
        return {
            stale: true,
            reason: `all_workers_idle_with_active_tasks:idle=${idleWorkerCount},active=${activeTaskCount}`,
            pendingTaskCount,
            blockedTaskCount,
            inProgressTaskCount,
            completedTaskCount,
            failedTaskCount,
            idleWorkerCount,
            aliveWorkerCount,
            nonReportingWorkerCount,
            totalWorkerCount,
        };
    }
    // Leader is stale if: alive workers exist, but none are reporting progress while active tasks remain.
    if (aliveWorkerCount > 0 && nonReportingWorkerCount >= aliveWorkerCount && activeTaskCount > 0) {
        return {
            stale: true,
            reason: `no_fresh_workers_with_active_tasks:alive=${aliveWorkerCount},active=${activeTaskCount}`,
            pendingTaskCount,
            blockedTaskCount,
            inProgressTaskCount,
            completedTaskCount,
            failedTaskCount,
            idleWorkerCount,
            aliveWorkerCount,
            nonReportingWorkerCount,
            totalWorkerCount,
        };
    }
    return {
        stale: false,
        reason: 'ok',
        pendingTaskCount,
        blockedTaskCount,
        inProgressTaskCount,
        completedTaskCount,
        failedTaskCount,
        idleWorkerCount,
        aliveWorkerCount,
        nonReportingWorkerCount,
        totalWorkerCount,
    };
}
export async function maybeNudgeLeader(params) {
    const { stateDir, teamName, tmux = defaultTmux } = params;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const teamDir = join(stateDir, 'team', teamName);
    // Check staleness
    const staleness = await checkLeaderStaleness({ stateDir, teamName, nowMs });
    if (!staleness.stale) {
        return { nudged: false, reason: staleness.reason };
    }
    const guidance = deriveTeamLeaderGuidance({
        tasks: {
            pending: staleness.pendingTaskCount,
            blocked: staleness.blockedTaskCount,
            inProgress: staleness.inProgressTaskCount,
            completed: staleness.completedTaskCount,
            failed: staleness.failedTaskCount,
        },
        workers: {
            total: staleness.totalWorkerCount,
            alive: staleness.aliveWorkerCount,
            idle: staleness.idleWorkerCount,
            nonReporting: staleness.nonReportingWorkerCount,
        },
    });
    // Check cooldown
    const nudgeStatePath = join(teamDir, 'leader-nudge-state.json');
    const nudgeState = await readJsonSafe(nudgeStatePath, {
        nudge_count: 0,
        last_nudge_at_ms: 0,
        last_nudge_at: '',
    });
    const cooldownMs = resolveNudgeCooldownMs();
    const maxNudgeCount = resolveMaxNudgeCount();
    if (nudgeState.nudge_count >= maxNudgeCount) {
        return { nudged: false, reason: `max_nudge_count_reached:${maxNudgeCount}` };
    }
    if (nudgeState.last_nudge_at_ms > 0 && (nowMs - nudgeState.last_nudge_at_ms) < cooldownMs) {
        return { nudged: false, reason: 'cooldown' };
    }
    // Find leader pane
    const configPath = join(teamDir, 'config.json');
    const manifestPath = join(teamDir, 'manifest.v2.json');
    const srcPath = existsSync(manifestPath) ? manifestPath : existsSync(configPath) ? configPath : null;
    if (!srcPath)
        return { nudged: false, reason: 'no_config' };
    const cfgForPane = await readJsonSafe(srcPath, {});
    const leaderPaneId = safeString(cfgForPane.leader_pane_id).trim();
    if (!leaderPaneId)
        return { nudged: false, reason: 'no_leader_pane_id' };
    // Send nudge
    const message = `[OMC] Leader nudge (${guidance.nextAction}): ${guidance.message} ${INJECT_MARKER}`;
    const logNudgePersistenceFailure = createSwallowedErrorLogger('hooks.team-leader-nudge maybeNudgeLeader persistence failed');
    try {
        await tmux.sendKeys(leaderPaneId, message, true);
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        // Update nudge state
        await writeJsonAtomic(nudgeStatePath, {
            nudge_count: nudgeState.nudge_count + 1,
            last_nudge_at_ms: nowMs,
            last_nudge_at: nowIso,
        }).catch(logNudgePersistenceFailure);
        await appendTeamEvent(teamName, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: guidance.reason,
            next_action: guidance.nextAction,
            message: guidance.message,
        }, params.cwd).catch(logNudgePersistenceFailure);
        return { nudged: true, reason: guidance.reason };
    }
    catch {
        return { nudged: false, reason: 'tmux_send_failed' };
    }
}
//# sourceMappingURL=team-leader-nudge-hook.js.map