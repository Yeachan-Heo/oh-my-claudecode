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
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const args = literal
        ? ['send-keys', '-t', target, '-l', text]
        : ['send-keys', '-t', target, text];
    await execFileAsync('tmux', args, { timeout: 3000 });
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
    const notStale = { stale: false, reason: 'ok', pendingTaskCount: 0, idleWorkerCount: 0, totalWorkerCount: 0 };
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
    let freshWorkerCount = 0;
    for (const worker of workers) {
        const statusPath = join(teamDir, 'workers', worker.name, 'status.json');
        const status = await readJsonSafe(statusPath, {});
        const heartbeatPath = join(teamDir, 'workers', worker.name, 'heartbeat.json');
        const heartbeat = await readJsonSafe(heartbeatPath, {});
        if (heartbeat.alive !== false) {
            const lastTurnMs = heartbeat.last_turn_at ? Date.parse(heartbeat.last_turn_at) : 0;
            if (Number.isFinite(lastTurnMs) && (nowMs - lastTurnMs) < staleThresholdMs) {
                freshWorkerCount++;
            }
        }
        if (status.state === 'idle' || status.state === 'done') {
            idleWorkerCount++;
        }
    }
    // Count pending/in_progress tasks
    const tasksDir = join(teamDir, 'tasks');
    let pendingTaskCount = 0;
    try {
        if (existsSync(tasksDir)) {
            const { readdir } = await import('fs/promises');
            const entries = await readdir(tasksDir);
            for (const entry of entries) {
                if (!entry.endsWith('.json') || entry.startsWith('.'))
                    continue;
                const task = await readJsonSafe(join(tasksDir, entry), {});
                if (task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked') {
                    pendingTaskCount++;
                }
            }
        }
    }
    catch { /* ignore */ }
    const totalWorkerCount = workers.length;
    // Leader is stale if: all workers are idle AND there are pending tasks
    if (idleWorkerCount === totalWorkerCount && pendingTaskCount > 0) {
        return {
            stale: true,
            reason: `all_workers_idle_with_pending_tasks:idle=${idleWorkerCount},pending=${pendingTaskCount}`,
            pendingTaskCount,
            idleWorkerCount,
            totalWorkerCount,
        };
    }
    // Leader is stale if: no fresh workers AND there are pending tasks
    if (freshWorkerCount === 0 && pendingTaskCount > 0) {
        return {
            stale: true,
            reason: `no_fresh_workers_with_pending_tasks:pending=${pendingTaskCount}`,
            pendingTaskCount,
            idleWorkerCount,
            totalWorkerCount,
        };
    }
    return { stale: false, reason: 'ok', pendingTaskCount, idleWorkerCount, totalWorkerCount };
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
    const message = `[OMC] Leader nudge: ${staleness.idleWorkerCount}/${staleness.totalWorkerCount} workers idle, ${staleness.pendingTaskCount} tasks pending. Please check task assignments. ${INJECT_MARKER}`;
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
        }).catch(() => { });
        return { nudged: true, reason: staleness.reason };
    }
    catch {
        return { nudged: false, reason: 'tmux_send_failed' };
    }
}
//# sourceMappingURL=team-leader-nudge-hook.js.map