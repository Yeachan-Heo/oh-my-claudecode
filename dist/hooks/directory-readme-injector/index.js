/**
 * Directory README Injector Hook
 *
 * Automatically injects relevant README content from directories when files are accessed.
 * Walks up the directory tree from accessed files to find and inject README.md files.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 * Adapted for Claude Code's shell hook system.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadInjectedPaths, saveInjectedPaths, clearInjectedPaths, } from './storage.js';
import { README_FILENAME, TRACKED_TOOLS } from './constants.js';
// Re-export submodules
export * from './types.js';
export * from './constants.js';
export * from './storage.js';
/**
 * Simple token estimation (4 chars per token)
 */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_README_TOKENS = 5000;
/**
 * Simple truncation for README content
 */
function truncateContent(content, maxTokens = DEFAULT_MAX_README_TOKENS) {
    const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
    if (estimatedTokens <= maxTokens) {
        return { result: content, truncated: false };
    }
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const truncated = content.slice(0, maxChars);
    return {
        result: truncated,
        truncated: true,
    };
}
/**
 * Create directory README injector hook for Claude Code.
 *
 * @param workingDirectory - The working directory for resolving paths
 * @returns Hook handlers for tool execution
 */
export function createDirectoryReadmeInjectorHook(workingDirectory) {
    const sessionCaches = new Map();
    function getSessionCache(sessionID) {
        if (!sessionCaches.has(sessionID)) {
            sessionCaches.set(sessionID, loadInjectedPaths(sessionID));
        }
        return sessionCaches.get(sessionID);
    }
    function resolveFilePath(filePath) {
        if (!filePath)
            return null;
        if (isAbsolute(filePath))
            return filePath;
        return resolve(workingDirectory, filePath);
    }
    /**
     * Find README.md files by walking up the directory tree.
     * Returns paths in order from root to leaf.
     */
    function findReadmeMdUp(startDir) {
        const found = [];
        let current = startDir;
        while (true) {
            const readmePath = join(current, README_FILENAME);
            if (existsSync(readmePath)) {
                found.push(readmePath);
            }
            // Stop at working directory root
            if (current === workingDirectory)
                break;
            const parent = dirname(current);
            // Stop at filesystem root
            if (parent === current)
                break;
            // Stop if we've gone outside the working directory
            if (!parent.startsWith(workingDirectory))
                break;
            current = parent;
        }
        // Return in order from root to leaf (reverse the array)
        return found.reverse();
    }
    /**
     * Process a file path and return README content to inject.
     */
    function processFilePathForReadmes(filePath, sessionID) {
        const resolved = resolveFilePath(filePath);
        if (!resolved)
            return '';
        const dir = dirname(resolved);
        const cache = getSessionCache(sessionID);
        const readmePaths = findReadmeMdUp(dir);
        let output = '';
        for (const readmePath of readmePaths) {
            const readmeDir = dirname(readmePath);
            if (cache.has(readmeDir))
                continue;
            try {
                const content = readFileSync(readmePath, 'utf-8');
                const { result, truncated } = truncateContent(content);
                const truncationNotice = truncated
                    ? `\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: ${readmePath}]`
                    : '';
                output += `\n\n[Project README: ${readmePath}]\n${result}${truncationNotice}`;
                cache.add(readmeDir);
            }
            catch {
                // Skip files that can't be read
            }
        }
        if (output) {
            saveInjectedPaths(sessionID, cache);
        }
        return output;
    }
    return {
        /**
         * Process a tool execution and inject READMEs if relevant.
         */
        processToolExecution: (toolName, filePath, sessionID) => {
            if (!TRACKED_TOOLS.includes(toolName.toLowerCase())) {
                return '';
            }
            return processFilePathForReadmes(filePath, sessionID);
        },
        /**
         * Get READMEs for a specific file without marking as injected.
         */
        getReadmesForFile: (filePath) => {
            const resolved = resolveFilePath(filePath);
            if (!resolved)
                return [];
            const dir = dirname(resolved);
            return findReadmeMdUp(dir);
        },
        /**
         * Clear session cache when session ends.
         */
        clearSession: (sessionID) => {
            sessionCaches.delete(sessionID);
            clearInjectedPaths(sessionID);
        },
        /**
         * Check if a tool triggers README injection.
         */
        isTrackedTool: (toolName) => {
            return TRACKED_TOOLS.includes(toolName.toLowerCase());
        },
    };
}
/**
 * Get README paths for a file (simple utility function).
 */
export function getReadmesForPath(filePath, workingDirectory) {
    const cwd = workingDirectory || process.cwd();
    const hook = createDirectoryReadmeInjectorHook(cwd);
    return hook.getReadmesForFile(filePath);
}
//# sourceMappingURL=index.js.map