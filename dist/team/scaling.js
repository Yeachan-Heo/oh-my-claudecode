/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMC_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */
import { resolve } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { tmuxExec, tmuxSpawn } from '../cli/tmux-utils.js';
import { buildWorkerArgv, getWorkerEnv as getModelWorkerEnv, resolveClaudeWorkerModel, } from './model-contract.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { routeTaskToRole } from './role-router.js';
import { teamReadConfig, teamWriteWorkerIdentity, teamReadWorkerStatus, teamAppendEvent, writeAtomic, } from './team-ops.js';
import { withScalingLock, saveTeamConfig } from './monitor.js';
import { sanitizeName, getWorkerLiveness, killWorkerPanes, buildWorkerStartCommand, waitForPaneReady, } from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';
import { writeWorkerOverlay } from './worker-bootstrap.js';
import { ensureWorkerWorktree, installWorktreeRootAgents, prepareWorkerWorktreeForRemoval, removeWorkerWorktree, restoreWorktreeRootAgents, } from './git-worktree.js';
// ── Environment gate ──────────────────────────────────────────────────────────
function sharedStateRoot(cwd) {
    return `${cwd}/.omc/state`;
}
const OMC_TEAM_SCALING_ENABLED_ENV = 'OMC_TEAM_SCALING_ENABLED';
const CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini']);
export function isScalingEnabled(env = process.env) {
    const raw = env[OMC_TEAM_SCALING_ENABLED_ENV];
    if (!raw)
        return false;
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}
function assertScalingEnabled(env = process.env) {
    if (!isScalingEnabled(env)) {
        throw new Error(`Dynamic scaling is disabled. Set ${OMC_TEAM_SCALING_ENABLED_ENV}=1 to enable.`);
    }
}
function asCliAgentType(agentType) {
    if (CLI_AGENT_TYPES.has(agentType)) {
        return agentType;
    }
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Array.from(CLI_AGENT_TYPES).join(', ')}`);
}
// ── Scale Up ──────────────────────────────────────────────────────────────────
/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUp(teamName, count, agentType, tasks, cwd, env = process.env) {
    assertScalingEnabled(env);
    const cliAgentType = asCliAgentType(agentType);
    if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
    }
    const sanitized = sanitizeName(teamName);
    const leaderCwd = resolve(cwd);
    return await withScalingLock(sanitized, leaderCwd, async () => {
        const config = await teamReadConfig(sanitized, leaderCwd);
        if (!config) {
            return { ok: false, error: `Team ${sanitized} not found` };
        }
        const maxWorkers = config.max_workers ?? 20;
        const currentCount = config.workers.length;
        if (currentCount + count > maxWorkers) {
            return {
                ok: false,
                error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
            };
        }
        const teamStateRoot = config.team_state_root ?? sharedStateRoot(leaderCwd);
        const worktreeMode = config.worktree_mode ?? 'disabled';
        // Resolve the monotonic worker index counter
        let nextIndex = config.next_worker_index ?? (currentCount + 1);
        const addedWorkers = [];
        const pendingWorktrees = [];
        const cleanupScaledWorkerWorktree = (workerName, created) => {
            if (created) {
                removeWorkerWorktree(sanitized, workerName, leaderCwd);
            }
            else {
                const restored = restoreWorktreeRootAgents(sanitized, workerName, leaderCwd);
                if (restored.reason === 'agents_dirty') {
                    throw new Error(`agents_dirty: preserving modified worktree root AGENTS.md for ${workerName}`);
                }
            }
        };
        const rollbackScaleUp = async (error, paneId) => {
            const cleanedWorktrees = new Set();
            for (const w of addedWorkers) {
                const idx = config.workers.findIndex((worker) => worker.name === w.name);
                if (idx >= 0) {
                    config.workers.splice(idx, 1);
                }
                try {
                    if (w.pane_id) {
                        tmuxExec(['kill-pane', '-t', w.pane_id], { stdio: 'pipe' });
                    }
                    if (w.worktree_path) {
                        cleanupScaledWorkerWorktree(w.name, w.worktree_created === true);
                        cleanedWorktrees.add(w.name);
                    }
                }
                catch { /* best-effort pane/worktree cleanup */ }
            }
            for (const pending of pendingWorktrees) {
                if (cleanedWorktrees.has(pending.workerName))
                    continue;
                try {
                    cleanupScaledWorkerWorktree(pending.workerName, pending.created);
                }
                catch { /* best-effort pending worktree cleanup */ }
            }
            if (paneId) {
                try {
                    tmuxExec(['kill-pane', '-t', paneId], { stdio: 'pipe' });
                }
                catch { /* best-effort pane cleanup */ }
            }
            config.worker_count = config.workers.length;
            config.next_worker_index = nextIndex;
            await saveTeamConfig(config, leaderCwd);
            return { ok: false, error };
        };
        for (let i = 0; i < count; i++) {
            // Skip past any colliding worker names so stale next_worker_index
            // values self-heal instead of causing a permanent failure loop.
            const maxSkip = config.workers.length + count;
            let skipped = 0;
            while (config.workers.some((w) => w.name === `worker-${nextIndex}`) && skipped < maxSkip) {
                nextIndex++;
                skipped++;
            }
            const workerIndex = nextIndex;
            nextIndex++;
            const workerName = `worker-${workerIndex}`;
            if (config.workers.some((worker) => worker.name === workerName)) {
                // Persist the advanced index so the next call does not repeat.
                config.next_worker_index = nextIndex;
                await saveTeamConfig(config, leaderCwd);
                await teamAppendEvent(sanitized, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: `scale_up_duplicate_worker_blocked:${workerName}`,
                }, leaderCwd);
                return {
                    ok: false,
                    error: `Worker ${workerName} already exists in team ${sanitized}; refusing to spawn duplicate worker identity.`,
                };
            }
            // Create worker directory
            const workerDirPath = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
            await mkdir(workerDirPath, { recursive: true });
            const worktree = worktreeMode === 'disabled'
                ? null
                : ensureWorkerWorktree(sanitized, workerName, leaderCwd, {
                    mode: worktreeMode,
                    requireCleanLeader: true,
                });
            if (worktree) {
                pendingWorktrees.push({ workerName, created: worktree.created });
            }
            const workerCwd = worktree?.path ?? leaderCwd;
            // Resolve per-worker provider/model from the team's routing snapshot
            // (Option E stickiness — snapshot is immutable, never re-resolved).
            // Worker's inferred role comes from the owned-task `role` field when all
            // owned tasks agree on a single role; otherwise falls back to the
            // caller-supplied agentType default.
            const workerTasks = tasks.filter(t => t.owner === workerName);
            const ownedRoles = Array.from(new Set(workerTasks.map(t => t.role).filter(Boolean)));
            const inferredRole = ownedRoles.length === 1
                ? ownedRoles[0]
                : (workerTasks[0]
                    ? routeTaskToRole(workerTasks[0].subject, workerTasks[0].description, 'executor').role
                    : undefined);
            const canonicalRoleSet = new Set(CANONICAL_TEAM_ROLES);
            const canonical = inferredRole
                ? (() => {
                    const normalized = normalizeDelegationRole(inferredRole);
                    return canonicalRoleSet.has(normalized) ? normalized : null;
                })()
                : null;
            let workerAgentType = cliAgentType;
            let workerModel;
            // Only override caller's agentType when the worker's inferred role came
            // from an explicit `task.role` (user opt-in). Pre-patch semantics: callers
            // passing `--agent-type codex` stay on codex regardless of task text.
            const hasExplicitOwnedRole = ownedRoles.length === 1;
            const routedPair = hasExplicitOwnedRole && canonical
                ? config.resolved_routing?.[canonical]
                : undefined;
            if (routedPair) {
                const { primary } = routedPair;
                const primaryProvider = primary.provider;
                if (CLI_AGENT_TYPES.has(primaryProvider)) {
                    workerAgentType = primaryProvider;
                    workerModel = primary.model;
                }
            }
            else if (cliAgentType === 'claude') {
                // Honor Bedrock/Vertex default-model resolution for non-routed claude workers.
                workerModel = resolveClaudeWorkerModel(env);
            }
            // AC-8: try the resolved provider first; on trust-path / not-found
            // failure, emit a loud warning and retry with the snapshot's Claude
            // fallback tuple. Aborting the scale_up silently would mask a missing
            // CLI, so we only rollback if even the fallback cannot be built.
            const tryBuildLaunch = (agentType, model) => {
                const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
                    teamName: sanitized,
                    workerName,
                    cwd: workerCwd,
                    ...(model ? { model } : {}),
                });
                return { launchBinary, launchArgs };
            };
            let launchBinary;
            let launchArgs;
            try {
                ({ launchBinary, launchArgs } = tryBuildLaunch(workerAgentType, workerModel));
            }
            catch (primaryError) {
                const primaryReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
                const fallbackPair = routedPair?.fallback;
                const fallbackProvider = fallbackPair
                    ? fallbackPair.provider
                    : 'claude';
                const fallbackModel = fallbackPair?.model;
                process.stderr.write(`[team/scaling] cli_binary_missing:${workerAgentType}: ${primaryReason} — falling back to ${fallbackProvider} (AC-8)\n`);
                await teamAppendEvent(sanitized, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: `cli_binary_missing:${workerAgentType}:${primaryReason}:fallback=${fallbackProvider}`,
                }, leaderCwd);
                try {
                    ({ launchBinary, launchArgs } = tryBuildLaunch(fallbackProvider, fallbackModel));
                    workerAgentType = fallbackProvider;
                    workerModel = fallbackModel;
                }
                catch (fallbackError) {
                    const fallbackReason = fallbackError instanceof Error
                        ? fallbackError.message
                        : String(fallbackError);
                    return await rollbackScaleUp(`Failed to resolve worker launch config for ${workerName} (primary=${workerAgentType}: ${primaryReason}; fallback=${fallbackProvider}: ${fallbackReason})`);
                }
            }
            // Rebuild env using the final agentType (fallback may have swapped it).
            const extraEnv = {
                ...getModelWorkerEnv(sanitized, workerName, workerAgentType, env),
                OMC_TEAM_STATE_ROOT: teamStateRoot,
                OMC_TEAM_LEADER_CWD: leaderCwd,
                ...(worktree ? { OMC_TEAM_WORKTREE_PATH: worktree.path, OMC_TEAM_WORKER_CWD: workerCwd } : {}),
            };
            if (worktree) {
                try {
                    const workerOverlayParams = {
                        teamName: sanitized,
                        workerName,
                        agentType: workerAgentType,
                        tasks: tasks.map((t, idx) => ({
                            id: String(idx + 1),
                            subject: t.subject,
                            description: t.description,
                        })),
                        cwd: leaderCwd,
                        instructionStateRoot: '$OMC_TEAM_STATE_ROOT',
                    };
                    const overlayPath = await writeWorkerOverlay(workerOverlayParams);
                    const overlayContent = await readFile(overlayPath, 'utf-8');
                    installWorktreeRootAgents(sanitized, workerName, leaderCwd, worktree.path, overlayContent);
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return await rollbackScaleUp(`Failed to install worker overlay for ${workerName}: ${reason}`);
                }
            }
            let cmd;
            try {
                cmd = buildWorkerStartCommand({
                    teamName: sanitized,
                    workerName,
                    envVars: extraEnv,
                    launchArgs,
                    launchBinary,
                    cwd: workerCwd,
                });
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return await rollbackScaleUp(`Failed to build worker start command for ${workerName}: ${reason}`);
            }
            // Split from the rightmost worker pane or the leader pane
            const splitTarget = config.workers.length > 0
                ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
                : (config.leader_pane_id ?? '');
            const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';
            const result = tmuxSpawn([
                'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd, cmd,
            ]);
            if (result.status !== 0) {
                return await rollbackScaleUp(`Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`);
            }
            const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
            if (!paneId || !paneId.startsWith('%')) {
                return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`);
            }
            // Get PID
            let panePid;
            try {
                const pidResult = tmuxSpawn(['display-message', '-t', paneId, '-p', '#{pane_pid}']);
                const pidStr = (pidResult.stdout || '').trim();
                const parsed = Number.parseInt(pidStr, 10);
                if (Number.isFinite(parsed))
                    panePid = parsed;
            }
            catch { /* best-effort pid lookup */ }
            // Resolve per-worker role from assigned task roles
            const workerTaskRoles = tasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean);
            const uniqueTaskRoles = new Set(workerTaskRoles);
            const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1
                ? workerTaskRoles[0]
                : agentType;
            const workerInfo = {
                name: workerName,
                index: workerIndex,
                role: workerRole,
                assigned_tasks: [],
                pid: panePid,
                pane_id: paneId,
                working_dir: workerCwd,
                team_state_root: teamStateRoot,
                ...(worktree ? {
                    worktree_repo_root: leaderCwd,
                    worktree_path: worktree.path,
                    worktree_branch: worktree.branch,
                    worktree_detached: worktree.detached,
                    worktree_created: worktree.created,
                } : {}),
            };
            await teamWriteWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);
            // Wait for worker readiness
            const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
            const skipReadyWait = env.OMC_TEAM_SKIP_READY_WAIT === '1';
            if (!skipReadyWait) {
                try {
                    await waitForPaneReady(paneId, { timeoutMs: readyTimeoutMs });
                }
                catch {
                    // Non-fatal: worker may still become ready
                }
            }
            addedWorkers.push(workerInfo);
            const pendingIndex = pendingWorktrees.findIndex(pending => pending.workerName === workerName);
            if (pendingIndex >= 0)
                pendingWorktrees.splice(pendingIndex, 1);
            config.workers.push(workerInfo);
            config.worker_count = config.workers.length;
            config.next_worker_index = nextIndex;
            await saveTeamConfig(config, leaderCwd);
        }
        await teamAppendEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
        }, leaderCwd);
        return {
            ok: true,
            addedWorkers,
            newWorkerCount: config.worker_count,
            nextWorkerIndex: nextIndex,
        };
    });
}
/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDown(teamName, cwd, options = {}, env = process.env) {
    assertScalingEnabled(env);
    const sanitized = sanitizeName(teamName);
    const leaderCwd = resolve(cwd);
    const force = options.force === true;
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    return await withScalingLock(sanitized, leaderCwd, async () => {
        const config = await teamReadConfig(sanitized, leaderCwd);
        if (!config) {
            return { ok: false, error: `Team ${sanitized} not found` };
        }
        // Determine which workers to remove
        let targetWorkers;
        if (options.workerNames && options.workerNames.length > 0) {
            targetWorkers = [];
            for (const name of options.workerNames) {
                const w = config.workers.find(w => w.name === name);
                if (!w) {
                    return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
                }
                targetWorkers.push(w);
            }
        }
        else {
            const count = options.count ?? 1;
            if (!Number.isInteger(count) || count < 1) {
                return { ok: false, error: `count must be a positive integer (got ${count})` };
            }
            // Find idle workers to remove
            const idleWorkers = [];
            for (const w of config.workers) {
                const status = await teamReadWorkerStatus(sanitized, w.name, leaderCwd);
                if (status.state === 'idle' || status.state === 'done' || status.state === 'unknown') {
                    idleWorkers.push(w);
                }
            }
            if (idleWorkers.length < count && !force) {
                return {
                    ok: false,
                    error: `Not enough idle workers to remove: found ${idleWorkers.length}, requested ${count}. Use force=true to remove busy workers.`,
                };
            }
            targetWorkers = idleWorkers.slice(0, count);
            if (force && targetWorkers.length < count) {
                const remaining = count - targetWorkers.length;
                const targetNames = new Set(targetWorkers.map(w => w.name));
                const nonIdle = config.workers.filter(w => !targetNames.has(w.name));
                targetWorkers.push(...nonIdle.slice(0, remaining));
            }
        }
        if (targetWorkers.length === 0) {
            return { ok: false, error: 'No workers selected for removal' };
        }
        // Minimum worker guard: must keep at least 1 worker
        if (config.workers.length - targetWorkers.length < 1) {
            return { ok: false, error: 'Cannot remove all workers — at least 1 must remain' };
        }
        const removedNames = [];
        // Phase 1: Set workers to 'draining' status. Worktree safety is checked
        // after the drain/kill boundary so active workers can finish and clean up
        // ordinary in-progress work before removal is attempted.
        for (const w of targetWorkers) {
            const drainingStatus = {
                state: 'draining',
                reason: 'scale_down requested by leader',
                updated_at: new Date().toISOString(),
            };
            const statusPath = absPath(leaderCwd, TeamPaths.workerStatus(sanitized, w.name));
            await writeAtomic(statusPath, JSON.stringify(drainingStatus, null, 2));
        }
        // Phase 2: Wait for draining workers to finish or timeout
        if (!force) {
            const deadline = Date.now() + drainTimeoutMs;
            while (Date.now() < deadline) {
                const allDrained = await Promise.all(targetWorkers.map(async (w) => {
                    const status = await teamReadWorkerStatus(sanitized, w.name, leaderCwd);
                    const liveness = w.pane_id ? await getWorkerLiveness(w.pane_id) : 'dead';
                    return status.state === 'idle' || status.state === 'done' || liveness === 'dead';
                }));
                if (allDrained.every(Boolean))
                    break;
                await new Promise(r => setTimeout(r, 2_000));
            }
        }
        // Phase 3: Kill tmux panes after workers have had a chance to drain.
        const targetPaneIds = targetWorkers
            .map((w) => w.pane_id)
            .filter((paneId) => typeof paneId === 'string' && paneId.trim().length > 0);
        await killWorkerPanes({
            paneIds: targetPaneIds,
            leaderPaneId: config.leader_pane_id ?? undefined,
            teamName: sanitized,
            cwd: leaderCwd,
        });
        const liveness = await Promise.all(targetWorkers.map(async (w) => (w.pane_id ? [w.name, await getWorkerLiveness(w.pane_id)] : [w.name, 'dead'])));
        const aliveNames = liveness.filter(([, state]) => state === 'alive').map(([name]) => name);
        if (aliveNames.length > 0) {
            return { ok: false, error: `Refusing to remove worker state while pane(s) are still alive: ${aliveNames.join(', ')}` };
        }
        const unknownNames = liveness.filter(([, state]) => state === 'unknown').map(([name]) => name);
        if (unknownNames.length > 0) {
            return { ok: false, error: `Refusing to remove worker state while pane liveness is unknown: ${unknownNames.join(', ')}` };
        }
        for (const w of targetWorkers) {
            if (w.worktree_path) {
                try {
                    if (w.worktree_created) {
                        removeWorkerWorktree(sanitized, w.name, leaderCwd);
                    }
                    else {
                        prepareWorkerWorktreeForRemoval(sanitized, w.name, leaderCwd, w.worktree_path);
                    }
                }
                catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    return { ok: false, error: `Failed to remove worktree for ${w.name}: ${reason}` };
                }
            }
            removedNames.push(w.name);
        }
        // Phase 5: Update config
        const removedSet = new Set(removedNames);
        config.workers = config.workers.filter(w => !removedSet.has(w.name));
        config.worker_count = config.workers.length;
        await saveTeamConfig(config, leaderCwd);
        await teamAppendEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`,
        }, leaderCwd);
        return {
            ok: true,
            removedWorkers: removedNames,
            newWorkerCount: config.worker_count,
        };
    });
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveWorkerReadyTimeoutMs(env) {
    const raw = env.OMC_TEAM_READY_TIMEOUT_MS;
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed) && parsed >= 5_000)
        return parsed;
    return 45_000;
}
//# sourceMappingURL=scaling.js.map