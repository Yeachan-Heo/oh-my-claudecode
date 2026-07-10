/**
 * Subagent Tracker Hook Module
 *
 * Tracks SubagentStart and SubagentStop events for comprehensive agent monitoring.
 * Features:
 * - Track all spawned agents with parent mode context
 * - Detect stuck/stale agents (>5 min without progress)
 * - HUD integration for agent status display
 * - Automatic cleanup of orphaned agent state
 *
 * Storage: session-scoped under .omc/state/sessions/{sessionId}/subagent-tracking-state.json
 * Locking:  withFileLockSync from file-lock.ts (O_CREAT|O_EXCL advisory lock)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, } from "fs";
import { dirname, join } from "path";
import { getOmcRoot, resolveSessionStatePaths } from '../../lib/worktree-paths.js';
import { resolveSessionId } from '../../lib/session-id.js';
import { withFileLockSync, lockPathFor } from '../../lib/file-lock.js';
import { recordAgentStart, recordAgentStop } from './session-replay.js';
import { recordMissionAgentStart, recordMissionAgentStop } from '../../hud/mission-board.js';
export const COST_LIMIT_USD = 1.0;
export const DEADLOCK_CHECK_THRESHOLD = 3;
// ============================================================================
// Constants
// ============================================================================
const STATE_NAME = "subagent-tracking";
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_COMPLETED_AGENTS = 100;
const WRITE_DEBOUNCE_MS = 100;
const MAX_FLUSH_RETRIES = 3;
const FLUSH_RETRY_BASE_MS = 50;
const UNTRACKED_NATIVE_FORK_AGENT_TYPE = "untracked-native-fork";
const UNMATCHED_STOP_TELEMETRY_NOTE = "SubagentStop arrived without a matching SubagentStart; native Agent/Task start telemetry was not observed.";
// Lock options — short timeout for hot-path writes; stale detection generous
// so healthy writers aren't mistakenly treated as abandoned.
const LOCK_OPTS = {
    timeoutMs: 500,
    retryDelayMs: 50,
    staleLockMs: 30_000,
};
// Per write-path debounce state for batching writes (avoids race conditions).
// Key: resolved write path (session-scoped when sessionId present, legacy otherwise).
// Each session gets its own slot so concurrent sessions don't overwrite each other.
const pendingWrites = new Map();
// Guard against duplicate concurrent flushes per write path
const flushInProgress = new Set();
/**
 * Synchronous sleep using Atomics.wait
 * Avoids CPU-spinning busy-wait loops
 */
function syncSleep(ms) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    try {
        Atomics.wait(view, 0, 0, ms);
    }
    catch {
        // Main thread: Atomics.wait throws on Node <22
        const waitUntil = Date.now() + ms;
        while (Date.now() < waitUntil) { /* spin */ }
    }
}
// ============================================================================
// Path helpers
// ============================================================================
/**
 * Resolve the effective write path for subagent-tracking given a cwd and
 * optional session ID. This is the canonical path used for all I/O.
 */
function resolveWritePath(directory, sessionId) {
    const paths = resolveSessionStatePaths(STATE_NAME, sessionId, directory);
    return paths.effectiveWrite;
}
/**
 * Resolve the effective read path for subagent-tracking given a cwd and
 * optional session ID (probes session-scoped first, then legacy fallback).
 */
function resolveReadPath(directory, sessionId) {
    const paths = resolveSessionStatePaths(STATE_NAME, sessionId, directory);
    return paths.effectiveRead;
}
/**
 * Ensure the directory for a file path exists.
 */
function ensureParentDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
// ============================================================================
// Merge Logic
// ============================================================================
/**
 * Merge two tracker states with deterministic semantics.
 * Used by debounced flush to combine disk state with in-memory pending state.
 *
 * Merge rules:
 * - Counters (total_spawned, total_completed, total_failed): Math.max
 * - Agents: union by agent_id; if same ID exists in both, newer timestamp wins
 * - last_updated: Math.max of both timestamps
 */
export function mergeTrackerStates(diskState, pendingState) {
    // Build agent map: start with disk agents, overlay with pending
    const agentMap = new Map();
    for (const agent of diskState.agents) {
        agentMap.set(agent.agent_id, agent);
    }
    for (const agent of pendingState.agents) {
        const existing = agentMap.get(agent.agent_id);
        if (!existing) {
            // New agent from pending state
            agentMap.set(agent.agent_id, agent);
        }
        else {
            // Same agent_id in both - pick the one with the newer relevant timestamp
            const existingTime = existing.completed_at
                ? new Date(existing.completed_at).getTime()
                : new Date(existing.started_at).getTime();
            const pendingTime = agent.completed_at
                ? new Date(agent.completed_at).getTime()
                : new Date(agent.started_at).getTime();
            if (pendingTime >= existingTime) {
                agentMap.set(agent.agent_id, agent);
            }
        }
    }
    // Counters: take max to avoid double-counting
    const total_spawned = Math.max(diskState.total_spawned, pendingState.total_spawned);
    const total_completed = Math.max(diskState.total_completed, pendingState.total_completed);
    const total_failed = Math.max(diskState.total_failed, pendingState.total_failed);
    // Timestamp: take the latest
    const diskTime = new Date(diskState.last_updated).getTime();
    const pendingTime = new Date(pendingState.last_updated).getTime();
    const last_updated = diskTime > pendingTime ? diskState.last_updated : pendingState.last_updated;
    return {
        agents: Array.from(agentMap.values()),
        total_spawned,
        total_completed,
        total_failed,
        last_updated,
    };
}
// ============================================================================
// State Management
// ============================================================================
/**
 * Get the state file path for a given directory and optional session ID.
 * Creates the parent directory if it does not exist.
 *
 * @deprecated Use resolveWritePath / resolveReadPath for new code.
 */
