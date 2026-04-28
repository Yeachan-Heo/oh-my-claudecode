/**
 * Skill Bridge Module
 *
 * Exports a focused API for skill-injector.mjs to use via esbuild bundle.
 * This module bridges the TypeScript learner infrastructure with the standalone hook script.
 *
 * Bundled to: dist/hooks/skill-bridge.cjs
 * Usage: const bridge = require('../dist/hooks/skill-bridge.cjs');
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { OmcPaths } from "../../lib/worktree-paths.js";
import { parseYamlMetadata } from "./parser.js";
import { expandTriggers } from "./transliteration-map.js";
// Re-export constants
export const USER_SKILLS_DIR = join(homedir(), ".claude", "skills", "omc-learned");
export const GLOBAL_SKILLS_DIR = join(homedir(), ".omc", "skills");
export const PROJECT_SKILLS_SUBDIR = OmcPaths.SKILLS;
export const PROJECT_AGENT_SKILLS_SUBDIR = join(".agents", "skills");
export const SKILL_EXTENSION = ".md";
/** Session TTL: 1 hour */
const SESSION_TTL_MS = 60 * 60 * 1000;
/** Maximum recursion depth for directory traversal */
const MAX_RECURSION_DEPTH = 10;
/** Levenshtein cache size limit */
const LEVENSHTEIN_CACHE_SIZE = 1000;
/** Skill metadata cache TTL in milliseconds (30 seconds) */
const SKILL_CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 50;
// =============================================================================
// Performance Caches
// =============================================================================
/** LRU cache for Levenshtein distance calculations */
const levenshteinCache = new Map();
/**
 * Get cached Levenshtein distance or compute and cache it.
 * Uses canonical key ordering to maximize cache hits.
 */
function getCachedLevenshtein(str1, str2) {
    const key = str1 < str2 ? `${str1}|${str2}` : `${str2}|${str1}`;
    const cached = levenshteinCache.get(key);
    if (cached !== undefined) {
        levenshteinCache.delete(key);
        levenshteinCache.set(key, cached);
        return cached;
    }
    const result = levenshteinDistance(str1, str2);
    if (levenshteinCache.size >= LEVENSHTEIN_CACHE_SIZE) {
        const firstKey = levenshteinCache.keys().next().value;
        if (firstKey)
            levenshteinCache.delete(firstKey);
    }
    levenshteinCache.set(key, result);
    return result;
}
/** Skill metadata cache keyed by project root */
let skillMetadataCache = null;
/**
 * Get cached skill metadata or refresh if stale.
 */
function getSkillMetadataCache(projectRoot) {
    if (!skillMetadataCache) {
        skillMetadataCache = new Map();
    }
    const cached = skillMetadataCache.get(projectRoot);
    const now = Date.now();
    if (cached && now - cached.timestamp < SKILL_CACHE_TTL_MS) {
        skillMetadataCache.delete(projectRoot);
        skillMetadataCache.set(projectRoot, cached);
        return cached.skills;
    }
    // Refresh cache
    const candidates = findSkillFiles(projectRoot);
    const skills = [];
    for (const candidate of candidates) {
        try {
            const content = readFileSync(candidate.path, "utf-8");
            const parsed = parseSkillFile(content);
            if (!parsed)
                continue;
            const triggers = (parsed.metadata.triggers ?? [])
                .map((trigger) => trigger.trim())
                .filter(Boolean);
            if (triggers.length === 0)
                continue;
            const name = parsed.metadata.name || basename(candidate.path, SKILL_EXTENSION);
            skills.push({
                path: candidate.path,
                name,
                triggers,
                triggersLower: expandTriggers(triggers.map((t) => t.toLowerCase())),
                matching: parsed.metadata.matching,
                content: parsed.content,
                description: parsed.metadata.description,
                summary: summarizeSkillContent(parsed.content),
                scope: candidate.scope,
            });
        }
        catch {
            // Ignore file read errors
        }
    }
    if (skillMetadataCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = skillMetadataCache.keys().next().value;
        if (firstKey !== undefined)
            skillMetadataCache.delete(firstKey);
    }
    skillMetadataCache.set(projectRoot, { skills, timestamp: now });
    return skills;
}
/**
 * Clear skill metadata cache (for testing).
 */
export function clearSkillMetadataCache() {
    skillMetadataCache = null;
}
/**
 * Clear Levenshtein cache (for testing).
 */
