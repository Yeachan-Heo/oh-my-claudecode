/**
 * Session Replay Module
 *
 * Records agent lifecycle events as JSONL for timeline visualization
 * and post-session bottleneck analysis.
 *
 * Events are appended to: .omc/state/agent-replay-{sessionId}.jsonl
 */
import { existsSync, appendFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
// ============================================================================
// Constants
// ============================================================================
const REPLAY_PREFIX = 'agent-replay-';
const MAX_REPLAY_FILES = 10;
const MAX_REPLAY_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per session
// Session start time cache (per session)
const sessionStartTimes = new Map();
// ============================================================================
// Core Functions
// ============================================================================
/**
 * Get the replay file path for a session
 */
export function getReplayFilePath(directory, sessionId) {
    const stateDir = join(getOmcRoot(directory), 'state');
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
    // Sanitize sessionId to prevent path traversal
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(stateDir, `${REPLAY_PREFIX}${safeId}.jsonl`);
}
/**
 * Get or initialize the session start time
 */
function getSessionStartTime(sessionId) {
    if (!sessionStartTimes.has(sessionId)) {
        sessionStartTimes.set(sessionId, Date.now());
    }
    return sessionStartTimes.get(sessionId);
}
/**
 * Calculate elapsed time in seconds since session start
 */
function getElapsedSeconds(sessionId) {
    const start = getSessionStartTime(sessionId);
    return Math.round((Date.now() - start) / 100) / 10; // 0.1s precision
}
/**
 * Append a replay event to the JSONL file
 */
export function appendReplayEvent(directory, sessionId, event) {
    try {
        const filePath = getReplayFilePath(directory, sessionId);
        // Check file size limit
        if (existsSync(filePath)) {
            try {
                const stats = statSync(filePath);
                if (stats.size > MAX_REPLAY_SIZE_BYTES)
                    return;
            }
            catch { /* continue */ }
        }
        const replayEvent = {
            t: getElapsedSeconds(sessionId),
            ...event,
        };
        appendFileSync(filePath, JSON.stringify(replayEvent) + '\n', 'utf-8');
    }
    catch {
        // Never fail the hook on replay errors
    }
}
// ============================================================================
// Event Helpers
// ============================================================================
/**
 * Record agent start event
 */
export function recordAgentStart(directory, sessionId, agentId, agentType, task, parentMode, model) {
    appendReplayEvent(directory, sessionId, {
        agent: agentId.substring(0, 7),
        agent_type: agentType.replace('oh-my-claudecode:', ''),
        event: 'agent_start',
        task: task?.substring(0, 100),
        parent_mode: parentMode,
        model,
    });
}
/**
 * Record agent stop event
 */
export function recordAgentStop(directory, sessionId, agentId, agentType, success, durationMs) {
    appendReplayEvent(directory, sessionId, {
        agent: agentId.substring(0, 7),
        agent_type: agentType.replace('oh-my-claudecode:', ''),
        event: 'agent_stop',
        success,
        duration_ms: durationMs,
    });
}
/**
 * Record tool execution event
 */
export function recordToolEvent(directory, sessionId, agentId, toolName, eventType, durationMs, success) {
    appendReplayEvent(directory, sessionId, {
        agent: agentId.substring(0, 7),
        event: eventType,
        tool: toolName,
        duration_ms: durationMs,
        success,
    });
}
/**
 * Record file touch event
 */
export function recordFileTouch(directory, sessionId, agentId, filePath) {
    appendReplayEvent(directory, sessionId, {
        agent: agentId.substring(0, 7),
        event: 'file_touch',
        file: filePath.substring(0, 200),
    });
}
/**
 * Record intervention event
 */
export function recordIntervention(directory, sessionId, agentId, reason) {
    appendReplayEvent(directory, sessionId, {
        agent: agentId.substring(0, 7),
        event: 'intervention',
        reason,
    });
}
// ============================================================================
// Analysis Functions
// ============================================================================
/**
 * Read all events from a replay file
 */
export function readReplayEvents(directory, sessionId) {
    const filePath = getReplayFilePath(directory, sessionId);
    if (!existsSync(filePath))
        return [];
    try {
        const content = readFileSync(filePath, 'utf-8');
        return content
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((e) => e !== null);
    }
    catch {
        return [];
    }
}
/**
 * Detect repeating cycles in an agent type sequence.
 * E.g., [planner, critic, planner, critic] → 2 cycles of "planner/critic"
 * Tries pattern lengths from 2 up to half the sequence length.
 */
export function detectCycles(sequence) {
    if (sequence.length < 2)
        return { cycles: 0, pattern: '' };
    // Try pattern lengths from 2 to half the sequence
    for (let patLen = 2; patLen <= Math.floor(sequence.length / 2); patLen++) {
        const candidate = sequence.slice(0, patLen);
        let fullCycles = 0;
        for (let i = 0; i + patLen <= sequence.length; i += patLen) {
            const chunk = sequence.slice(i, i + patLen);
            if (chunk.every((v, idx) => v === candidate[idx])) {
                fullCycles++;
            }
            else {
                break;
            }
        }
        if (fullCycles >= 2) {
            return {
                cycles: fullCycles,
                pattern: candidate.join('/'),
            };
        }
    }
    return { cycles: 0, pattern: '' };
}
/**
 * Generate a summary of a replay session for bottleneck analysis
 */
export function getReplaySummary(directory, sessionId) {
    const events = readReplayEvents(directory, sessionId);
    const summary = {
        session_id: sessionId,
        duration_seconds: 0,
        total_events: events.length,
        agents_spawned: 0,
        agents_completed: 0,
        agents_failed: 0,
        tool_summary: {},
        bottlenecks: [],
        timeline_range: { start: 0, end: 0 },
        files_touched: [],
    };
    if (events.length === 0)
        return summary;
    summary.timeline_range.start = events[0].t;
    summary.timeline_range.end = events[events.length - 1].t;
    summary.duration_seconds = summary.timeline_range.end - summary.timeline_range.start;
    const filesSet = new Set();
    const agentToolTimings = new Map();
    // Track agent types for breakdown and cycle detection
    const agentTypeStats = new Map();
    const agentTypeSequence = [];
    for (const event of events) {
        switch (event.event) {
            case 'agent_start':
                summary.agents_spawned++;
                if (event.agent_type) {
                    const type = event.agent_type;
                    if (!agentTypeStats.has(type)) {
                        agentTypeStats.set(type, { count: 0, total_ms: 0, models: new Set() });
                    }
                    agentTypeStats.get(type).count++;
                    if (event.model)
                        agentTypeStats.get(type).models.add(event.model);
                    agentTypeSequence.push(type);
                }
                break;
            case 'agent_stop':
                if (event.success)
                    summary.agents_completed++;
                else
                    summary.agents_failed++;
                if (event.agent_type && event.duration_ms) {
                    const stats = agentTypeStats.get(event.agent_type);
                    if (stats)
                        stats.total_ms += event.duration_ms;
                }
                break;
            case 'tool_end':
                if (event.tool) {
                    if (!summary.tool_summary[event.tool]) {
                        summary.tool_summary[event.tool] = { count: 0, total_ms: 0, avg_ms: 0, max_ms: 0 };
                    }
                    const ts = summary.tool_summary[event.tool];
                    ts.count++;
                    if (event.duration_ms) {
                        ts.total_ms += event.duration_ms;
                        ts.max_ms = Math.max(ts.max_ms, event.duration_ms);
                        ts.avg_ms = Math.round(ts.total_ms / ts.count);
                    }
                    // Track per-agent tool timings for bottleneck analysis
                    if (event.agent && event.duration_ms) {
                        if (!agentToolTimings.has(event.agent)) {
                            agentToolTimings.set(event.agent, new Map());
                        }
                        const agentTools = agentToolTimings.get(event.agent);
                        if (!agentTools.has(event.tool)) {
                            agentTools.set(event.tool, []);
                        }
                        agentTools.get(event.tool).push(event.duration_ms);
                    }
                }
                break;
            case 'file_touch':
                if (event.file)
                    filesSet.add(event.file);
                break;
            case 'hook_fire':
                if (!summary.hooks_fired)
                    summary.hooks_fired = 0;
                summary.hooks_fired++;
                break;
            case 'keyword_detected':
                if (!summary.keywords_detected)
                    summary.keywords_detected = [];
                if (event.keyword && !summary.keywords_detected.includes(event.keyword)) {
                    summary.keywords_detected.push(event.keyword);
                }
                break;
            case 'skill_activated':
                if (!summary.skills_activated)
                    summary.skills_activated = [];
                if (event.skill_name && !summary.skills_activated.includes(event.skill_name)) {
                    summary.skills_activated.push(event.skill_name);
                }
                break;
            case 'skill_invoked':
                if (!summary.skills_invoked)
                    summary.skills_invoked = [];
                if (event.skill_name && !summary.skills_invoked.includes(event.skill_name)) {
                    summary.skills_invoked.push(event.skill_name);
                }
                break;
            case 'mode_change':
                if (!summary.mode_transitions)
                    summary.mode_transitions = [];
                if (event.mode_from !== undefined && event.mode_to !== undefined) {
                    summary.mode_transitions.push({ from: event.mode_from, to: event.mode_to, at: event.t });
                }
                break;
        }
    }
    summary.files_touched = Array.from(filesSet);
    // Build agent breakdown
    if (agentTypeStats.size > 0) {
        summary.agent_breakdown = [];
        for (const [type, stats] of agentTypeStats) {
            summary.agent_breakdown.push({
                type,
                count: stats.count,
                total_ms: stats.total_ms,
                avg_ms: stats.count > 0 ? Math.round(stats.total_ms / stats.count) : 0,
                models: Array.from(stats.models),
            });
        }
        // Sort by count descending
        summary.agent_breakdown.sort((a, b) => b.count - a.count);
    }
    // Detect cycles: alternating agent type patterns (e.g., planner→critic→planner→critic = 2 cycles)
    if (agentTypeSequence.length >= 2) {
        const { cycles, pattern } = detectCycles(agentTypeSequence);
        if (cycles > 0) {
            summary.cycle_count = cycles;
            summary.cycle_pattern = pattern;
        }
    }
    // Find bottlenecks (tool+agent combos with highest avg time, min 2 calls)
    for (const [agent, tools] of agentToolTimings) {
        for (const [tool, durations] of tools) {
            if (durations.length >= 2) {
                const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
                if (avg > 1000) { // Only flag tools averaging >1s
                    summary.bottlenecks.push({ tool, agent, avg_ms: avg });
                }
            }
        }
    }
    // Sort bottlenecks by avg_ms descending
    summary.bottlenecks.sort((a, b) => b.avg_ms - a.avg_ms);
    return summary;
}
// ============================================================================
// Cleanup Functions
// ============================================================================
/**
 * Clean up old replay files, keeping only the most recent ones
 */
export function cleanupReplayFiles(directory) {
    const stateDir = join(getOmcRoot(directory), 'state');
    if (!existsSync(stateDir))
        return 0;
    try {
        const files = readdirSync(stateDir)
            .filter(f => f.startsWith(REPLAY_PREFIX) && f.endsWith('.jsonl'))
            .map(f => ({
            name: f,
            path: join(stateDir, f),
            mtime: statSync(join(stateDir, f)).mtimeMs,
        }))
            .sort((a, b) => b.mtime - a.mtime);
        let removed = 0;
        for (let i = MAX_REPLAY_FILES; i < files.length; i++) {
            try {
                unlinkSync(files[i].path);
                removed++;
            }
            catch { /* ignore */ }
        }
        return removed;
    }
    catch {
        return 0;
    }
}
/**
 * Reset session start time cache (for testing)
 */
export function resetSessionStartTimes() {
    sessionStartTimes.clear();
}
//# sourceMappingURL=session-replay.js.map