export function getStateFilePath(directory, sessionId) {
    const p = resolveWritePath(directory, sessionId);
    ensureParentDir(p);
    return p;
}
/**
 * Read tracking state directly from disk, bypassing the pending writes cache.
 * Used during flush to get the latest on-disk state for merging.
 *
 * When sessionId is provided, reads the session-scoped file (or legacy fallback).
 * When sessionId is absent, reads the legacy file. If the legacy file doesn't exist
 * but session-scoped files do exist under this directory, merges them all — this
 * preserves backward-compat for callers that read without a session ID after state
 * was written exclusively to session-scoped paths.
 */
export function readDiskState(directory, sessionId) {
    const empty = () => ({
        agents: [],
        total_spawned: 0,
        total_completed: 0,
        total_failed: 0,
        last_updated: new Date().toISOString(),
    });
    const readFile = (p) => {
        if (!existsSync(p))
            return null;
        try {
            return JSON.parse(readFileSync(p, "utf-8"));
        }
        catch (error) {
            console.error("[SubagentTracker] Error reading disk state:", error);
            return null;
        }
    };
    if (sessionId) {
        // Session-scoped read: read sessionScoped path EXCLUSIVELY (no legacy fallback).
        // Legacy fallback would leak agents/counters from the pre-session file into a
        // fresh session on its first read — see executeFlush which calls this before
        // merging a delta into disk state.
        const paths = resolveSessionStatePaths(STATE_NAME, sessionId, directory);
        return readFile(paths.sessionScoped) ?? empty();
    }
    // Legacy read: try the legacy path first
    const legacyState = readFile(resolveReadPath(directory, undefined));
    if (legacyState)
        return legacyState;
    // Legacy file absent — scan session-scoped files and merge them all.
    // This handles the backward-compat case where a hook wrote to session-scoped paths
    // but the caller reads without a session ID (e.g. after flushPendingWrites).
    const sessionsDir = join(getOmcRoot(directory), 'state', 'sessions');
    if (!existsSync(sessionsDir))
        return empty();
    let merged = empty();
    try {
        const entries = readdirSync(sessionsDir, { withFileTypes: true });
        const normalizedName = `${STATE_NAME}-state.json`;
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const sessionState = readFile(join(sessionsDir, entry.name, normalizedName));
            if (sessionState) {
                merged = mergeTrackerStates(merged, sessionState);
            }
        }
    }
    catch {
        // readdirSync failed — return empty
    }
    return merged;
}
/**
 * Read tracking state from file.
 * If there's a pending write for this directory/session, returns it instead of reading disk.
 *
 * When sessionId is provided, looks for a pending write keyed by the exact session-scoped
 * write path (precise, no cross-session contamination).
 *
 * When sessionId is absent, returns the pending write for the legacy path if present,
 * then falls back to checking if any pending write belongs to this directory (any session)
 * — this preserves backward-compat for callers that wrote with a session ID (e.g. via a
 * hook) and then read back without one immediately afterward.
 */
export function readTrackingState(directory, sessionId) {
    // Pending writes are keyed by write path (session-scoped when sid present)
    const writePath = resolveWritePath(directory, sessionId);
    const pending = pendingWrites.get(writePath);
    if (pending) {
        return pending.state;
    }
    // When no sessionId is given, check if there is a pending write associated with this
    // exact directory (any session). Each entry stores its origin directory so we can
    // match without string prefix heuristics.
    if (!sessionId) {
        const normalizedDir = join(directory); // normalize separators via path.join
        for (const entry of pendingWrites.values()) {
            if (entry.directory === normalizedDir) {
                return entry.state;
            }
        }
    }
    return readDiskState(directory, sessionId);
}
/**
 * Write tracking state to file immediately (bypasses debounce).
 */
function writeTrackingStateImmediate(directory, state, sessionId) {
    const statePath = resolveWritePath(directory, sessionId);
    ensureParentDir(statePath);
    state.last_updated = new Date().toISOString();
    try {
        writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    }
    catch (error) {
        console.error("[SubagentTracker] Error writing state:", error);
    }
}
/**
 * Execute the flush: lock -> re-read disk -> merge -> write -> unlock.
 * Uses withFileLockSync from file-lock.ts for proper O_CREAT|O_EXCL locking.
 * Returns true on success, false if lock could not be acquired.
 */
