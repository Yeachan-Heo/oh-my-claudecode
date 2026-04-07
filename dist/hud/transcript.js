/**
 * OMC HUD - Transcript Parser
 *
 * Parse JSONL transcript from Claude Code to extract agents and todos.
 * Based on claude-hud reference implementation.
 *
 * Performance optimizations:
 * - Tail-based parsing: reads only the last ~500KB of large transcripts
 * - Bounded agent map: caps at 50 agents during parsing
 * - Early termination: stops when enough running agents found
 */
import { createReadStream, existsSync, statSync, openSync, readSync, closeSync, } from "fs";
import { createInterface } from "readline";
import { basename } from "path";
// Performance constants
// 4MB tail window: enough to catch the full tool_use → tool_result → task-notification
// chain for agent-heavy sessions (typically ~30-50KB per agent call, so 4MB covers
// ~80-130 agents). The previous 512KB window lost completion signals for older
// agents in long sessions, leaving them stuck as "running" in the HUD.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_MAP_SIZE = 100; // Cap agent tracking
const _MIN_RUNNING_AGENTS_THRESHOLD = 10; // Early termination threshold
/**
 * Tools known to require permission approval in Claude Code.
 * Only these tools will trigger the "APPROVE?" indicator.
 */
const PERMISSION_TOOLS = [
    "Edit",
    "Write",
    "Bash",
    "proxy_Edit",
    "proxy_Write",
    "proxy_Bash",
];
/**
 * Time threshold for considering a tool "pending approval".
 * If tool_use exists without tool_result within this window, show indicator.
 */
const PERMISSION_THRESHOLD_MS = 3000; // 3 seconds
/**
 * Module-level map tracking pending permission-requiring tools.
 * Key: tool_use block id, Value: PendingPermission info
 * Cleared when tool_result is received for the corresponding tool_use.
 */
const pendingPermissionMap = new Map();
/**
 * Content block types that indicate extended thinking mode.
 */
const THINKING_PART_TYPES = ["thinking", "reasoning"];
/**
 * Time threshold for considering thinking "active".
 */
const THINKING_RECENCY_MS = 30_000; // 30 seconds
const transcriptCache = new Map();
const TRANSCRIPT_CACHE_MAX_SIZE = 20;
export async function parseTranscript(transcriptPath, options) {
    pendingPermissionMap.clear();
    const result = {
        agents: [],
        todos: [],
        lastActivatedSkill: undefined,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        lastToolName: null,
    };
    if (!transcriptPath || !existsSync(transcriptPath)) {
        return result;
    }
    let cacheKey = null;
    try {
        const stat = statSync(transcriptPath);
        cacheKey = `${transcriptPath}:${stat.size}:${stat.mtimeMs}`;
        const cached = transcriptCache.get(transcriptPath);
        if (cached?.cacheKey === cacheKey) {
            return finalizeTranscriptResult(cloneTranscriptData(cached.baseResult), options, cached.pendingPermissions);
        }
    }
    catch {
        return result;
    }
    const agentMap = new Map();
    const backgroundAgentMap = new Map();
    const latestTodos = [];
    const sessionTokenTotals = {
        inputTokens: 0,
        outputTokens: 0,
        seenUsage: false,
    };
    let sessionTotalsReliable = false;
    const observedSessionIds = new Set();
    try {
        const stat = statSync(transcriptPath);
        const fileSize = stat.size;
        if (fileSize > MAX_TAIL_BYTES) {
            const lines = readTailLines(transcriptPath, fileSize, MAX_TAIL_BYTES);
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    processEntry(entry, agentMap, latestTodos, result, MAX_AGENT_MAP_SIZE, backgroundAgentMap, sessionTokenTotals, observedSessionIds);
                }
                catch {
                    // Skip malformed lines
                }
            }
            // Token totals from a tail-read are partial (we only saw the last MAX_TAIL_BYTES).
            // Still surface them when token data was found so the HUD shows something useful.
            sessionTotalsReliable = sessionTokenTotals.seenUsage;
        }
        else {
            const fileStream = createReadStream(transcriptPath);
            const rl = createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    processEntry(entry, agentMap, latestTodos, result, MAX_AGENT_MAP_SIZE, backgroundAgentMap, sessionTokenTotals, observedSessionIds);
                }
                catch {
                    // Skip malformed lines
                }
            }
            sessionTotalsReliable = observedSessionIds.size <= 1;
        }
    }
    catch {
        return finalizeTranscriptResult(result, options, []);
    }
    const running = Array.from(agentMap.values()).filter((a) => a.status === "running");
    const completed = Array.from(agentMap.values()).filter((a) => a.status === "completed");
    result.agents = [
        ...running,
        ...completed.slice(-(10 - running.length)),
    ].slice(0, 10);
    result.todos = latestTodos;
    if (sessionTotalsReliable && sessionTokenTotals.seenUsage) {
        result.sessionTotalTokens = sessionTokenTotals.inputTokens + sessionTokenTotals.outputTokens;
    }
    const pendingPermissions = Array.from(pendingPermissionMap.values()).map(clonePendingPermission);
    const finalized = finalizeTranscriptResult(result, options, pendingPermissions);
    if (cacheKey) {
        if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX_SIZE) {
            transcriptCache.clear();
        }
        transcriptCache.set(transcriptPath, {
            cacheKey,
            baseResult: cloneTranscriptData(finalized),
            pendingPermissions,
        });
    }
    return finalized;
}
/**
 * Read the tail portion of a file and split into lines.
 * Handles partial first line (from mid-file start).
 */