export function clearLevenshteinCache() {
    levenshteinCache.clear();
}
function summarizeSkillContent(content) {
    const firstUsefulLine = content
        .split(/\r?\n/)
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .find((line) => line && !line.startsWith("---"));
    return (firstUsefulLine || content.replace(/\s+/g, " ").trim()).slice(0, 240);
}
/** State file path */
const STATE_FILE = `${OmcPaths.STATE}/skill-sessions.json`;
// =============================================================================
// Session Cache (File-Based)
// =============================================================================
/**
 * Get state file path for a project.
 */
function getStateFilePath(projectRoot) {
    return join(projectRoot, STATE_FILE);
}
/**
 * Read session state from file.
 */
function readSessionState(projectRoot) {
    const stateFile = getStateFilePath(projectRoot);
    try {
        if (existsSync(stateFile)) {
            const content = readFileSync(stateFile, "utf-8");
            return JSON.parse(content);
        }
    }
    catch {
        // Ignore read/parse errors
    }
    return { sessions: {} };
}
/**
 * Write session state to file.
 */
function writeSessionState(projectRoot, state) {
    const stateFile = getStateFilePath(projectRoot);
    try {
        mkdirSync(dirname(stateFile), { recursive: true });
        writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
    }
    catch {
        // Ignore write errors (non-critical)
    }
}
/**
 * Get paths of skills already injected in this session.
 */
export function getInjectedSkillPaths(sessionId, projectRoot) {
    const state = readSessionState(projectRoot);
    const session = state.sessions[sessionId];
    if (!session)
        return [];
    // Check TTL
    if (Date.now() - session.timestamp > SESSION_TTL_MS) {
        return [];
    }
    return session.injectedPaths;
}
/**
 * Mark skills as injected for this session.
 */
export function markSkillsInjected(sessionId, paths, projectRoot) {
    const state = readSessionState(projectRoot);
    const now = Date.now();
    // Prune expired sessions
    for (const [id, session] of Object.entries(state.sessions)) {
        if (now - session.timestamp > SESSION_TTL_MS) {
            delete state.sessions[id];
        }
    }
    // Get existing paths for this session
    const existing = state.sessions[sessionId]?.injectedPaths ?? [];
    // Merge with new paths (dedupe)
    state.sessions[sessionId] = {
        injectedPaths: [...new Set([...existing, ...paths])],
        timestamp: now,
    };
    writeSessionState(projectRoot, state);
}
// =============================================================================
// File Discovery (Recursive)
// =============================================================================
/**
 * Recursively find all skill files in a directory.
 */
function findSkillFilesRecursive(dir, results, depth = 0) {
    if (!existsSync(dir))
        return;
    if (depth > MAX_RECURSION_DEPTH)
        return;
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                findSkillFilesRecursive(fullPath, results, depth + 1);
            }
            else if (entry.isFile() && entry.name.endsWith(SKILL_EXTENSION)) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // Permission denied or other errors - silently skip
    }
}
/**
 * Resolve symlinks safely with fallback.
 */
function safeRealpathSync(filePath) {
    try {
        return realpathSync(filePath);
    }
    catch {
        return filePath;
    }
}
/**
 * Check if a resolved path is within a boundary directory.
 */
function isWithinBoundary(realPath, boundary) {
    const normalizedReal = safeRealpathSync(realPath)
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/");
    const normalizedBoundary = safeRealpathSync(boundary)
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/");
    return (normalizedReal === normalizedBoundary ||
        normalizedReal.startsWith(normalizedBoundary + "/"));
}
/**
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 * Now supports RECURSIVE discovery (subdirectories included).
 */
