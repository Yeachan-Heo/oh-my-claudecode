import { execSync } from 'child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, normalize, resolve } from 'path';
import { createInterface } from 'readline';
import { resolveToWorktreeRoot, validateSessionId, validateWorkingDirectory, getOmcRoot, } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
const DEFAULT_LIMIT = 10;
const DEFAULT_CONTEXT_CHARS = 120;
function compactWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function normalizeForSearch(value, caseSensitive) {
    const compacted = compactWhitespace(value);
    return caseSensitive ? compacted : compacted.toLowerCase();
}
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
        const multiplier = multiplierMap[unit];
        return multiplier ? Date.now() - amount * multiplier : undefined;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function encodeProjectPath(projectPath) {
    return projectPath.replace(/[/\\.]/g, '-');
}
function getMainRepoRoot(projectRoot) {
    try {
        const gitCommonDir = execSync('git rev-parse --git-common-dir', {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const absoluteCommonDir = resolve(projectRoot, gitCommonDir);
        const mainRepoRoot = dirname(absoluteCommonDir);
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
    if (idx === -1)
        return null;
    return normalizedRoot.slice(0, idx) || null;
}
function listJsonlFiles(rootDir) {
    if (!existsSync(rootDir)) {
        return [];
    }
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
                continue;
            }
            if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
                files.push(fullPath);
            }
        }
    }
    return files;
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
function buildCurrentProjectTargets(projectRoot) {
    const claudeDir = getClaudeConfigDir();
    const projectRoots = new Set([projectRoot]);
    const mainRepoRoot = getMainRepoRoot(projectRoot);
    if (mainRepoRoot)
        projectRoots.add(mainRepoRoot);
    const claudeWorktreeParent = getClaudeWorktreeParent(projectRoot);
    if (claudeWorktreeParent)
        projectRoots.add(claudeWorktreeParent);
    const targets = [];
    for (const root of projectRoots) {
        const encodedDir = join(claudeDir, 'projects', encodeProjectPath(root));
        for (const filePath of listJsonlFiles(encodedDir)) {
            targets.push({ filePath, sourceType: 'project-transcript' });
        }
    }
    const legacyTranscriptsDir = join(claudeDir, 'transcripts');
    for (const filePath of listJsonlFiles(legacyTranscriptsDir)) {
        targets.push({ filePath, sourceType: 'legacy-transcript' });
    }
    const omcRoot = getOmcRoot(projectRoot);
    const sessionSummariesDir = join(omcRoot, 'sessions');
    for (const filePath of listJsonlFiles(sessionSummariesDir)) {
        targets.push({ filePath, sourceType: 'omc-session-summary' });
    }
    const replayDir = join(omcRoot, 'state');
    if (existsSync(replayDir)) {
        for (const filePath of listJsonlFiles(replayDir)) {
            if (filePath.includes('agent-replay-') && filePath.endsWith('.jsonl')) {
                targets.push({ filePath, sourceType: 'omc-session-replay' });
            }
        }
    }
    return uniqueSortedTargets(targets);
}
function buildAllProjectTargets() {
    const claudeDir = getClaudeConfigDir();
    const targets = [];
    for (const filePath of listJsonlFiles(join(claudeDir, 'projects'))) {
        targets.push({ filePath, sourceType: 'project-transcript' });
    }
    for (const filePath of listJsonlFiles(join(claudeDir, 'transcripts'))) {
        targets.push({ filePath, sourceType: 'legacy-transcript' });
    }
    return uniqueSortedTargets(targets);
}
function isWithinProject(projectPath, projectRoots) {
    if (!projectPath) {
        return false;
    }
    const normalizedProjectPath = normalize(resolve(projectPath));
    return projectRoots.some((root) => {
        const normalizedRoot = normalize(resolve(root));
        return normalizedProjectPath === normalizedRoot || normalizedProjectPath.startsWith(`${normalizedRoot}/`);
    });
}
function matchesProjectFilter(projectPath, projectFilter) {
    if (!projectFilter || projectFilter === 'all') {
        return true;
    }
    if (!projectPath) {
        return false;
    }
    return projectPath.toLowerCase().includes(projectFilter.toLowerCase());
}
function stringLeaves(value, maxLeaves = 24) {
    const leaves = [];
    const stack = [value];
    while (stack.length > 0 && leaves.length < maxLeaves) {
        const current = stack.pop();
        if (typeof current === 'string') {
            const compacted = compactWhitespace(current);
            if (compacted.length > 0) {
                leaves.push(compacted);
            }
            continue;
        }
        if (Array.isArray(current)) {
            stack.push(...current);
            continue;
        }
        if (current && typeof current === 'object') {
            stack.push(...Object.values(current));
        }
    }
    return leaves;
}
function extractTranscriptTexts(entry) {
    const texts = [];
    const message = entry.message;
    const content = message?.content;
    if (typeof content === 'string') {
        texts.push(content);
    }
    else if (Array.isArray(content)) {
        for (const block of content) {
            if (!block || typeof block !== 'object')
                continue;
            const record = block;
            const blockType = typeof record.type === 'string' ? record.type : undefined;
            if ((blockType === 'text' || blockType === 'thinking' || blockType === 'reasoning') && typeof record.text === 'string') {
                texts.push(record.text);
                continue;
            }
            if (blockType === 'tool_result') {
                texts.push(...stringLeaves(record.content));
                continue;
            }
            if (blockType === 'tool_use') {
                const toolName = typeof record.name === 'string' ? record.name : 'tool';
                const inputText = stringLeaves(record.input).join(' ');
                if (inputText) {
                    texts.push(`${toolName} ${inputText}`);
                }
            }
        }
    }
    return texts;
}
function buildTranscriptEntry(entry) {
    const texts = extractTranscriptTexts(entry);
    if (texts.length === 0) {
        return null;
    }
    const message = entry.message;
    const sessionId = typeof entry.sessionId === 'string'
        ? entry.sessionId
        : typeof entry.session_id === 'string'
            ? entry.session_id
            : typeof message?.sessionId === 'string'
                ? message.sessionId
                : undefined;
    if (!sessionId) {
        return null;
    }
    return {
        sessionId,
        agentId: typeof entry.agentId === 'string' ? entry.agentId : undefined,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
        projectPath: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        role: typeof message?.role === 'string' ? message.role : undefined,
        entryType: typeof entry.type === 'string' ? entry.type : undefined,
        texts,
    };
}
function buildJsonArtifactEntry(entry, sourceType) {
    const sessionId = typeof entry.session_id === 'string'
        ? entry.session_id
        : typeof entry.sessionId === 'string'
            ? entry.sessionId
            : undefined;
    if (!sessionId) {
        return null;
    }
    const texts = stringLeaves(entry);
    if (texts.length === 0) {
        return null;
    }
    const timestamp = typeof entry.ended_at === 'string'
        ? entry.ended_at
        : typeof entry.started_at === 'string'
            ? entry.started_at
            : typeof entry.timestamp === 'string'
                ? entry.timestamp
                : undefined;
    const entryType = sourceType === 'omc-session-summary' ? 'session-summary' : 'session-replay';
    return {
        sessionId,
        timestamp,
        projectPath: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        entryType,
        texts,
    };
}
function buildSearchableEntry(entry, sourceType) {
    if (sourceType === 'project-transcript' || sourceType === 'legacy-transcript' || sourceType === 'omc-session-replay') {
        return buildTranscriptEntry(entry) ?? (sourceType === 'omc-session-replay' ? buildJsonArtifactEntry(entry, sourceType) : null);
    }
    if (sourceType === 'omc-session-summary') {
        return buildJsonArtifactEntry(entry, sourceType);
    }
    return null;
}
function findMatchIndex(text, query, caseSensitive) {
    const haystack = normalizeForSearch(text, caseSensitive);
    const needle = normalizeForSearch(query, caseSensitive);
    const directIndex = haystack.indexOf(needle);
    if (directIndex >= 0) {
        return directIndex;
    }
    const terms = needle.split(/\s+/).filter(Boolean);
    if (terms.length === 0)
        return -1;
    if (terms.every((term) => haystack.includes(term))) {
        return haystack.indexOf(terms[0]);
    }
    return -1;
}
function createExcerpt(text, matchIndex, contextChars) {
    const compacted = compactWhitespace(text);
    if (compacted.length <= contextChars * 2) {
        return compacted;
    }
    const safeIndex = Math.max(0, matchIndex);
    const start = Math.max(0, safeIndex - contextChars);
    const end = Math.min(compacted.length, safeIndex + contextChars);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < compacted.length ? '…' : '';
    return `${prefix}${compacted.slice(start, end).trim()}${suffix}`;
}
function buildScopeMode(project) {
    if (!project || project === 'current')
        return 'current';
    if (project === 'all')
        return 'all';
    return 'project';
}
async function collectMatchesFromFile(target, options) {
    const matches = [];
    const fileMtime = existsSync(target.filePath) ? statSync(target.filePath).mtimeMs : 0;
    if (target.sourceType === 'omc-session-summary' && target.filePath.endsWith('.json')) {
        try {
            const payload = JSON.parse(await import('fs/promises').then((fs) => fs.readFile(target.filePath, 'utf-8')));
            const entry = buildSearchableEntry(payload, target.sourceType);
            if (!entry)
                return [];
            if (options.sessionId && entry.sessionId !== options.sessionId)
                return [];
            if (options.projectRoots && options.projectRoots.length > 0 && !isWithinProject(entry.projectPath, options.projectRoots))
                return [];
            if (!matchesProjectFilter(entry.projectPath, options.projectFilter))
                return [];
            const entryEpoch = entry.timestamp ? Date.parse(entry.timestamp) : fileMtime;
            if (options.sinceEpoch && Number.isFinite(entryEpoch) && entryEpoch < options.sinceEpoch)
                return [];
            for (const text of entry.texts) {
                const matchIndex = findMatchIndex(text, options.query, options.caseSensitive);
                if (matchIndex < 0)
                    continue;
                matches.push({
                    sessionId: entry.sessionId,
                    timestamp: entry.timestamp,
                    projectPath: entry.projectPath,
                    sourcePath: target.filePath,
                    sourceType: target.sourceType,
                    line: 1,
                    role: entry.role,
                    entryType: entry.entryType,
                    excerpt: createExcerpt(text, matchIndex, options.contextChars),
                });
                break;
            }
        }
        catch {
            return [];
        }
        return matches;
    }
    const stream = createReadStream(target.filePath, { encoding: 'utf-8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0;
    try {
        for await (const rawLine of reader) {
            line += 1;
            if (!rawLine.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(rawLine);
            }
            catch {
                continue;
            }
            const entry = buildSearchableEntry(parsed, target.sourceType);
            if (!entry)
                continue;
            if (options.sessionId && entry.sessionId !== options.sessionId)
                continue;
            if (options.projectRoots && options.projectRoots.length > 0 && !isWithinProject(entry.projectPath, options.projectRoots))
                continue;
            if (!matchesProjectFilter(entry.projectPath, options.projectFilter))
                continue;
            const entryEpoch = entry.timestamp ? Date.parse(entry.timestamp) : fileMtime;
            if (options.sinceEpoch && Number.isFinite(entryEpoch) && entryEpoch < options.sinceEpoch)
                continue;
            for (const text of entry.texts) {
                const matchIndex = findMatchIndex(text, options.query, options.caseSensitive);
                if (matchIndex < 0)
                    continue;
                matches.push({
                    sessionId: entry.sessionId,
                    agentId: entry.agentId,
                    timestamp: entry.timestamp,
                    projectPath: entry.projectPath,
                    sourcePath: target.filePath,
                    sourceType: target.sourceType,
                    line,
                    role: entry.role,
                    entryType: entry.entryType,
                    excerpt: createExcerpt(text, matchIndex, options.contextChars),
                });
                break;
            }
        }
    }
    finally {
        reader.close();
        stream.destroy();
    }
    return matches;
}
export async function searchSessionHistory(rawOptions) {
    const query = compactWhitespace(rawOptions.query || '');
    if (!query) {
        throw new Error('Query cannot be empty');
    }
    if (rawOptions.sessionId) {
        validateSessionId(rawOptions.sessionId);
    }
    const limit = Math.max(1, rawOptions.limit ?? DEFAULT_LIMIT);
    const contextChars = Math.max(20, rawOptions.contextChars ?? DEFAULT_CONTEXT_CHARS);
    const caseSensitive = rawOptions.caseSensitive ?? false;
    const sinceEpoch = parseSinceSpec(rawOptions.since);
    const workingDirectory = validateWorkingDirectory(rawOptions.workingDirectory);
    const currentProjectRoot = resolveToWorktreeRoot(workingDirectory);
    const scopeMode = buildScopeMode(rawOptions.project);
    const projectFilter = scopeMode === 'project' ? rawOptions.project : undefined;
    const currentProjectRoots = [currentProjectRoot]
        .concat(getMainRepoRoot(currentProjectRoot) ?? [])
        .concat(getClaudeWorktreeParent(currentProjectRoot) ?? [])
        .filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);
    const targets = scopeMode === 'all'
        ? buildAllProjectTargets()
        : buildCurrentProjectTargets(currentProjectRoot);
    const allMatches = [];
    for (const target of targets) {
        const fileMatches = await collectMatchesFromFile(target, {
            query,
            caseSensitive,
            contextChars,
            sinceEpoch,
            sessionId: rawOptions.sessionId,
            projectFilter,
            projectRoots: scopeMode === 'current' ? currentProjectRoots : undefined,
        });
        allMatches.push(...fileMatches);
    }
    allMatches.sort((a, b) => {
        const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
        const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
        if (aTime !== bTime)
            return bTime - aTime;
        return a.sourcePath.localeCompare(b.sourcePath);
    });
    return {
        query,
        scope: {
            mode: scopeMode,
            project: rawOptions.project,
            workingDirectory: currentProjectRoot,
            since: rawOptions.since,
            caseSensitive,
        },
        searchedFiles: targets.length,
        totalMatches: allMatches.length,
        results: allMatches.slice(0, limit),
    };
}
export { parseSinceSpec };
//# sourceMappingURL=index.js.map