function cloneDate(value) {
    return value ? new Date(value.getTime()) : undefined;
}
function clonePendingPermission(permission) {
    return {
        ...permission,
        timestamp: new Date(permission.timestamp.getTime()),
    };
}
function cloneTranscriptData(result) {
    return {
        ...result,
        agents: result.agents.map((agent) => ({
            ...agent,
            startTime: new Date(agent.startTime.getTime()),
            endTime: cloneDate(agent.endTime),
        })),
        todos: result.todos.map((todo) => ({ ...todo })),
        sessionStart: cloneDate(result.sessionStart),
        lastActivatedSkill: result.lastActivatedSkill
            ? {
                ...result.lastActivatedSkill,
                timestamp: new Date(result.lastActivatedSkill.timestamp.getTime()),
            }
            : undefined,
        pendingPermission: result.pendingPermission
            ? clonePendingPermission(result.pendingPermission)
            : undefined,
        thinkingState: result.thinkingState
            ? {
                ...result.thinkingState,
                lastSeen: cloneDate(result.thinkingState.lastSeen),
            }
            : undefined,
        lastRequestTokenUsage: result.lastRequestTokenUsage
            ? { ...result.lastRequestTokenUsage }
            : undefined,
    };
}
function finalizeTranscriptResult(result, options, pendingPermissions) {
    const staleMinutes = options?.staleTaskThresholdMinutes ?? 30;
    const staleAgentThresholdMs = staleMinutes * 60 * 1000;
    const now = Date.now();
    for (const agent of result.agents) {
        if (agent.status === "running") {
            const runningTime = now - agent.startTime.getTime();
            if (runningTime > staleAgentThresholdMs) {
                agent.status = "completed";
                agent.endTime = new Date(agent.startTime.getTime() + staleAgentThresholdMs);
            }
        }
    }
    result.pendingPermission = undefined;
    for (const permission of pendingPermissions) {
        const age = now - permission.timestamp.getTime();
        if (age <= PERMISSION_THRESHOLD_MS) {
            result.pendingPermission = clonePendingPermission(permission);
            break;
        }
    }
    if (result.thinkingState?.lastSeen) {
        const age = now - result.thinkingState.lastSeen.getTime();
        result.thinkingState.active = age <= THINKING_RECENCY_MS;
    }
    return result;
}
function readTailLines(filePath, fileSize, maxBytes) {
    const startOffset = Math.max(0, fileSize - maxBytes);
    const bytesToRead = fileSize - startOffset;
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(bytesToRead);
    try {
        readSync(fd, buffer, 0, bytesToRead, startOffset);
    }
    finally {
        closeSync(fd);
    }
    const content = buffer.toString("utf8");
    const lines = content.split("\n");
    // If we started mid-file, discard the potentially incomplete first line.
    // This also handles UTF-8 multi-byte boundary splits: the first chunk may
    // start in the middle of a multi-byte sequence, producing a garbled line.
    // Discarding it is safe because every valid JSONL line ends with '\n'.
    if (startOffset > 0 && lines.length > 0) {
        lines.shift();
    }
    return lines;
}
/**
 * Extract background agent ID from "Async agent launched" message
 */