export function findSkillFiles(projectRoot, options) {
    const candidates = [];
    const seenRealPaths = new Set();
    const scope = options?.scope ?? "all";
    // 1. Search project-level skills (higher priority)
    if (scope === "project" || scope === "all") {
        const projectSkillDirs = [
            join(projectRoot, PROJECT_SKILLS_SUBDIR),
            join(projectRoot, PROJECT_AGENT_SKILLS_SUBDIR),
        ];
        for (const projectSkillsDir of projectSkillDirs) {
            const projectFiles = [];
            findSkillFilesRecursive(projectSkillsDir, projectFiles);
            for (const filePath of projectFiles) {
                const realPath = safeRealpathSync(filePath);
                if (seenRealPaths.has(realPath))
                    continue;
                if (!isWithinBoundary(realPath, projectSkillsDir))
                    continue;
                seenRealPaths.add(realPath);
                candidates.push({
                    path: filePath,
                    realPath,
                    scope: "project",
                    sourceDir: projectSkillsDir,
                });
            }
        }
    }
    // 2. Search user-level skills from both directories (lower priority)
    if (scope === "user" || scope === "all") {
        const userDirs = [GLOBAL_SKILLS_DIR, USER_SKILLS_DIR];
        for (const userDir of userDirs) {
            const userFiles = [];
            findSkillFilesRecursive(userDir, userFiles);
            for (const filePath of userFiles) {
                const realPath = safeRealpathSync(filePath);
                if (seenRealPaths.has(realPath))
                    continue;
                if (!isWithinBoundary(realPath, userDir))
                    continue;
                seenRealPaths.add(realPath);
                candidates.push({
                    path: filePath,
                    realPath,
                    scope: "user",
                    sourceDir: userDir,
                });
            }
        }
    }
    return candidates;
}
// =============================================================================
// Parsing
// =============================================================================
/**
 * Parse YAML frontmatter and content from a skill file.
 */
export function parseSkillFile(content) {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);
    if (!match) {
        // No frontmatter - still valid, use filename as name
        return {
            metadata: {},
            content: content.trim(),
            valid: true,
            errors: [],
        };
    }
    const yamlContent = match[1];
    const body = match[2].trim();
    const errors = [];
    try {
        const metadata = parseYamlMetadata(yamlContent);
        return {
            metadata,
            content: body,
            valid: true,
            errors,
        };
    }
    catch (e) {
        return {
            metadata: {},
            content: body,
            valid: false,
            errors: [`YAML parse error: ${e}`],
        };
    }
}
// =============================================================================
// Matching
// =============================================================================
/**
 * Calculate Levenshtein distance using O(n) space with 2 rows.
 */
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    // Optimize by making n the smaller dimension
    if (m < n) {
        return levenshteinDistance(str2, str1);
    }
    // Use 2 rows instead of full matrix for O(n) space
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                curr[j] = prev[j - 1];
            }
            else {
                curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
            }
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
/**
 * Fuzzy match a trigger against prompt text.
 * Returns confidence score 0-100.
 */
function fuzzyMatchTrigger(prompt, trigger) {
    const words = prompt.split(/\s+/).filter((w) => w.length > 0);
    // Exact word match
    for (const word of words) {
        if (word === trigger)
            return 100;
        if (word.includes(trigger) || trigger.includes(word)) {
            return 80;
        }
    }
    let bestScore = 0;
    for (const word of words) {
        const distance = getCachedLevenshtein(word, trigger);
        const maxLen = Math.max(word.length, trigger.length);
        const similarity = maxLen > 0 ? ((maxLen - distance) / maxLen) * 100 : 0;
        bestScore = Math.max(bestScore, similarity);
    }
    return Math.round(bestScore);
}
/**
 * Find matching skills for injection based on prompt triggers.
 *
 * Options:
 * - fuzzyThreshold: minimum score for fuzzy match (default: 60)
 * - maxResults: maximum skills to return (default: 5)
 */
export function matchSkillsForInjection(prompt, projectRoot, sessionId, options = {}) {
    const { fuzzyThreshold = 60, maxResults = 5 } = options;
    const promptLower = prompt.toLowerCase();
    const alreadyInjected = new Set(getInjectedSkillPaths(sessionId, projectRoot));
    // Use cached skill metadata instead of re-reading files each time
    const cachedSkills = getSkillMetadataCache(projectRoot);
    const matches = [];
    for (const skill of cachedSkills) {
        if (alreadyInjected.has(skill.path))
            continue;
        const useFuzzy = skill.matching === "fuzzy";
        let totalScore = 0;
        for (const triggerLower of skill.triggersLower) {
            if (promptLower.includes(triggerLower)) {
                totalScore += 10;
                continue;
            }
            if (useFuzzy) {
                const fuzzyScore = fuzzyMatchTrigger(promptLower, triggerLower);
                if (fuzzyScore >= fuzzyThreshold) {
                    totalScore += Math.round(fuzzyScore / 10);
                }
            }
        }
        if (totalScore > 0) {
            matches.push({
                path: skill.path,
                name: skill.name,
                content: skill.content,
                description: skill.description,
                summary: skill.summary,
                score: totalScore,
                scope: skill.scope,
                triggers: skill.triggers,
                matching: skill.matching,
            });
        }
    }
    // Sort by score (descending) and limit
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, maxResults);
}
//# sourceMappingURL=bridge.js.map