export function executeFlush(directory, pendingState, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        withFileLockSync(lockPath, () => {
            // Re-read latest disk state to avoid overwriting concurrent changes
            const diskState = readDiskState(directory, sessionId);
            const merged = mergeTrackerStates(diskState, pendingState);
            writeTrackingStateImmediate(directory, merged, sessionId);
        }, LOCK_OPTS);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Write tracking state with debouncing to reduce I/O.
 * The flush callback acquires the lock, re-reads disk state, merges with
 * the pending in-memory delta, and writes atomically.
 * If the lock cannot be acquired, retries with exponential backoff (max 3 retries).
 *
 * Keyed by write path (session-scoped when sessionId is present) so different
 * sessions never share a debounce slot.
 */
export function writeTrackingState(directory, state, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    const normalizedDir = join(directory); // normalize separators
    const existing = pendingWrites.get(writePath);
    if (existing) {
        clearTimeout(existing.timeout);
    }
    const timeout = setTimeout(() => {
        const pending = pendingWrites.get(writePath);
        if (!pending)
            return;
        pendingWrites.delete(writePath);
        // Guard against duplicate concurrent flushes for the same path
        if (flushInProgress.has(writePath)) {
            // Re-queue: put it back and let the next debounce cycle handle it
            pendingWrites.set(writePath, {
                state: pending.state,
                sessionId,
                directory: normalizedDir,
                timeout: setTimeout(() => {
                    writeTrackingState(directory, pending.state, sessionId);
                }, WRITE_DEBOUNCE_MS),
            });
            return;
        }
        flushInProgress.add(writePath);
        try {
            // Try flush with bounded retries on lock failure
            let success = false;
            for (let attempt = 0; attempt < MAX_FLUSH_RETRIES; attempt++) {
                success = executeFlush(directory, pending.state, sessionId);
                if (success)
                    break;
                // Exponential backoff before retry
                syncSleep(FLUSH_RETRY_BASE_MS * Math.pow(2, attempt));
            }
            if (!success) {
                console.error(`[SubagentTracker] Failed to flush after ${MAX_FLUSH_RETRIES} retries for ${directory}. Data retained in memory for next attempt.`);
                // Put data back in pending so the next writeTrackingState call will retry
                pendingWrites.set(writePath, {
                    state: pending.state,
                    sessionId,
                    directory: normalizedDir,
                    timeout: setTimeout(() => {
                        // No-op: data is just stored, will be picked up by next write or flushPendingWrites
                    }, 0),
                });
            }
        }
        finally {
            flushInProgress.delete(writePath);
        }
    }, WRITE_DEBOUNCE_MS);
    pendingWrites.set(writePath, { state, sessionId, directory: normalizedDir, timeout });
}
/**
 * Flush any pending debounced writes immediately using the merge-aware path.
 * Call this in tests before cleanup to ensure state is persisted.
 */
export function flushPendingWrites() {
    for (const pending of pendingWrites.values()) {
        clearTimeout(pending.timeout);
        try {
            // Use the same merge-aware locked flush as the debounced path.
            // On lock failure, fall back to a direct write so tests with no
            // contention still persist state.
            if (!executeFlush(pending.directory, pending.state, pending.sessionId)) {
                writeTrackingStateImmediate(pending.directory, pending.state, pending.sessionId);
            }
        }
        catch (error) {
            console.error("[SubagentTracker] Error during flushPendingWrites:", error);
        }
    }
    pendingWrites.clear();
}
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Detect the current parent mode from state files
 */
function detectParentMode(directory) {
    const stateDir = join(getOmcRoot(directory), "state");
    if (!existsSync(stateDir)) {
        return "none";
    }
    // Check in order of specificity
    const modeFiles = [
        { file: "autopilot-state.json", mode: "autopilot" },
        { file: "ultrawork-state.json", mode: "ultrawork" },
        { file: "ralph-state.json", mode: "ralph" },
        { file: "team-state.json", mode: "team" },
    ];
    for (const { file, mode } of modeFiles) {
        const filePath = join(stateDir, file);
        if (existsSync(filePath)) {
            {
                // JSON file check
                try {
                    const content = readFileSync(filePath, "utf-8");
                    const state = JSON.parse(content);
                    if (state.active === true ||
                        state.status === "running" ||
                        state.status === "active") {
                        return mode;
                    }
                }
                catch {
                    continue;
                }
            }
        }
    }
    return "none";
}
/**
 * Get list of stale agents (running for too long)
 */
export function getStaleAgents(state) {
    const now = Date.now();
    return state.agents.filter((agent) => {
        if (agent.status !== "running") {
            return false;
        }
        const startTime = new Date(agent.started_at).getTime();
        const elapsed = now - startTime;
        return elapsed > STALE_THRESHOLD_MS;
    });
}
// ============================================================================
// Hook Processors
// ============================================================================
/**
 * Process SubagentStart event
 */
export function processSubagentStart(input) {
    const sessionId = resolveSessionId({ context: 'hook', hookPayload: input });
    const writePath = resolveWritePath(input.cwd, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        return withFileLockSync(lockPath, () => {
            const state = readTrackingState(input.cwd, sessionId);
            const parentMode = detectParentMode(input.cwd);
            const startedAt = new Date().toISOString();
            const taskDescription = input.prompt?.substring(0, 200); // Truncate for storage
            const existingAgent = state.agents.find((agent) => agent.agent_id === input.agent_id);
            const isDuplicateRunningStart = existingAgent?.status === "running";
            let trackedAgent;
            if (existingAgent) {
                existingAgent.agent_type = input.agent_type;
                existingAgent.parent_mode = parentMode;
                existingAgent.task_description = taskDescription;
                existingAgent.model = input.model;
                if (existingAgent.status !== "running") {
                    existingAgent.status = "running";
                    existingAgent.started_at = startedAt;
                    existingAgent.completed_at = undefined;
                    existingAgent.duration_ms = undefined;
                    existingAgent.output_summary = undefined;
                    state.total_spawned++;
                }
                trackedAgent = existingAgent;
            }
            else {
                // Create new agent entry
                const agentInfo = {
                    agent_id: input.agent_id,
                    agent_type: input.agent_type,
                    started_at: startedAt,
                    parent_mode: parentMode,
                    task_description: taskDescription,
                    status: "running",
                    model: input.model,
                };
                // Add to state
                state.agents.push(agentInfo);
                state.total_spawned++;
                trackedAgent = agentInfo;
            }
            // Write updated state (debounced; outside lock scope intentionally — flush is fine)
            writeTrackingState(input.cwd, state, sessionId);
            if (!isDuplicateRunningStart) {
                // Record to session replay JSONL for /trace
                try {
                    recordAgentStart(input.cwd, input.session_id, input.agent_id, input.agent_type, input.prompt, parentMode, input.model);
                }
                catch { /* best-effort */ }
                try {
                    recordMissionAgentStart(input.cwd, {
                        sessionId: input.session_id,
                        agentId: input.agent_id,
                        agentType: input.agent_type,
                        parentMode,
                        taskDescription: input.prompt,
                        at: trackedAgent.started_at,
                    }, sessionId);
                }
                catch { /* best-effort */ }
            }
            // Check for stale agents
            const staleAgents = getStaleAgents(state);
            return {
                continue: true,
                hookSpecificOutput: {
                    hookEventName: "SubagentStart",
                    additionalContext: `Agent ${input.agent_type} started (${input.agent_id})`,
                    agent_count: state.agents.filter((a) => a.status === "running").length,
                    stale_agents: staleAgents.map((a) => a.agent_id),
                },
            };
        }, LOCK_OPTS);
    }
    catch {
        return { continue: true }; // Fail gracefully if lock cannot be acquired
    }
}
/**
 * Find a single running agent that can be safely reconciled against an
 * unmatched Stop event. The tracking state is already session-scoped, so any
 * running entry here belongs to the current session. Reconciliation is only
 * considered reliable when there is exactly one candidate (optionally narrowed
 * by agent_type metadata) — otherwise the choice would be ambiguous and could
 * close the wrong agent. Returns the index of the candidate, or -1.
 */
function findReconcilableRunningAgent(state, agentType) {
    const candidates = [];
    for (let i = 0; i < state.agents.length; i++) {
        const agent = state.agents[i];
        if (agent.status !== "running")
            continue;
        if (agentType && agent.agent_type !== agentType)
            continue;
        candidates.push(i);
    }
    return candidates.length === 1 ? candidates[0] : -1;
}
/**
 * Mark running agents that have exceeded the stale threshold as failed. Used
 * during unmatched Stop reconciliation so native fork stop events carrying an
 * unknown agent_id cannot leave running entries lingering forever. Returns the
 * number of agents reaped.
 */
function reapStaleRunningAgents(state, nowIso) {
    const now = new Date(nowIso).getTime();
    let reaped = 0;
    for (const agent of state.agents) {
        if (agent.status !== "running")
            continue;
        const startTime = new Date(agent.started_at).getTime();
        if (now - startTime > STALE_THRESHOLD_MS) {
            agent.status = "failed";
            agent.completed_at = nowIso;
            agent.duration_ms = now - startTime;
            agent.output_summary =
                "Marked as stale during unmatched stop reconciliation - exceeded timeout";
            state.total_failed++;
            reaped++;
        }
    }
    return reaped;
}
/**
 * Process SubagentStop event
 */
export function processSubagentStop(input) {
    const sessionId = resolveSessionId({ context: 'hook', hookPayload: input });
    const writePath = resolveWritePath(input.cwd, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        return withFileLockSync(lockPath, () => {
            const state = readTrackingState(input.cwd, sessionId);
            // SDK does not provide `success` field, so default to 'completed' when undefined (Bug #1 fix)
            const succeeded = input.success !== false;
            const nowIso = new Date().toISOString();
            // Find the agent by exact agent_id first.
            let agentIndex = input.agent_id
                ? state.agents.findIndex((a) => a.agent_id === input.agent_id)
                : -1;
            // Native fork stop events can arrive with an agent_id that was never
            // registered by SubagentStart (#3252). When the exact lookup misses,
            // attempt a safe fallback reconciliation against running agents in this
            // (session-scoped) state before falling back to reap + create-and-close,
            // so the running entry cannot leak as "running" forever.
            if (agentIndex === -1 && input.agent_id) {
                agentIndex = findReconcilableRunningAgent(state, input.agent_type);
            }
            if (agentIndex !== -1) {
                const agent = state.agents[agentIndex];
                agent.status = succeeded ? "completed" : "failed";
                agent.completed_at = nowIso;
                // Calculate duration
                const startTime = new Date(agent.started_at).getTime();
                agent.duration_ms = new Date(nowIso).getTime() - startTime;
                // Store output summary (truncated)
                if (input.output) {
                    agent.output_summary = input.output.substring(0, 500);
                }
                // Update counters
                if (succeeded) {
                    state.total_completed++;
                }
                else {
                    state.total_failed++;
                }
            }
            else if (input.agent_id) {
                // No exact or fallback match. Reap any stale running agents so unmatched
                // fork stops cannot accumulate "running" entries forever, then record
                // this stop as an explicitly synthetic closed entry. Avoid duration_ms: 0
                // and agent_type: "unknown" because those look like real telemetry.
                reapStaleRunningAgents(state, nowIso);
                const synthetic = {
                    agent_id: input.agent_id,
                    agent_type: input.agent_type || UNTRACKED_NATIVE_FORK_AGENT_TYPE,
                    started_at: nowIso,
                    parent_mode: detectParentMode(input.cwd),
                    status: succeeded ? "completed" : "failed",
                    completed_at: nowIso,
                    output_summary: input.output ? input.output.substring(0, 500) : undefined,
                    synthetic: true,
                    telemetry_status: "unmatched_stop",
                    telemetry_note: UNMATCHED_STOP_TELEMETRY_NOTE,
                };
                state.agents.push(synthetic);
                agentIndex = state.agents.length - 1;
                if (succeeded) {
                    state.total_completed++;
                }
                else {
                    state.total_failed++;
                }
            }
            // Capture the closed agent before eviction may reorder/remove entries.
            const stoppedAgent = agentIndex !== -1 ? state.agents[agentIndex] : undefined;
            // Evict oldest completed agents if over limit
            const completedAgents = state.agents.filter((a) => a.status === "completed" || a.status === "failed");
            if (completedAgents.length > MAX_COMPLETED_AGENTS) {
                // Sort by completed_at and keep only the most recent
                completedAgents.sort((a, b) => {
                    const timeA = a.completed_at ? new Date(a.completed_at).getTime() : 0;
                    const timeB = b.completed_at ? new Date(b.completed_at).getTime() : 0;
                    return timeB - timeA; // Newest first
                });
                const toRemove = new Set(completedAgents.slice(MAX_COMPLETED_AGENTS).map((a) => a.agent_id));
                state.agents = state.agents.filter((a) => !toRemove.has(a.agent_id));
            }
            // Write updated state
            writeTrackingState(input.cwd, state, sessionId);
            if (input.agent_id) {
                // Record to session replay JSONL for /trace
                // Fix: SDK doesn't populate agent_type in SubagentStop, so use tracked state
                try {
                    const agentType = stoppedAgent?.agent_type || input.agent_type || UNTRACKED_NATIVE_FORK_AGENT_TYPE;
                    recordAgentStop(input.cwd, input.session_id, input.agent_id, agentType, succeeded, stoppedAgent?.duration_ms, stoppedAgent?.synthetic
                        ? { synthetic: true, telemetry_status: stoppedAgent.telemetry_status, reason: stoppedAgent.telemetry_note }
                        : undefined);
                }
                catch { /* best-effort */ }
                try {
                    recordMissionAgentStop(input.cwd, {
                        sessionId: input.session_id,
                        agentId: input.agent_id,
                        success: succeeded,
                        outputSummary: stoppedAgent?.output_summary ?? input.output,
                        at: stoppedAgent?.completed_at ?? nowIso,
                    }, sessionId);
                }
                catch { /* best-effort */ }
            }
            return {
                continue: true,
                suppressOutput: true,
            };
        }, LOCK_OPTS);
    }
    catch {
        return { continue: true }; // Fail gracefully if lock cannot be acquired
    }
}
// ============================================================================
// Cleanup Functions
// ============================================================================
/**
 * Cleanup stale agents (mark as failed)
 */
export function cleanupStaleAgents(directory, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        return withFileLockSync(lockPath, () => {
            const state = readTrackingState(directory, sessionId);
            const staleAgents = getStaleAgents(state);
            if (staleAgents.length === 0) {
                return 0;
            }
            for (const stale of staleAgents) {
                const agentIndex = state.agents.findIndex((a) => a.agent_id === stale.agent_id);
                if (agentIndex !== -1) {
                    state.agents[agentIndex].status = "failed";
                    state.agents[agentIndex].completed_at = new Date().toISOString();
                    state.agents[agentIndex].output_summary =
                        "Marked as stale - exceeded timeout";
                    state.total_failed++;
                }
            }
            writeTrackingState(directory, state, sessionId);
            return staleAgents.length;
        }, LOCK_OPTS);
    }
    catch {
        return 0; // Could not acquire lock
    }
}
export function getActiveAgentSnapshot(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    return {
        count: state.agents.filter((a) => a.status === "running").length,
        lastUpdatedAt: state.last_updated,
    };
}
export function getActiveAgentCount(directory, sessionId) {
    return getActiveAgentSnapshot(directory, sessionId).count;
}
/**
 * Get agents by type
 */
