import { execFileSync } from 'child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, normalize, resolve } from 'path';
import { createInterface } from 'readline';
import { getOmcRoot, resolveToWorktreeRoot, validateSessionId, validateWorkingDirectory } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { encodeProjectPath } from '../../utils/encode-project-path.js';
const DEFAULT_LIMIT = 10;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_MESSAGE_BYTES = 32 * 1024;
const LARGE_LINE_BYTES = 16 * 1024;
const ERROR_RATE_WARN = 0.2;
const IDLE_GAP_WARN_MINUTES = 45;
function parseSinceSpec(since) {
    if (!since)
        return undefined;
    const trimmed = since.trim();
    if (!trimmed)
        return undefined;
    const durationMatch = trimmed.match(/^(\d+)\s*([mhdw])$/i);
    if (durationMatch) {
        const amount = Number.parseInt(durationMatch[1], 10);
        const unit = durationMatch[2].toLowerCase();
        const multiplierMap = {
            m: 60_000,
            h: 3_600_000,
            d: 86_400_000,
            w: 604_800_000,
        };
        return Date.now() - amount * multiplierMap[unit];
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function getMainRepoRoot(projectRoot) {
    try {
        const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
        const mainRepoRoot = dirname(resolve(projectRoot, gitCommonDir));
        return mainRepoRoot === projectRoot ? null : mainRepoRoot;
    }
    catch {
        return null;
    }
}
function getClaudeWorktreeParent(projectRoot) {
    const marker = `${normalize('/.claude/worktrees/')}`;
    const normalizedRoot = normalize(projectRoot);
    const idx = normalizedRoot.indexOf(marker);
    return idx === -1 ? null : normalizedRoot.slice(0, idx) || null;
}
function listJsonFiles(rootDir) {
    if (!existsSync(rootDir))
        return [];
    const files = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            }
            else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
                files.push(fullPath);
            }
        }
    }
    return files;
}
function isWithinProject(projectPath, projectRoots) {
    if (!projectPath)
        return false;
    const normalizedProjectPath = normalize(resolve(projectPath)).replace(/\\/g, '/');
    return projectRoots.some((root) => {
        const normalizedRoot = normalize(resolve(root)).replace(/\\/g, '/');
        return normalizedProjectPath === normalizedRoot || normalizedProjectPath.startsWith(`${normalizedRoot}/`);
    });
}
function buildScopeMode(project) {
    if (!project || project === 'current')
        return 'current';
    if (project === 'all')
        return 'all';
    return 'project';
}
function matchesProjectFilter(projectPath, projectFilter) {
    if (!projectFilter || projectFilter === 'all')
        return true;
    if (!projectPath)
        return false;
    return projectPath.toLowerCase().includes(projectFilter.toLowerCase());
}
function isOmcSource(sourceType) {
    return sourceType === 'omc-session-summary' || sourceType === 'omc-session-replay';
}
function matchesProjectScope(sourceType, projectPath, projectFilter) {
    if (!projectFilter || projectFilter === 'all')
        return true;
    if (!projectPath)
        return isOmcSource(sourceType);
    return matchesProjectFilter(projectPath, projectFilter);
}
function uniqueSortedTargets(targets) {
    const seen = new Set();
    return targets
        .filter((target) => {
        const key = `${target.sourceType}:${target.filePath}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    })
        .sort((a, b) => {
        const aTime = existsSync(a.filePath) ? statSync(a.filePath).mtimeMs : 0;
        const bTime = existsSync(b.filePath) ? statSync(b.filePath).mtimeMs : 0;
        return bTime - aTime;
    });
}
function buildTargets(projectRoot, projectRoots, scopeMode) {
    const claudeDir = getClaudeConfigDir();
    const targets = [];
    if (scopeMode === 'all') {
        for (const filePath of listJsonFiles(join(claudeDir, 'projects'))) {
            targets.push({ filePath, sourceType: 'project-transcript' });
        }
        for (const filePath of listJsonFiles(join(claudeDir, 'transcripts'))) {
            targets.push({ filePath, sourceType: 'legacy-transcript' });
        }
    }
    else {
        for (const root of projectRoots) {
            for (const filePath of listJsonFiles(join(claudeDir, 'projects', encodeProjectPath(root)))) {
                targets.push({ filePath, sourceType: 'project-transcript' });
            }
        }
        for (const filePath of listJsonFiles(join(claudeDir, 'transcripts'))) {
            targets.push({ filePath, sourceType: 'legacy-transcript' });
        }
    }
    const omcRoot = getOmcRoot(projectRoot);
    for (const filePath of listJsonFiles(join(omcRoot, 'sessions'))) {
        targets.push({ filePath, sourceType: 'omc-session-summary' });
    }
    for (const filePath of listJsonFiles(join(omcRoot, 'state'))) {
        if (filePath.includes('agent-replay-') && filePath.endsWith('.jsonl')) {
            targets.push({ filePath, sourceType: 'omc-session-replay' });
        }
    }
    return uniqueSortedTargets(targets);
}
function byteLength(value) {
    if (value === undefined || value === null)
        return 0;
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
}
function getMessageContent(record) {
    const message = record.message;
    return message && typeof message === 'object' && !Array.isArray(message)
        ? message.content
        : undefined;
}
function countToolUse(content) {
    if (!Array.isArray(content))
        return 0;
    return content.filter((block) => block && typeof block === 'object' && block.type === 'tool_use').length;
}
function countToolResult(content) {
    if (!Array.isArray(content))
        return 0;
    return content.filter((block) => block && typeof block === 'object' && block.type === 'tool_result').length;
}
function isErrorResult(record) {
    if (record.is_error === true || record.isError === true)
        return true;
    const content = getMessageContent(record);
    if (!Array.isArray(content))
        return false;
    return content.some((block) => block && typeof block === 'object' && (block.is_error === true || block.isError === true));
}
function timestampOf(record) {
    for (const key of ['timestamp', 'started_at', 'ended_at']) {
        const value = record[key];
        if (typeof value === 'string')
            return value;
    }
    return undefined;
}
function sessionIdOf(record) {
    for (const key of ['sessionId', 'session_id']) {
        const value = record[key];
        if (typeof value === 'string')
            return value;
    }
    const message = record.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        const value = message.sessionId;
        if (typeof value === 'string')
            return value;
    }
    return undefined;
}
function updateTimeRange(stats, timestamp) {
    if (!timestamp || Number.isNaN(Date.parse(timestamp)))
        return;
    if (!stats.firstTimestamp || Date.parse(timestamp) < Date.parse(stats.firstTimestamp))
        stats.firstTimestamp = timestamp;
    if (!stats.lastTimestamp || Date.parse(timestamp) > Date.parse(stats.lastTimestamp))
        stats.lastTimestamp = timestamp;
}
function updateIdleGap(stats, previousTimestamp, timestamp) {
    if (!previousTimestamp || !timestamp)
        return;
    const previous = Date.parse(previousTimestamp);
    const current = Date.parse(timestamp);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current < previous)
        return;
    const gap = Math.round((current - previous) / 60_000);
    stats.maxIdleGapMinutes = Math.max(stats.maxIdleGapMinutes ?? 0, gap);
}
function getStats(map, sessionId) {
    let stats = map.get(sessionId);
    if (!stats) {
        stats = {
            sessionId,
            sources: new Set(),
            transcriptBytes: 0,
            transcriptLines: 0,
            userTurns: 0,
            assistantTurns: 0,
            toolCalls: 0,
            toolResults: 0,
            errorResults: 0,
            maxLineBytes: 0,
            largestMessageBytes: 0,
            estimatedContextPercent: null,
            contextWindowTokens: null,
            inputTokens: null,
            maxIdleGapMinutes: null,
            replayEvents: 0,
            replayAgentsSpawned: 0,
            replayAgentsFailed: 0,
            replayToolCalls: 0,
            replayHooksFired: 0,
        };
        map.set(sessionId, stats);
    }
    return stats;
}
function updateContextEstimate(stats, record) {
    const windowValue = typeof record.context_window === 'number' ? record.context_window : null;
    const inputValue = typeof record.input_tokens === 'number' ? record.input_tokens : null;
    if (windowValue && inputValue !== null) {
        stats.contextWindowTokens = windowValue;
        stats.inputTokens = inputValue;
        stats.estimatedContextPercent = Math.round((inputValue / windowValue) * 100);
    }
}
function addSignal(signals, severity, code, message, evidence) {
    signals.push({ severity, code, message, evidence });
}
function computeSignals(stats) {
    const signals = [];
    let score = 0;
    if ((stats.estimatedContextPercent ?? 0) >= 90) {
        score += 35;
        addSignal(signals, 'critical', 'context-critical', 'Estimated context usage is at or above 90%.', { estimatedContextPercent: stats.estimatedContextPercent });
    }
    else if ((stats.estimatedContextPercent ?? 0) >= 75) {
        score += 20;
        addSignal(signals, 'warn', 'context-high', 'Estimated context usage is above the normal guard threshold.', { estimatedContextPercent: stats.estimatedContextPercent });
    }
    if (stats.largestMessageBytes >= LARGE_MESSAGE_BYTES) {
        score += 15;
        addSignal(signals, 'warn', 'large-message', 'A very large transcript message was observed by size only.', { largestMessageBytes: stats.largestMessageBytes });
    }
    if (stats.maxLineBytes >= LARGE_LINE_BYTES) {
        score += 10;
        addSignal(signals, 'warn', 'large-jsonl-line', 'A large transcript JSONL line may indicate pasted logs or bulky tool output.', { maxLineBytes: stats.maxLineBytes });
    }
    if (stats.toolResults > 0 && stats.errorResults / stats.toolResults >= ERROR_RATE_WARN) {
        score += 20;
        addSignal(signals, 'warn', 'tool-error-rate', 'Tool-result error rate is high enough to create retry friction.', { errorResults: stats.errorResults, toolResults: stats.toolResults });
    }
    if ((stats.maxIdleGapMinutes ?? 0) >= IDLE_GAP_WARN_MINUTES) {
        score += 10;
        addSignal(signals, 'info', 'long-idle-gap', 'A long idle gap may make the session harder to resume.', { maxIdleGapMinutes: stats.maxIdleGapMinutes });
    }
    if (stats.replayAgentsFailed > 0) {
        score += 15;
        addSignal(signals, 'warn', 'agent-failures', 'Replay logs include failed agent completions.', { replayAgentsFailed: stats.replayAgentsFailed });
    }
    if (stats.replayHooksFired > 30) {
        score += 5;
        addSignal(signals, 'info', 'hook-noise', 'Replay logs show frequent hook activity.', { replayHooksFired: stats.replayHooksFired });
    }
    if (signals.length === 0) {
        addSignal(signals, 'info', 'no-obvious-friction', 'No obvious friction signal was detected from local metadata.', { transcriptBytes: stats.transcriptBytes, toolCalls: stats.toolCalls });
    }
    return { score: Math.min(100, score), signals };
}
async function scanJsonlTarget(target, sessions, filters) {
    const fileMtime = existsSync(target.filePath) ? statSync(target.filePath).mtimeMs : 0;
    const reader = createInterface({ input: createReadStream(target.filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const lastTimestamps = new Map();
    try {
        for await (const rawLine of reader) {
            if (!rawLine.trim())
                continue;
            let record;
            try {
                record = JSON.parse(rawLine);
            }
            catch {
                continue;
            }
            const sessionId = sessionIdOf(record);
            if (!sessionId || (filters.sessionId && sessionId !== filters.sessionId))
                continue;
            const projectPath = typeof record.cwd === 'string' ? record.cwd : undefined;
            if (filters.projectRoots && filters.projectRoots.length > 0 && projectPath && !isWithinProject(projectPath, filters.projectRoots))
                continue;
            if (!matchesProjectScope(target.sourceType, projectPath, filters.projectFilter))
                continue;
            const timestamp = timestampOf(record);
            const entryEpoch = timestamp ? Date.parse(timestamp) : fileMtime;
            if (filters.sinceEpoch && Number.isFinite(entryEpoch) && entryEpoch < filters.sinceEpoch)
                continue;
            const stats = getStats(sessions, sessionId);
            stats.sources.add(target.sourceType);
            if (projectPath)
                stats.projectPath = projectPath;
            updateTimeRange(stats, timestamp);
            updateIdleGap(stats, lastTimestamps.get(sessionId), timestamp);
            if (timestamp)
                lastTimestamps.set(sessionId, timestamp);
            const lineBytes = Buffer.byteLength(rawLine, 'utf-8');
            stats.transcriptBytes += lineBytes + 1;
            stats.transcriptLines += 1;
            stats.maxLineBytes = Math.max(stats.maxLineBytes, lineBytes);
            stats.largestMessageBytes = Math.max(stats.largestMessageBytes, byteLength(getMessageContent(record)));
            const role = typeof record.message?.role === 'string'
                ? record.message.role
                : typeof record.type === 'string'
                    ? record.type
                    : undefined;
            if (role === 'user')
                stats.userTurns += 1;
            if (role === 'assistant')
                stats.assistantTurns += 1;
            const content = getMessageContent(record);
            stats.toolCalls += countToolUse(content);
            stats.toolResults += countToolResult(content);
            if (isErrorResult(record))
                stats.errorResults += 1;
            updateContextEstimate(stats, record);
            if (target.sourceType === 'omc-session-replay') {
                stats.replayEvents += 1;
                if (record.event === 'agent_start')
                    stats.replayAgentsSpawned += 1;
                if (record.event === 'agent_stop' && record.success === false)
                    stats.replayAgentsFailed += 1;
                if (record.event === 'tool_end')
                    stats.replayToolCalls += 1;
                if (record.event === 'hook_fire')
                    stats.replayHooksFired += 1;
            }
        }
    }
    finally {
        reader.close();
    }
}
async function scanJsonTarget(target, sessions, filters) {
    let record;
    try {
        const { readFile } = await import('fs/promises');
        record = JSON.parse(await readFile(target.filePath, 'utf-8'));
    }
    catch {
        return;
    }
    const sessionId = sessionIdOf(record);
    if (!sessionId || (filters.sessionId && sessionId !== filters.sessionId))
        return;
    const projectPath = typeof record.cwd === 'string' ? record.cwd : undefined;
    if (filters.projectRoots && filters.projectRoots.length > 0 && projectPath && !isWithinProject(projectPath, filters.projectRoots))
        return;
    if (!matchesProjectScope(target.sourceType, projectPath, filters.projectFilter))
        return;
    const timestamp = timestampOf(record);
    const fileMtime = existsSync(target.filePath) ? statSync(target.filePath).mtimeMs : 0;
    const entryEpoch = timestamp ? Date.parse(timestamp) : fileMtime;
    if (filters.sinceEpoch && Number.isFinite(entryEpoch) && entryEpoch < filters.sinceEpoch)
        return;
    const stats = getStats(sessions, sessionId);
    stats.sources.add(target.sourceType);
    if (projectPath)
        stats.projectPath = projectPath;
    updateTimeRange(stats, timestamp);
    const bytes = existsSync(target.filePath) ? statSync(target.filePath).size : 0;
    stats.transcriptBytes += bytes;
    stats.transcriptLines += 1;
}
export async function generateSessionFrictionReport(rawOptions = {}) {
    if (rawOptions.sessionId)
        validateSessionId(rawOptions.sessionId);
    const limit = Math.max(1, rawOptions.limit ?? DEFAULT_LIMIT);
    const sinceEpoch = parseSinceSpec(rawOptions.since);
    const workingDirectory = validateWorkingDirectory(rawOptions.workingDirectory);
    const currentProjectRoot = resolveToWorktreeRoot(workingDirectory);
    const scopeMode = buildScopeMode(rawOptions.project);
    const literalWorkingDirectory = rawOptions.workingDirectory ? resolve(rawOptions.workingDirectory) : workingDirectory;
    const projectRoots = [currentProjectRoot, literalWorkingDirectory]
        .concat(getMainRepoRoot(currentProjectRoot) ?? [])
        .concat(getClaudeWorktreeParent(currentProjectRoot) ?? [])
        .filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);
    const targets = buildTargets(currentProjectRoot, projectRoots, scopeMode);
    const sessions = new Map();
    for (const target of targets) {
        const filters = {
            sessionId: rawOptions.sessionId,
            sinceEpoch,
            projectFilter: scopeMode === 'project' ? rawOptions.project : undefined,
            projectRoots: scopeMode === 'current' ? projectRoots : undefined,
        };
        if (target.filePath.endsWith('.json')) {
            await scanJsonTarget(target, sessions, filters);
        }
        else {
            await scanJsonlTarget(target, sessions, filters);
        }
    }
    const sessionReports = Array.from(sessions.values()).map((stats) => {
        if (stats.estimatedContextPercent === null && stats.contextWindowTokens === null && stats.inputTokens === null) {
            const approximatePercent = Math.round((stats.transcriptBytes / DEFAULT_CONTEXT_WINDOW) * 100);
            stats.estimatedContextPercent = approximatePercent > 0 ? Math.min(100, approximatePercent) : null;
        }
        const { score, signals } = computeSignals(stats);
        return {
            ...stats,
            sources: Array.from(stats.sources).sort(),
            frictionScore: score,
            signals,
        };
    }).sort((a, b) => {
        if (a.frictionScore !== b.frictionScore)
            return b.frictionScore - a.frictionScore;
        const aTime = a.lastTimestamp ? Date.parse(a.lastTimestamp) : 0;
        const bTime = b.lastTimestamp ? Date.parse(b.lastTimestamp) : 0;
        return bTime - aTime;
    }).slice(0, limit);
    const criticalSignals = sessionReports.reduce((count, session) => count + session.signals.filter((signal) => signal.severity === 'critical').length, 0);
    const warningSignals = sessionReports.reduce((count, session) => count + session.signals.filter((signal) => signal.severity === 'warn').length, 0);
    return {
        generatedAt: new Date().toISOString(),
        scope: {
            mode: scopeMode,
            project: rawOptions.project,
            workingDirectory: currentProjectRoot,
            since: rawOptions.since,
        },
        privacy: {
            localOnly: true,
            rawContentIncluded: false,
            summary: 'Report uses local transcript/session metadata only and does not include raw prompt, response, or tool-result content.',
        },
        totals: {
            sessions: sessionReports.length,
            transcriptBytes: sessionReports.reduce((sum, session) => sum + session.transcriptBytes, 0),
            transcriptLines: sessionReports.reduce((sum, session) => sum + session.transcriptLines, 0),
            toolCalls: sessionReports.reduce((sum, session) => sum + session.toolCalls + session.replayToolCalls, 0),
            errorResults: sessionReports.reduce((sum, session) => sum + session.errorResults + session.replayAgentsFailed, 0),
            criticalSignals,
            warningSignals,
        },
        sessions: sessionReports,
    };
}
//# sourceMappingURL=index.js.map