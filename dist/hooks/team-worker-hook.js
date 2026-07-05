/**
 * Team worker hook: heartbeat, idle detection, and leader notification.
 *
 * Mirrors OMX scripts/notify-hook/team-worker.js behavior exactly.
 *
 * Short-circuit: if OMC_TEAM_WORKER is not set, returns immediately (<1ms).
 *
 * State files:
 *   workers/{name}/heartbeat.json
 *   workers/{name}/status.json
 *   workers/{name}/prev-notify-state.json
 *   workers/{name}/worker-idle-notify.json
 *   all-workers-idle.json
 */
import { readFile, writeFile, mkdir, appendFile, rename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
// ── Env helpers ────────────────────────────────────────────────────────────
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
export function parseTeamWorkerEnv(rawValue) {
    if (typeof rawValue !== 'string')
        return null;
    const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
    if (!match)
        return null;
    return { teamName: match[1], workerName: match[2] };
}
export function resolveWorkerIdleNotifyEnabled() {
    const raw = safeString(process.env.OMC_TEAM_WORKER_IDLE_NOTIFY || '').trim().toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'off')
        return false;
    return true;
}
export function resolveWorkerIdleCooldownMs() {
    const raw = safeString(process.env.OMC_TEAM_WORKER_IDLE_COOLDOWN_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 5_000 && parsed <= 600_000)
        return parsed;
    return 30_000;
}
export function resolveAllWorkersIdleCooldownMs() {
    const raw = safeString(process.env.OMC_TEAM_ALL_IDLE_COOLDOWN_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 5_000 && parsed <= 600_000)
        return parsed;
    return 60_000;
}
function resolveStatusStaleMs() {
    const raw = safeString(process.env.OMC_TEAM_STATUS_STALE_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 5_000 && parsed <= 3_600_000)
        return parsed;
    return 120_000;
}
function resolveHeartbeatStaleMs() {
    const raw = safeString(process.env.OMC_TEAM_HEARTBEAT_STALE_MS || '');
    const parsed = asNumber(raw);
    if (parsed !== null && parsed >= 5_000 && parsed <= 3_600_000)
        return parsed;
    return 180_000;
}
// ── ISO timestamp helpers ──────────────────────────────────────────────────
function parseIsoMs(value) {
    const normalized = safeString(value).trim();
    if (!normalized)
        return null;
    const ms = Date.parse(normalized);
    if (!Number.isFinite(ms))
        return null;
    return ms;
}
function isFreshIso(value, maxAgeMs, nowMs) {
    const ts = parseIsoMs(value);
    if (ts === null)
        return false;
    return (nowMs - ts) <= maxAgeMs;
}
// ── JSON helpers ───────────────────────────────────────────────────────────
async function readJsonIfExists(path, fallback) {
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
async function readWorkerStatusSnapshot(stateDir, teamName, workerName, nowMs = Date.now()) {
    const statusPath = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
    try {
        if (!existsSync(statusPath))
            return { state: 'unknown', updated_at: null, fresh: false };
        const raw = await readFile(statusPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const state = parsed && typeof parsed.state === 'string' ? parsed.state : 'unknown';
        const updatedAt = parsed && typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
        let fresh = false;
        if (updatedAt) {
            fresh = isFreshIso(updatedAt, resolveStatusStaleMs(), nowMs);
        }
        else {
            try {
                const st = await stat(statusPath);
                fresh = (nowMs - st.mtimeMs) <= resolveStatusStaleMs();
            }
            catch {
                fresh = false;
            }
        }
        return { state, updated_at: updatedAt, fresh };
    }
    catch {
        return { state: 'unknown', updated_at: null, fresh: false };
    }
}
async function readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs = Date.now()) {
    const heartbeatPath = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
    try {
        if (!existsSync(heartbeatPath))
            return { last_turn_at: null, fresh: false, missing: true };
        const raw = await readFile(heartbeatPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const lastTurnAt = parsed && typeof parsed.last_turn_at === 'string' ? parsed.last_turn_at : null;
        const fresh = isFreshIso(lastTurnAt, resolveHeartbeatStaleMs(), nowMs);
        return { last_turn_at: lastTurnAt, fresh, missing: false };
    }
    catch {
        return { last_turn_at: null, fresh: false, missing: false };
    }
}
async function readTeamWorkersForIdleCheck(stateDir, teamName) {
    const manifestPath = join(stateDir, 'team', teamName, 'manifest.v2.json');
    const configPath = join(stateDir, 'team', teamName, 'config.json');
    const srcPath = existsSync(manifestPath) ? manifestPath : existsSync(configPath) ? configPath : null;
    if (!srcPath)
        return null;
    try {
        const raw = await readFile(srcPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return null;
        const workers = parsed.workers;
        if (!Array.isArray(workers) || workers.length === 0)
            return null;
        const tmuxSession = safeString(parsed.tmux_session || '').trim();
        const leaderPaneId = safeString(parsed.leader_pane_id || '').trim();
        return { workers, tmuxSession, leaderPaneId };
    }
    catch {
        return null;
    }
}
// ── Heartbeat update ───────────────────────────────────────────────────────
export async function updateWorkerHeartbeat(stateDir, teamName, workerName) {
    const heartbeatPath = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
    let turnCount = 0;
    try {
        const existing = JSON.parse(await readFile(heartbeatPath, 'utf-8'));
        turnCount = existing.turn_count || 0;
    }
    catch { /* first heartbeat or malformed */ }
    const heartbeat = {
        pid: process.ppid || process.pid,
        last_turn_at: new Date().toISOString(),
        turn_count: turnCount + 1,
        alive: true,
    };
    await mkdir(join(stateDir, 'team', teamName, 'workers', workerName), { recursive: true }).catch(() => { });
    await writeJsonAtomic(heartbeatPath, heartbeat);
}
// ── Idle notifications ─────────────────────────────────────────────────────
const DEFAULT_MARKER = '[OMC_TMUX_INJECT]';
export async function maybeNotifyLeaderWorkerIdle(params) {
    if (!resolveWorkerIdleNotifyEnabled())
        return;
    const { stateDir, parsedTeamWorker, tmux = defaultTmux } = params;
    const { teamName, workerName } = parsedTeamWorker;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const workerDir = join(stateDir, 'team', teamName, 'workers', workerName);
    const statusPath = join(workerDir, 'status.json');
    let currentState = 'unknown';
    let currentTaskId = '';
    let currentReason = '';
    let statusFresh = false;
    try {
        if (existsSync(statusPath)) {
            const parsed = JSON.parse(await readFile(statusPath, 'utf-8'));
            if (parsed && typeof parsed.state === 'string')
                currentState = parsed.state;
            if (parsed && typeof parsed.current_task_id === 'string')
                currentTaskId = parsed.current_task_id;
            if (parsed && typeof parsed.reason === 'string')
                currentReason = parsed.reason;
            const updatedAtField = parsed && typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
            if (updatedAtField) {
                statusFresh = isFreshIso(updatedAtField, resolveStatusStaleMs(), nowMs);
            }
            else {
                try {
                    const st = await stat(statusPath);
                    statusFresh = (nowMs - st.mtimeMs) <= resolveStatusStaleMs();
                }
                catch {
                    statusFresh = false;
                }
            }
        }
    }
    catch { /* ignore */ }
    // Read previous state for transition detection
    const prevStatePath = join(workerDir, 'prev-notify-state.json');
    let prevState = 'unknown';
    try {
        if (existsSync(prevStatePath)) {
            const parsed = JSON.parse(await readFile(prevStatePath, 'utf-8'));
            if (parsed && typeof parsed.state === 'string')
                prevState = parsed.state;
        }
    }
    catch { /* ignore */ }
    // Always update prev state
    try {
        await mkdir(workerDir, { recursive: true });
        await writeJsonAtomic(prevStatePath, { state: currentState, updated_at: nowIso });
    }
    catch { /* best effort */ }
    // Only fire on working->idle transition
    if (currentState !== 'idle')
        return;
    if (!statusFresh)
        return;
    if (prevState === 'idle' || prevState === 'done')
        return;
    const heartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs);
    if (!heartbeat.fresh)
        return;
    // Per-worker cooldown
    const cooldownPath = join(workerDir, 'worker-idle-notify.json');
    const cooldownMs = resolveWorkerIdleCooldownMs();
    let lastNotifiedMs = 0;
    try {
        if (existsSync(cooldownPath)) {
            const parsed = JSON.parse(await readFile(cooldownPath, 'utf-8'));
            lastNotifiedMs = asNumber(parsed && parsed.last_notified_at_ms) ?? 0;
        }
    }
    catch { /* ignore */ }
    if ((nowMs - lastNotifiedMs) < cooldownMs)
        return;
    // Read team config for tmux target
    const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
    if (!teamInfo)
        return;
    const { leaderPaneId } = teamInfo;
    if (!leaderPaneId)
        return;
    // Build notification message
    const parts = [`[OMC] ${workerName} idle`];
    if (prevState && prevState !== 'unknown')
        parts.push(`(was: ${prevState})`);
    if (currentTaskId)
        parts.push(`task: ${currentTaskId}`);
    if (currentReason)
        parts.push(`reason: ${currentReason}`);
    const message = `${parts.join('. ')}. ${DEFAULT_MARKER}`;
    const logWorkerIdlePersistenceFailure = createSwallowedErrorLogger('hooks.team-worker maybeNotifyLeaderWorkerIdle persistence failed');
    try {
        await tmux.sendKeys(leaderPaneId, message, true);
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        // Update cooldown state
        await writeJsonAtomic(cooldownPath, {
            last_notified_at_ms: nowMs,
            last_notified_at: nowIso,
            prev_state: prevState,
        }).catch(logWorkerIdlePersistenceFailure);
        // Append event
        const eventsDir = join(stateDir, 'team', teamName, 'events');
        const eventsPath = join(eventsDir, 'events.ndjson');
        try {
            await mkdir(eventsDir, { recursive: true });
            const event = {
                event_id: `worker-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                team: teamName,
                type: 'worker_idle',
                worker: workerName,
                prev_state: prevState,
                task_id: currentTaskId || null,
                reason: currentReason || null,
                created_at: nowIso,
            };
            await appendFile(eventsPath, JSON.stringify(event) + '\n');
        }
        catch { /* best effort */ }
    }
    catch { /* tmux send failure is non-fatal */ }
}
export async function maybeNotifyLeaderAllWorkersIdle(params) {
    const { stateDir, parsedTeamWorker, tmux = defaultTmux } = params;
    const { teamName, workerName } = parsedTeamWorker;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // Only trigger when this worker is idle
    const mySnapshot = await readWorkerStatusSnapshot(stateDir, teamName, workerName, nowMs);
    if (mySnapshot.state !== 'idle' || !mySnapshot.fresh)
        return;
    const myHeartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs);
    if (!myHeartbeat.fresh)
        return;
    const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
    if (!teamInfo)
        return;
    const { workers, leaderPaneId } = teamInfo;
    // Check cooldown
    const idleStatePath = join(stateDir, 'team', teamName, 'all-workers-idle.json');
    const idleState = (await readJsonIfExists(idleStatePath, null)) ?? {};
    const cooldownMs = resolveAllWorkersIdleCooldownMs();
    const lastNotifiedMs = asNumber(idleState.last_notified_at_ms) ?? 0;
    if ((nowMs - lastNotifiedMs) < cooldownMs)
        return;
    // Check ALL workers idle
    const snapshots = await Promise.all(workers.map(async (w) => {
        const worker = safeString(w && w.name ? w.name : '');
        const status = await readWorkerStatusSnapshot(stateDir, teamName, worker, nowMs);
        const heartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, worker, nowMs);
        return { worker, status, heartbeat };
    }));
    const allIdle = snapshots.length > 0 && snapshots.every(({ status, heartbeat }) => (status.state === 'idle' || status.state === 'done') && status.fresh && heartbeat.fresh);
    if (!allIdle)
        return;
    if (!leaderPaneId)
        return;
    const N = workers.length;
    const message = `[OMC] All ${N} worker${N === 1 ? '' : 's'} idle. Ready for next instructions. ${DEFAULT_MARKER}`;
    const logAllWorkersIdlePersistenceFailure = createSwallowedErrorLogger('hooks.team-worker maybeNotifyLeaderAllWorkersIdle persistence failed');
    try {
        await tmux.sendKeys(leaderPaneId, message, true);
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        await new Promise(r => setTimeout(r, 100));
        await tmux.sendKeys(leaderPaneId, 'C-m');
        await writeJsonAtomic(idleStatePath, {
            ...idleState,
            last_notified_at_ms: nowMs,
            last_notified_at: nowIso,
            worker_count: N,
        }).catch(logAllWorkersIdlePersistenceFailure);
        // Append event
        const eventsDir = join(stateDir, 'team', teamName, 'events');
        const eventsPath = join(eventsDir, 'events.ndjson');
        try {
            await mkdir(eventsDir, { recursive: true });
            const event = {
                event_id: `all-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                team: teamName,
                type: 'all_workers_idle',
                worker: workerName,
                worker_count: N,
                created_at: nowIso,
            };
            await appendFile(eventsPath, JSON.stringify(event) + '\n');
        }
        catch { /* best effort */ }
    }
    catch { /* tmux send failure is non-fatal */ }
}
// ── Main handler ───────────────────────────────────────────────────────────
export async function handleWorkerTurn(teamName, workerName, cwd, tmux) {
    const stateDir = join(cwd, '.omc', 'state');
    const parsedTeamWorker = { teamName, workerName };
    await updateWorkerHeartbeat(stateDir, teamName, workerName);
    await maybeNotifyLeaderWorkerIdle({ cwd, stateDir, parsedTeamWorker, tmux });
    await maybeNotifyLeaderAllWorkersIdle({ cwd, stateDir, parsedTeamWorker, tmux });
}
//# sourceMappingURL=team-worker-hook.js.map