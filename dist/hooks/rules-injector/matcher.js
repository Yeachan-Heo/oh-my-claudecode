/**
 * Rules Matcher
 *
 * Matches rules against file paths using glob patterns.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import { createHash } from 'crypto';
import { relative } from 'path';
/**
 * Simple glob pattern matcher.
 * Supports basic patterns like *.ts, **\/*.js, src/**\/*.py
 */
function matchGlob(pattern, filePath) {
    // Convert glob pattern to regex
    const regexStr = pattern
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*\*/g, '<<<GLOBSTAR>>>') // Temporarily replace **
        .replace(/\*/g, '[^/]*') // * matches any characters except /
        .replace(/<<<GLOBSTAR>>>/g, '.*') // ** matches anything including /
        .replace(/\?/g, '.'); // ? matches single character
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filePath);
}
/**
 * Check if a rule should apply to the current file based on metadata.
 */
export function shouldApplyRule(metadata, currentFilePath, projectRoot) {
    if (metadata.alwaysApply === true) {
        return { applies: true, reason: 'alwaysApply' };
    }
    const globs = metadata.globs;
    if (!globs) {
        return { applies: false };
    }
    const patterns = Array.isArray(globs) ? globs : [globs];
    if (patterns.length === 0) {
        return { applies: false };
    }
    const relativePath = projectRoot
        ? relative(projectRoot, currentFilePath)
        : currentFilePath;
    // Normalize path separators to forward slashes for matching
    const normalizedPath = relativePath.replace(/\\/g, '/');
    for (const pattern of patterns) {
        if (matchGlob(pattern, normalizedPath)) {
            return { applies: true, reason: `glob: ${pattern}` };
        }
    }
    return { applies: false };
}
/**
 * Check if realPath already exists in cache (symlink deduplication).
 */
export function isDuplicateByRealPath(realPath, cache) {
    return cache.has(realPath);
}
/**
 * Create SHA-256 hash of content, truncated to 16 chars.
 */
export function createContentHash(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
/**
 * Check if content hash already exists in cache.
 */
export function isDuplicateByContentHash(hash, cache) {
    return cache.has(hash);
}
//# sourceMappingURL=matcher.js.map