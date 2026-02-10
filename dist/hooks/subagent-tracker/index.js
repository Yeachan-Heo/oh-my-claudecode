/**
 * Subagent Tracker Hook Module
 *
 * Tracks SubagentStart and SubagentStop events for comprehensive agent monitoring.
 * Features:
 * - Track all spawned agents with parent mode context
 * - Detect stuck/stale agents (>5 min without progress)
 * - HUD integration for agent status display
 * - Automatic cleanup of orphaned agent state
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, } from "fs";
import { join } from "path";
import { recordAgentStart, recordAgentStop } from './session-replay.js';
export const COST_LIMIT_USD = 1.0;
export const DEADLOCK_CHECK_THRESHOLD = 3;
// ============================================================================
// Constants
// ============================================================================
const STATE_FILE = "subagent-tracking.json";
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_COMPLETED_AGENTS = 100;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const WRITE_DEBOUNCE_MS = 100;
const MAX_FLUSH_RETRIES = 3;
const FLUSH_RETRY_BASE_MS = 50;
// Per-directory debounce state for batching writes (avoids race conditions)
const pendingWrites = new Map();
// Guard against duplicate concurrent flushes per directory
const flushInProgress = new Set();
/**
 * Check if a process is still alive
 * Signal 0 doesn't kill the process, just checks if it exists
 */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Synchronous sleep using Atomics.wait
 * Avoids CPU-spinning busy-wait loops
 */
function syncSleep(ms) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
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
 * Acquire file lock with timeout and stale lock detection
 */
function acquireLock(directory) {
    const lockPath = join(directory, ".omc", "state", "subagent-tracker.lock");
    const lockDir = join(directory, ".omc", "state");
    if (!existsSync(lockDir)) {
        mkdirSync(lockDir, { recursive: true });
    }
    const startTime = Date.now();
    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
        try {
            // Check for stale lock (older than timeout or dead process)
            if (existsSync(lockPath)) {
                const lockContent = readFileSync(lockPath, "utf-8");
                const lockParts = lockContent.split(":");
                if (lockParts.length < 2) {
                    // Malformed lock content, treat as corrupted: best-effort remove and backoff
                    try {
                        unlinkSync(lockPath);
                    }
                    catch {
                        /* ignore */
                    }
                    syncSleep(LOCK_RETRY_MS);
                    continue;
                }
                const [lockPidStr, lockTimeStr] = lockParts;
                const lockPid = parseInt(lockPidStr, 10);
                const lockTime = parseInt(lockTimeStr, 10);
                // Non-integer PID or timestamp indicates corrupted lock; remove and retry with backoff
                if (isNaN(lockPid) || isNaN(lockTime)) {
                    try {
                        unlinkSync(lockPath);
                    }
                    catch {
                        /* ignore */
                    }
                    syncSleep(LOCK_RETRY_MS);
                    continue;
                }
                const isStale = Date.now() - lockTime > LOCK_TIMEOUT_MS;
                const isDeadProcess = !isNaN(lockPid) && !isProcessAlive(lockPid);
                if (isStale || isDeadProcess) {
                    // Stale lock or dead process, remove it
                    try {
                        unlinkSync(lockPath);
                    }
                    catch {
                        /* ignore stale lock removal errors */
                    }
                }
                else {
                    // Lock is held by a live process, wait and retry
                    syncSleep(LOCK_RETRY_MS);
                    continue;
                }
            }
            // Try to create lock atomically with PID:timestamp
            writeFileSync(lockPath, `${process.pid}:${Date.now()}`, { flag: "wx" });
            return true;
        }
        catch (e) {
            if (e.code === "EEXIST") {
                // Lock exists, retry
                syncSleep(LOCK_RETRY_MS);
                continue;
            }
            return false;
        }
    }
    return false; // Timeout
}
/**
 * Release file lock
 */
function releaseLock(directory) {
    const lockPath = join(directory, ".omc", "state", "subagent-tracker.lock");
    try {
        unlinkSync(lockPath);
    }
    catch {
        // Ignore errors
    }
}
/**
 * Get the state file path
 */