export function getAgentsByType(directory, agentType, sessionId) {
    const state = readTrackingState(directory, sessionId);
    return state.agents.filter((a) => a.agent_type === agentType);
}
/**
 * Get all running agents
 */
export function getRunningAgents(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    return state.agents.filter((a) => a.status === "running");
}
/**
 * Get tracking stats
 */
export function getTrackingStats(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    return {
        running: state.agents.filter((a) => a.status === "running").length,
        completed: state.total_completed,
        failed: state.total_failed,
        total: state.total_spawned,
    };
}
/**
 * Record a tool usage event for a specific agent
 * Called from PreToolUse/PostToolUse hooks to track which agent uses which tool
 */
export function recordToolUsage(directory, agentId, toolName, success, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        withFileLockSync(lockPath, () => {
            const state = readTrackingState(directory, sessionId);
            const agent = state.agents.find((a) => a.agent_id === agentId && a.status === "running");
            if (agent) {
                if (!agent.tool_usage)
                    agent.tool_usage = [];
                // Keep last 50 tool usages per agent to prevent unbounded growth
                if (agent.tool_usage.length >= 50) {
                    agent.tool_usage = agent.tool_usage.slice(-49);
                }
                agent.tool_usage.push({
                    tool_name: toolName,
                    timestamp: new Date().toISOString(),
                    success,
                });
                writeTrackingState(directory, state, sessionId);
            }
        }, LOCK_OPTS);
    }
    catch { /* best-effort */ }
}
/**
 * Record tool usage with timing data
 * Called from PostToolUse hook with duration information
 */