function extractBackgroundAgentId(content) {
    const text = typeof content === "string"
        ? content
        : content.find((c) => c.type === "text")?.text || "";
    // Pattern: "agentId: a8de3dd"
    const match = text.match(/agentId:\s*([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}
/**
 * Parse TaskOutput result for completion status.
 *
 * Claude Code emits completion as a `<task-notification>` block with
 * hyphen-cased tags (`<task-id>`, `<tool-use-id>`, `<status>`). Accept
 * both hyphen and underscore variants for defence in depth.
 */
function parseTaskOutputResult(content) {
    const text = typeof content === "string"
        ? content
        : content.find((c) => c.type === "text")?.text || "";
    // Hyphen variant (real Claude Code format) first, underscore fallback second.
    const taskIdMatch = text.match(/<task-id>([^<]+)<\/task-id>/) ||
        text.match(/<task_id>([^<]+)<\/task_id>/);
    const statusMatch = text.match(/<status>([^<]+)<\/status>/);
    const toolUseIdMatch = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) ||
        text.match(/<tool_use_id>([^<]+)<\/tool_use_id>/);
    if (taskIdMatch && statusMatch) {
        return {
            taskId: taskIdMatch[1],
            toolUseId: toolUseIdMatch ? toolUseIdMatch[1] : null,
            status: statusMatch[1],
        };
    }
    return null;
}
/**
 * Extract a human-readable target summary from tool input.
 */
function extractTargetSummary(input, toolName) {
    if (!input || typeof input !== "object")
        return "...";
    const inp = input;
    // Edit/Write: show file path
    if (toolName.includes("Edit") || toolName.includes("Write")) {
        const filePath = inp.file_path;
        if (filePath) {
            // Return just the filename or last path segment
            return basename(filePath) || filePath;
        }
    }
    // Bash: show first 20 chars of command
    if (toolName.includes("Bash")) {
        const cmd = inp.command;
        if (cmd) {
            const trimmed = cmd.trim().substring(0, 20);
            return trimmed.length < cmd.trim().length ? `${trimmed}...` : trimmed;
        }
    }
    return "...";
}
/**
 * Process a single transcript entry
 */
function processEntry(entry, agentMap, latestTodos, result, maxAgentMapSize = 50, backgroundAgentMap, sessionTokenTotals, observedSessionIds) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
    if (entry.sessionId) {
        observedSessionIds?.add(entry.sessionId);
    }
    const usage = extractLastRequestTokenUsage(entry.message?.usage);
    if (usage) {
        result.lastRequestTokenUsage = usage;
        if (sessionTokenTotals) {
            sessionTokenTotals.inputTokens += usage.inputTokens;
            sessionTokenTotals.outputTokens += usage.outputTokens;
            sessionTokenTotals.seenUsage = true;
        }
    }
    // Set session start time from first entry
    if (!result.sessionStart && entry.timestamp) {
        result.sessionStart = timestamp;
    }
    const content = entry.message?.content;
    // Claude Code emits background-agent completion as a user-role message with
    // string-shaped content: `<task-notification>...<tool-use-id>...</tool-use-id>
    // ...<status>completed</status>...</task-notification>`. The block-based
    // parser below only handles array-shaped content, so we handle the string
    // case up front — otherwise background agents (subagents launched with
    // run_in_background, Explore/Plan/general-purpose, etc.) never transition
    // from "running" to "completed" in the HUD.
    if (typeof content === "string") {
        if (content.includes("<task-notification>") || content.includes("<task_id>") || content.includes("<task-id>")) {
            const taskOutput = parseTaskOutputResult(content);
            if (taskOutput && taskOutput.status === "completed") {
                // Prefer direct tool-use-id lookup (skips the backgroundAgentMap
                // indirection). Fall back to the legacy agentId → tool_use_id mapping.
                let toolUseId;
                if (taskOutput.toolUseId) {
                    toolUseId = taskOutput.toolUseId;
                }
                else if (backgroundAgentMap) {
                    toolUseId = backgroundAgentMap.get(taskOutput.taskId);
                }
                if (toolUseId) {
                    const agent = agentMap.get(toolUseId);
                    if (agent && agent.status === "running") {
                        agent.status = "completed";
                        agent.endTime = timestamp;
                    }
                }
            }
        }
        return;
    }
    if (!content || !Array.isArray(content))
        return;
    for (const block of content) {
        // Check if this is a thinking block
        if (THINKING_PART_TYPES.includes(block.type)) {
            result.thinkingState = {
                active: true,
                lastSeen: timestamp,
            };
        }
        // Track tool_use for Task (agents) and TodoWrite
        if (block.type === "tool_use" && block.id && block.name) {
            result.toolCallCount++;
            result.lastToolName = block.name;
            if (block.name === "Task" || block.name === "proxy_Task" || block.name === "Agent") {
                result.agentCallCount++;
                const input = block.input;
                const agentEntry = {
                    id: block.id,
                    type: input?.subagent_type ?? "unknown",
                    model: input?.model,
                    description: input?.description,
                    status: "running",
                    startTime: timestamp,
                };
                // Bounded agent map: evict oldest completed agents if at capacity
                if (agentMap.size >= maxAgentMapSize) {
                    // Find and remove oldest completed agent
                    let oldestCompleted = null;
                    let oldestTime = Infinity;
                    for (const [id, agent] of agentMap) {
                        if (agent.status === "completed" && agent.startTime) {
                            const time = agent.startTime.getTime();
                            if (time < oldestTime) {
                                oldestTime = time;
                                oldestCompleted = id;
                            }
                        }
                    }
                    if (oldestCompleted) {
                        agentMap.delete(oldestCompleted);
                    }
                }
                agentMap.set(block.id, agentEntry);
            }
            else if (block.name === "TodoWrite" || block.name === "proxy_TodoWrite") {
                const input = block.input;
                if (input?.todos && Array.isArray(input.todos)) {
                    // Replace latest todos with new ones
                    latestTodos.length = 0;
                    latestTodos.push(...input.todos.map((t) => ({
                        content: t.content,
                        status: t.status,
                        activeForm: t.activeForm,
                    })));
                }
            }
            else if (block.name === "Skill" || block.name === "proxy_Skill") {
                result.skillCallCount++;
                // Track last activated skill
                const input = block.input;
                if (input?.skill) {
                    result.lastActivatedSkill = {
                        name: input.skill,
                        args: input.args,
                        timestamp: timestamp,
                    };
                }
            }
            // Track tool_use for permission-requiring tools
            if (PERMISSION_TOOLS.includes(block.name)) {
                pendingPermissionMap.set(block.id, {
                    toolName: block.name.replace("proxy_", ""),
                    targetSummary: extractTargetSummary(block.input, block.name),
                    timestamp: timestamp,
                });
            }
        }
        // Track tool_result to mark agents as completed
        if (block.type === "tool_result" && block.tool_use_id) {
            // Clear from pending permissions when tool_result arrives
            pendingPermissionMap.delete(block.tool_use_id);
            const agent = agentMap.get(block.tool_use_id);
            if (agent) {
                const blockContent = block.content;
                // Check if this is a background agent launch result.
                //
                // The real "Async agent launched successfully" notification is a
                // short (~400B), standalone tool_result whose text STARTS with the
                // exact phrase. A completed foreground agent result can easily
                // contain the same phrase quoted elsewhere (e.g. an investigation
                // report that cites a previous launch message), so a naive
                // `.includes()` check misclassifies legitimate completions as
                // background launches and leaves them stuck as "running" in the HUD.
                //
                // Require the text to START WITH "Async agent launched" (after
                // trimming leading whitespace) — nothing else qualifies.
                const ASYNC_LAUNCH_PREFIX = "Async agent launched";
                const startsWithAsyncLaunch = (text) => !!text && text.trimStart().startsWith(ASYNC_LAUNCH_PREFIX);
                const isBackgroundLaunch = typeof blockContent === "string"
                    ? startsWithAsyncLaunch(blockContent)
                    : Array.isArray(blockContent) &&
                        blockContent.length > 0 &&
                        typeof blockContent[0] === "object" &&
                        blockContent[0] !== null &&
                        blockContent[0].type === "text" &&
                        startsWithAsyncLaunch(blockContent[0].text);
                if (isBackgroundLaunch) {
                    // Extract and store the background agent ID mapping
                    if (backgroundAgentMap && blockContent) {
                        const bgAgentId = extractBackgroundAgentId(blockContent);
                        if (bgAgentId) {
                            backgroundAgentMap.set(bgAgentId, block.tool_use_id);
                        }
                    }
                    // Keep status as 'running'
                }
                else {
                    // Foreground agent completed
                    agent.status = "completed";
                    agent.endTime = timestamp;
                }
            }
            // Check if this is a TaskOutput result showing completion
            if (block.content) {
                const taskOutput = parseTaskOutputResult(block.content);
                if (taskOutput && taskOutput.status === "completed") {
                    // Prefer direct tool-use-id lookup; fall back to the legacy agentId mapping.
                    let toolUseId;
                    if (taskOutput.toolUseId) {
                        toolUseId = taskOutput.toolUseId;
                    }
                    else if (backgroundAgentMap) {
                        toolUseId = backgroundAgentMap.get(taskOutput.taskId);
                    }
                    if (toolUseId) {
                        const bgAgent = agentMap.get(toolUseId);
                        if (bgAgent && bgAgent.status === "running") {
                            bgAgent.status = "completed";
                            bgAgent.endTime = timestamp;
                        }
                    }
                }
            }
        }
    }
}
function extractLastRequestTokenUsage(usage) {
    if (!usage)
        return null;
    const inputTokens = getNumericUsageValue(usage.input_tokens);
    const outputTokens = getNumericUsageValue(usage.output_tokens);
    const reasoningTokens = getNumericUsageValue(usage.reasoning_tokens
        ?? usage.output_tokens_details?.reasoning_tokens
        ?? usage.output_tokens_details?.reasoningTokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoningTokens);
    if (inputTokens == null && outputTokens == null) {
        return null;
    }
    const normalized = {
        inputTokens: Math.max(0, Math.round(inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(outputTokens ?? 0)),
    };
    if (reasoningTokens != null && reasoningTokens > 0) {
        normalized.reasoningTokens = Math.max(0, Math.round(reasoningTokens));
    }
    return normalized;
}
function getNumericUsageValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
// ============================================================================
// Utility Functions
// ============================================================================
/**
 * Get count of running agents
 */
export function getRunningAgentCount(agents) {
    return agents.filter((a) => a.status === "running").length;
}
/**
 * Get todo completion stats
 */
export function getTodoStats(todos) {
    return {
        completed: todos.filter((t) => t.status === "completed").length,
        total: todos.length,
        inProgress: todos.filter((t) => t.status === "in_progress").length,
    };
}
//# sourceMappingURL=transcript.js.map