export function getStateFilePath(directory) {
    const stateDir = join(directory, ".omc", "state");
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
    return join(stateDir, STATE_FILE);
}
/**
 * Read tracking state directly from disk, bypassing the pending writes cache.
 * Used during flush to get the latest on-disk state for merging.
 */
export function readDiskState(directory) {
    const statePath = getStateFilePath(directory);
    if (!existsSync(statePath)) {
        return {
            agents: [],
            total_spawned: 0,
            total_completed: 0,
            total_failed: 0,
            last_updated: new Date().toISOString(),
        };
    }
    try {
        const content = readFileSync(statePath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        console.error("[SubagentTracker] Error reading disk state:", error);
        return {
            agents: [],
            total_spawned: 0,
            total_completed: 0,
            total_failed: 0,
            last_updated: new Date().toISOString(),
        };
    }
}
/**
 * Read tracking state from file.
 * If there's a pending write for this directory, returns it instead of reading disk.
 */
export function readTrackingState(directory) {
    const pending = pendingWrites.get(directory);
    if (pending) {
        return pending.state;
    }
    return readDiskState(directory);
}
/**
 * Write tracking state to file immediately (bypasses debounce).
 */
function writeTrackingStateImmediate(directory, state) {
    const statePath = getStateFilePath(directory);
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
 * Returns true on success, false if lock could not be acquired.
 */
export function executeFlush(directory, pendingState) {
    if (!acquireLock(directory)) {
        return false;
    }
    try {
        // Re-read latest disk state to avoid overwriting concurrent changes
        const diskState = readDiskState(directory);
        const merged = mergeTrackerStates(diskState, pendingState);
        writeTrackingStateImmediate(directory, merged);
        return true;
    }
    finally {
        releaseLock(directory);
    }
}
/**
 * Write tracking state with debouncing to reduce I/O.
 * The flush callback acquires the lock, re-reads disk state, merges with
 * the pending in-memory delta, and writes atomically.
 * If the lock cannot be acquired, retries with exponential backoff (max 3 retries).
 */
export function writeTrackingState(directory, state) {
    const existing = pendingWrites.get(directory);
    if (existing) {
        clearTimeout(existing.timeout);
    }
    const timeout = setTimeout(() => {
        const pending = pendingWrites.get(directory);
        if (!pending)
            return;
        pendingWrites.delete(directory);
        // Guard against duplicate concurrent flushes for the same directory
        if (flushInProgress.has(directory)) {
            // Re-queue: put it back and let the next debounce cycle handle it
            pendingWrites.set(directory, {
                state: pending.state,
                timeout: setTimeout(() => {
                    writeTrackingState(directory, pending.state);
                }, WRITE_DEBOUNCE_MS),
            });
            return;
        }
        flushInProgress.add(directory);
        try {
            // Try flush with bounded retries on lock failure
            let success = false;
            for (let attempt = 0; attempt < MAX_FLUSH_RETRIES; attempt++) {
                success = executeFlush(directory, pending.state);
                if (success)
                    break;
                // Exponential backoff before retry
                syncSleep(FLUSH_RETRY_BASE_MS * Math.pow(2, attempt));
            }
            if (!success) {
                console.error(`[SubagentTracker] Failed to flush after ${MAX_FLUSH_RETRIES} retries for ${directory}. Data retained in memory for next attempt.`);
                // Put data back in pending so the next writeTrackingState call will retry
                pendingWrites.set(directory, {
                    state: pending.state,
                    timeout: setTimeout(() => {
                        // No-op: data is just stored, will be picked up by next write or flushPendingWrites
                    }, 0),
                });
            }
        }
        finally {
            flushInProgress.delete(directory);
        }
    }, WRITE_DEBOUNCE_MS);
    pendingWrites.set(directory, { state, timeout });
}
/**
 * Flush any pending debounced writes immediately using the merge-aware path.
 * Call this in tests before cleanup to ensure state is persisted.
 */
export function flushPendingWrites() {
    for (const [directory, pending] of pendingWrites) {
        clearTimeout(pending.timeout);
        // Use executeFlush for merge-aware writes; fall back to direct write
        // only if lock acquisition fails (test environments with no contention)
        if (!executeFlush(directory, pending.state)) {
            writeTrackingStateImmediate(directory, pending.state);
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
    const stateDir = join(directory, ".omc", "state");
    if (!existsSync(stateDir)) {
        return "none";
    }
    // Check in order of specificity
    const modeFiles = [
        { file: "ultrapilot-state.json", mode: "ultrapilot" },
        { file: "autopilot-state.json", mode: "autopilot" },
        { file: "swarm.db", mode: "swarm" },
        { file: "ultrawork-state.json", mode: "ultrawork" },
        { file: "ralph-state.json", mode: "ralph" },
    ];
    for (const { file, mode } of modeFiles) {
        const filePath = join(stateDir, file);
        if (existsSync(filePath)) {
            // Special case for swarm.db - just check existence and size
            if (file === 'swarm.db') {
                try {
                    const stats = statSync(filePath);
                    if (stats.size > 0) {
                        return mode;
                    }
                }
                catch {
                    continue;
                }
            }
            else {
                // JSON file check (existing logic)
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
    if (!acquireLock(input.cwd)) {
        return { continue: true }; // Fail gracefully
    }
    try {
        const state = readTrackingState(input.cwd);
        const parentMode = detectParentMode(input.cwd);
        // Create new agent entry
        const agentInfo = {
            agent_id: input.agent_id,
            agent_type: input.agent_type,
            started_at: new Date().toISOString(),
            parent_mode: parentMode,
            task_description: input.prompt?.substring(0, 200), // Truncate for storage
            status: "running",
            model: input.model,
        };
        // Add to state
        state.agents.push(agentInfo);
        state.total_spawned++;
        // Write updated state
        writeTrackingState(input.cwd, state);
        // Record to session replay JSONL for /trace
        try {
            recordAgentStart(input.cwd, input.session_id, input.agent_id, input.agent_type, input.prompt, parentMode, input.model);
        }
        catch { /* best-effort */ }
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
    }
    finally {
        releaseLock(input.cwd);
    }
}
/**
 * Process SubagentStop event
 */
export function processSubagentStop(input) {
    if (!acquireLock(input.cwd)) {
        return { continue: true }; // Fail gracefully
    }
    try {
        const state = readTrackingState(input.cwd);
        // Find the agent
        const agentIndex = state.agents.findIndex((a) => a.agent_id === input.agent_id);
        // SDK does not provide `success` field, so default to 'completed' when undefined (Bug #1 fix)
        const succeeded = input.success !== false;
        if (agentIndex !== -1) {
            const agent = state.agents[agentIndex];
            agent.status = succeeded ? "completed" : "failed";
            agent.completed_at = new Date().toISOString();
            // Calculate duration
            const startTime = new Date(agent.started_at).getTime();
            const endTime = new Date(agent.completed_at).getTime();
            agent.duration_ms = endTime - startTime;
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
        writeTrackingState(input.cwd, state);
        // Record to session replay JSONL for /trace
        // Fix: SDK doesn't populate agent_type in SubagentStop, so use tracked state
        try {
            const trackedAgent = agentIndex !== -1 ? state.agents[agentIndex] : undefined;
            const agentType = trackedAgent?.agent_type || input.agent_type || 'unknown';
            recordAgentStop(input.cwd, input.session_id, input.agent_id, agentType, succeeded, trackedAgent?.duration_ms);
        }
        catch { /* best-effort */ }
        const runningCount = state.agents.filter((a) => a.status === "running").length;
        return {
            continue: true,
            hookSpecificOutput: {
                hookEventName: "SubagentStop",
                additionalContext: `Agent ${input.agent_type} ${succeeded ? "completed" : "failed"} (${input.agent_id})`,
                agent_count: runningCount,
            },
        };
    }
    finally {
        releaseLock(input.cwd);
    }
}
// ============================================================================
// Cleanup Functions
// ============================================================================
/**
 * Cleanup stale agents (mark as failed)
 */
export function cleanupStaleAgents(directory) {
    if (!acquireLock(directory)) {
        return 0; // Could not acquire lock
    }
    try {
        const state = readTrackingState(directory);
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
        writeTrackingState(directory, state);
        return staleAgents.length;
    }
    finally {
        releaseLock(directory);
    }
}
// ============================================================================
// Query Functions
// ============================================================================
/**
 * Get count of active (running) agents
 */
export function getActiveAgentCount(directory) {
    const state = readTrackingState(directory);
    return state.agents.filter((a) => a.status === "running").length;
}
/**
 * Get agents by type
 */
export function getAgentsByType(directory, agentType) {
    const state = readTrackingState(directory);
    return state.agents.filter((a) => a.agent_type === agentType);
}
/**
 * Get all running agents
 */
export function getRunningAgents(directory) {
    const state = readTrackingState(directory);
    return state.agents.filter((a) => a.status === "running");
}
/**
 * Get tracking stats
 */
export function getTrackingStats(directory) {
    const state = readTrackingState(directory);
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
export function recordToolUsage(directory, agentId, toolName, success) {
    if (!acquireLock(directory))
        return;
    try {
        const state = readTrackingState(directory);
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
            writeTrackingState(directory, state);
        }
    }
    finally {
        releaseLock(directory);
    }
}
/**
 * Record tool usage with timing data
 * Called from PostToolUse hook with duration information
 */
export function recordToolUsageWithTiming(directory, agentId, toolName, durationMs, success) {
    if (!acquireLock(directory))
        return;
    try {
        const state = readTrackingState(directory);
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
            writeTrackingState(directory, state);
        }
    }
    finally {
        releaseLock(directory);
    }
}
/**
 * Generate a formatted dashboard of all running agents
 * Used for debugging parallel agent execution in ultrawork mode
 */
export function getAgentDashboard(directory) {
    const state = readTrackingState(directory);
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
export function getAgentObservatory(directory) {
    const state = readTrackingState(directory);
    const running = state.agents.filter((a) => a.status === "running");
    const efficiency = calculateParallelEfficiency(directory);
    const interventions = suggestInterventions(directory);
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
        const perf = getAgentPerformance(directory, agent.agent_id);
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
export function suggestInterventions(directory) {
    const state = readTrackingState(directory);
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
export function calculateParallelEfficiency(directory) {
    const state = readTrackingState(directory);
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
export function recordFileOwnership(directory, agentId, filePath) {
    if (!acquireLock(directory))
        return;
    try {
        const state = readTrackingState(directory);
        const agent = state.agents.find((a) => a.agent_id === agentId && a.status === "running");
        if (agent) {
            if (!agent.file_ownership)
                agent.file_ownership = [];
            // Normalize and deduplicate
            const normalized = filePath.replace(directory, "").replace(/^\//, "");
            if (!agent.file_ownership.includes(normalized)) {
                agent.file_ownership.push(normalized);
                // Cap at 100 files per agent
                if (agent.file_ownership.length > 100) {
                    agent.file_ownership = agent.file_ownership.slice(-100);
                }
                writeTrackingState(directory, state);
            }
        }
    }
    finally {
        releaseLock(directory);
    }
}
/**
 * Check for file conflicts between running agents
 * Returns files being modified by more than one agent
 */
export function detectFileConflicts(directory) {
    const state = readTrackingState(directory);
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
export function getFileOwnershipMap(directory) {
    const state = readTrackingState(directory);
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
export function getAgentPerformance(directory, agentId) {
    const state = readTrackingState(directory);
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
export function getAllAgentPerformance(directory) {
    const state = readTrackingState(directory);
    return state.agents
        .filter((a) => a.status === "running")
        .map((a) => getAgentPerformance(directory, a.agent_id))
        .filter((p) => p !== null);
}
/**
 * Update token usage for an agent (called from SubagentStop)
 */
export function updateTokenUsage(directory, agentId, tokens) {
    if (!acquireLock(directory))
        return;
    try {
        const state = readTrackingState(directory);
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
            if (tokens.input_tokens)
                agent.token_usage.input_tokens += tokens.input_tokens;
            if (tokens.output_tokens)
                agent.token_usage.output_tokens += tokens.output_tokens;
            if (tokens.cache_read_tokens)
                agent.token_usage.cache_read_tokens += tokens.cache_read_tokens;
            if (tokens.cost_usd)
                agent.token_usage.cost_usd += tokens.cost_usd;
            writeTrackingState(directory, state);
        }
    }
    finally {
        releaseLock(directory);
    }
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
export function clearTrackingState(directory) {
    const statePath = getStateFilePath(directory);
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