export function recordToolUsageWithTiming(directory, agentId, toolName, durationMs, success, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        withFileLockSync(lockPath, () => {
            const state = readTrackingState(directory, sessionId);
            const agent = state.agents.find((a) => a.agent_id === agentId && a.status === "running");
            if (agent) {
                if (!agent.tool_usage)
                    agent.tool_usage = [];
                if (agent.tool_usage.length >= 50) {
                    agent.tool_usage = agent.tool_usage.slice(-49);
                }
                agent.tool_usage.push({
                    tool_name: toolName,
                    timestamp: new Date().toISOString(),
                    duration_ms: durationMs,
                    success,
                });
                writeTrackingState(directory, state, sessionId);
            }
        }, LOCK_OPTS);
    }
    catch { /* best-effort */ }
}
/**
 * Generate a formatted dashboard of all running agents
 * Used for debugging parallel agent execution in ultrawork mode
 */
export function getAgentDashboard(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const running = state.agents.filter((a) => a.status === "running");
    if (running.length === 0)
        return "";
    const now = Date.now();
    const lines = [`Agent Dashboard (${running.length} active):`];
    for (const agent of running) {
        const elapsed = Math.round((now - new Date(agent.started_at).getTime()) / 1000);
        const shortType = agent.agent_type.replace("oh-my-claudecode:", "");
        const toolCount = agent.tool_usage?.length || 0;
        const lastTool = agent.tool_usage?.[agent.tool_usage.length - 1]?.tool_name || "-";
        const desc = agent.task_description
            ? ` "${agent.task_description.substring(0, 60)}"`
            : "";
        lines.push(`  [${agent.agent_id.substring(0, 7)}] ${shortType} (${elapsed}s) tools:${toolCount} last:${lastTool}${desc}`);
    }
    const stale = getStaleAgents(state);
    if (stale.length > 0) {
        lines.push(`  ⚠ ${stale.length} stale agent(s) detected`);
    }
    return lines.join("\n");
}
/**
 * Generate a rich observatory view of all running agents
 * Includes: performance metrics, token usage, file ownership, bottlenecks
 * For HUD integration and debugging parallel agent execution
 */
export function getAgentObservatory(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const running = state.agents.filter((a) => a.status === "running");
    const efficiency = calculateParallelEfficiency(directory, sessionId);
    const interventions = suggestInterventions(directory, sessionId);
    const now = Date.now();
    const lines = [];
    let totalCost = 0;
    for (const agent of running) {
        const elapsed = Math.round((now - new Date(agent.started_at).getTime()) / 1000);
        const shortType = agent.agent_type.replace("oh-my-claudecode:", "");
        const toolCount = agent.tool_usage?.length || 0;
        // Token and cost info
        const cost = agent.token_usage?.cost_usd || 0;
        totalCost += cost;
        const tokens = agent.token_usage
            ? `${Math.round((agent.token_usage.input_tokens + agent.token_usage.output_tokens) / 1000)}k`
            : "-";
        // Status indicator
        const stale = getStaleAgents(state).some((s) => s.agent_id === agent.agent_id);
        const hasIntervention = interventions.some((i) => i.agent_id === agent.agent_id);
        const status = stale ? "🔴" : hasIntervention ? "🟡" : "🟢";
        // Bottleneck detection
        const perf = getAgentPerformance(directory, agent.agent_id, sessionId);
        const bottleneck = perf?.bottleneck || "";
        // File ownership
        const files = agent.file_ownership?.length || 0;
        // Build line
        let line = `${status} [${agent.agent_id.substring(0, 7)}] ${shortType} ${elapsed}s`;
        line += ` tools:${toolCount} tokens:${tokens}`;
        if (cost > 0)
            line += ` $${cost.toFixed(2)}`;
        if (files > 0)
            line += ` files:${files}`;
        if (bottleneck)
            line += `\n   └─ bottleneck: ${bottleneck}`;
        lines.push(line);
    }
    // Add intervention warnings at the end
    for (const intervention of interventions.slice(0, 3)) {
        const shortType = intervention.agent_type.replace("oh-my-claudecode:", "");
        lines.push(`⚠ ${shortType}: ${intervention.reason}`);
    }
    const header = `Agent Observatory (${running.length} active, ${efficiency.score}% efficiency)`;
    return {
        header,
        lines,
        summary: {
            total_agents: running.length,
            total_cost_usd: totalCost,
            efficiency: efficiency.score,
            interventions: interventions.length,
        },
    };
}
// ============================================================================
// Intervention Functions
// ============================================================================
/**
 * Suggest interventions for problematic agents
 * Checks for: stale agents, cost limit exceeded, file conflicts
 */
export function suggestInterventions(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const interventions = [];
    const running = state.agents.filter((a) => a.status === "running");
    // 1. Stale agent detection
    const stale = getStaleAgents(state);
    for (const agent of stale) {
        const elapsed = Math.round((Date.now() - new Date(agent.started_at).getTime()) / 1000 / 60);
        interventions.push({
            type: "timeout",
            agent_id: agent.agent_id,
            agent_type: agent.agent_type,
            reason: `Agent running for ${elapsed}m (threshold: 5m)`,
            suggested_action: "kill",
            auto_execute: elapsed > 10, // Auto-kill after 10 minutes
        });
    }
    // 2. Cost limit detection
    for (const agent of running) {
        if (agent.token_usage && agent.token_usage.cost_usd > COST_LIMIT_USD) {
            interventions.push({
                type: "excessive_cost",
                agent_id: agent.agent_id,
                agent_type: agent.agent_type,
                reason: `Cost $${agent.token_usage.cost_usd.toFixed(2)} exceeds limit $${COST_LIMIT_USD.toFixed(2)}`,
                suggested_action: "warn",
                auto_execute: false,
            });
        }
    }
    // 3. File conflict detection
    const fileToAgents = new Map();
    for (const agent of running) {
        for (const file of agent.file_ownership || []) {
            if (!fileToAgents.has(file)) {
                fileToAgents.set(file, []);
            }
            fileToAgents
                .get(file)
                .push({ id: agent.agent_id, type: agent.agent_type });
        }
    }
    for (const [file, agents] of fileToAgents) {
        if (agents.length > 1) {
            // Warn all but first agent (first one "owns" the file)
            for (let i = 1; i < agents.length; i++) {
                interventions.push({
                    type: "file_conflict",
                    agent_id: agents[i].id,
                    agent_type: agents[i].type,
                    reason: `File conflict on ${file} with ${agents[0].type.replace("oh-my-claudecode:", "")}`,
                    suggested_action: "warn",
                    auto_execute: false,
                });
            }
        }
    }
    return interventions;
}
/**
 * Calculate parallel efficiency score (0-100)
 * 100 = all agents actively running, 0 = all stale/waiting
 */
export function calculateParallelEfficiency(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const running = state.agents.filter((a) => a.status === "running");
    const stale = getStaleAgents(state);
    if (running.length === 0)
        return { score: 100, active: 0, stale: 0, total: 0 };
    const active = running.length - stale.length;
    const score = Math.round((active / running.length) * 100);
    return { score, active, stale: stale.length, total: running.length };
}
// ============================================================================
// File Ownership Functions
// ============================================================================
/**
 * Record file ownership when an agent modifies a file
 * Called from PreToolUse hook when Edit/Write tools are used
 */
export function recordFileOwnership(directory, agentId, filePath, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        withFileLockSync(lockPath, () => {
            const state = readTrackingState(directory, sessionId);
            const agent = state.agents.find((a) => a.agent_id === agentId && a.status === "running");
            if (agent) {
                if (!agent.file_ownership)
                    agent.file_ownership = [];
                // Normalize and deduplicate
                const normalized = filePath.replace(directory, "").replace(/^\//, "").replace(/^\\/, "");
                if (!agent.file_ownership.includes(normalized)) {
                    agent.file_ownership.push(normalized);
                    // Cap at 100 files per agent
                    if (agent.file_ownership.length > 100) {
                        agent.file_ownership = agent.file_ownership.slice(-100);
                    }
                    writeTrackingState(directory, state, sessionId);
                }
            }
        }, LOCK_OPTS);
    }
    catch { /* best-effort */ }
}
/**
 * Check for file conflicts between running agents
 * Returns files being modified by more than one agent
 */
export function detectFileConflicts(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const running = state.agents.filter((a) => a.status === "running");
    const fileToAgents = new Map();
    for (const agent of running) {
        for (const file of agent.file_ownership || []) {
            if (!fileToAgents.has(file)) {
                fileToAgents.set(file, []);
            }
            fileToAgents
                .get(file)
                .push(agent.agent_type.replace("oh-my-claudecode:", ""));
        }
    }
    const conflicts = [];
    for (const [file, agents] of fileToAgents) {
        if (agents.length > 1) {
            conflicts.push({ file, agents });
        }
    }
    return conflicts;
}
/**
 * Get all file ownership for running agents
 */
export function getFileOwnershipMap(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const running = state.agents.filter((a) => a.status === "running");
    const map = new Map();
    for (const agent of running) {
        const shortType = agent.agent_type.replace("oh-my-claudecode:", "");
        for (const file of agent.file_ownership || []) {
            map.set(file, shortType);
        }
    }
    return map;
}
// ============================================================================
// Performance Query Functions
// ============================================================================
/**
 * Get performance metrics for a specific agent
 */
export function getAgentPerformance(directory, agentId, sessionId) {
    const state = readTrackingState(directory, sessionId);
    const agent = state.agents.find((a) => a.agent_id === agentId);
    if (!agent)
        return null;
    const toolTimings = {};
    for (const entry of agent.tool_usage || []) {
        if (!toolTimings[entry.tool_name]) {
            toolTimings[entry.tool_name] = {
                count: 0,
                avg_ms: 0,
                max_ms: 0,
                total_ms: 0,
                failures: 0,
            };
        }
        const stats = toolTimings[entry.tool_name];
        stats.count++;
        if (entry.duration_ms !== undefined) {
            stats.total_ms += entry.duration_ms;
            stats.max_ms = Math.max(stats.max_ms, entry.duration_ms);
            stats.avg_ms = Math.round(stats.total_ms / stats.count);
        }
        if (entry.success === false)
            stats.failures++;
    }
    // Find bottleneck (tool with highest avg_ms that has been called 2+ times)
    let bottleneck;
    let maxAvg = 0;
    for (const [tool, stats] of Object.entries(toolTimings)) {
        if (stats.count >= 2 && stats.avg_ms > maxAvg) {
            maxAvg = stats.avg_ms;
            bottleneck = `${tool} (${(stats.avg_ms / 1000).toFixed(1)}s avg)`;
        }
    }
    return {
        agent_id: agentId,
        tool_timings: toolTimings,
        token_usage: agent.token_usage || {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cost_usd: 0,
        },
        bottleneck,
    };
}
/**
 * Get performance for all running agents
 */
export function getAllAgentPerformance(directory, sessionId) {
    const state = readTrackingState(directory, sessionId);
    return state.agents
        .filter((a) => a.status === "running")
        .map((a) => getAgentPerformance(directory, a.agent_id, sessionId))
        .filter((p) => p !== null);
}
/**
 * Update token usage for an agent (called from SubagentStop)
 */
export function updateTokenUsage(directory, agentId, tokens, sessionId) {
    const writePath = resolveWritePath(directory, sessionId);
    ensureParentDir(writePath);
    const lockPath = lockPathFor(writePath);
    try {
        withFileLockSync(lockPath, () => {
            const state = readTrackingState(directory, sessionId);
            const agent = state.agents.find((a) => a.agent_id === agentId);
            if (agent) {
                if (!agent.token_usage) {
                    agent.token_usage = {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cost_usd: 0,
                    };
                }
                if (tokens.input_tokens !== undefined)
                    agent.token_usage.input_tokens += tokens.input_tokens;
                if (tokens.output_tokens !== undefined)
                    agent.token_usage.output_tokens += tokens.output_tokens;
                if (tokens.cache_read_tokens !== undefined)
                    agent.token_usage.cache_read_tokens += tokens.cache_read_tokens;
                if (tokens.cost_usd !== undefined)
                    agent.token_usage.cost_usd += tokens.cost_usd;
                writeTrackingState(directory, state, sessionId);
            }
        }, LOCK_OPTS);
    }
    catch { /* best-effort */ }
}
// ============================================================================
// Main Entry Points
// ============================================================================
/**
 * Handle SubagentStart hook
 */
export async function handleSubagentStart(input) {
    return processSubagentStart(input);
}
/**
 * Handle SubagentStop hook
 */
export async function handleSubagentStop(input) {
    return processSubagentStop(input);
}
/**
 * Clear all tracking state (for testing or cleanup)
 */
export function clearTrackingState(directory, sessionId) {
    const statePath = resolveWritePath(directory, sessionId);
    if (existsSync(statePath)) {
        try {
            unlinkSync(statePath);
        }
        catch (error) {
            console.error("[SubagentTracker] Error clearing state:", error);
        }
    }
}
//# sourceMappingURL=index.js.map