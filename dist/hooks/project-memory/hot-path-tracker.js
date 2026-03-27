/**
 * Hot Path Tracker
 * Tracks frequently accessed files and directories
 */
import path from "path";
const MAX_HOT_PATHS = 50;
/**
 * Track file or directory access
 */
export function trackAccess(hotPaths, filePath, projectRoot, type) {
    const relativePath = path.isAbsolute(filePath)
        ? path.relative(projectRoot, filePath)
        : filePath;
    if (relativePath.startsWith("..") || shouldIgnorePath(relativePath)) {
        return hotPaths;
    }
    const existing = hotPaths.find((hp) => hp.path === relativePath);
    if (existing) {
        existing.accessCount++;
        existing.lastAccessed = Date.now();
    }
    else {
        hotPaths.push({
            path: relativePath,
            accessCount: 1,
            lastAccessed: Date.now(),
            type,
        });
    }
    hotPaths.sort((a, b) => b.accessCount - a.accessCount);
    if (hotPaths.length > MAX_HOT_PATHS) {
        hotPaths.splice(MAX_HOT_PATHS);
    }
    return hotPaths;
}
function shouldIgnorePath(relativePath) {
    const ignorePatterns = [
        "node_modules",
        ".git",
        ".omc",
        "dist",
        "build",
        ".cache",
        ".next",
        ".nuxt",
        "coverage",
        ".DS_Store",
    ];
    return ignorePatterns.some((pattern) => relativePath.includes(pattern));
}
/**
 * Get top hot paths for display
 */
export function getTopHotPaths(hotPaths, limit = 10, context) {
    const now = context?.now ?? Date.now();
    const scopePath = normalizeScopePath(context?.workingDirectory);
    return [...hotPaths]
        .filter((hp) => !shouldIgnorePath(hp.path))
        .sort((a, b) => scoreHotPath(b, scopePath, now) - scoreHotPath(a, scopePath, now))
        .slice(0, limit);
}
/**
 * Decay old hot paths (reduce access count over time)
 */
export function decayHotPaths(hotPaths) {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;
    return hotPaths
        .map((hp) => {
        const age = now - hp.lastAccessed;
        if (age > dayInMs * 7) {
            return {
                ...hp,
                accessCount: Math.max(1, Math.floor(hp.accessCount / 2)),
            };
        }
        return hp;
    })
        .filter((hp) => hp.accessCount > 0);
}
function scoreHotPath(hotPath, scopePath, now) {
    const ageMs = Math.max(0, now - hotPath.lastAccessed);
    const recencyScore = Math.max(0, 120 - Math.floor(ageMs / (60 * 60 * 1000)));
    const accessScore = hotPath.accessCount * 10;
    const typeBonus = hotPath.type === "file" ? 6 : 3;
    const scopeBonus = getScopeAffinityScore(hotPath.path, scopePath);
    return accessScore + recencyScore + typeBonus + scopeBonus;
}
function getScopeAffinityScore(hotPath, scopePath) {
    if (!scopePath || scopePath === "." || scopePath.length === 0) {
        return 0;
    }
    if (hotPath === scopePath) {
        return 400;
    }
    if (hotPath.startsWith(`${scopePath}/`)) {
        return 320;
    }
    if (scopePath.startsWith(`${hotPath}/`)) {
        return 220;
    }
    const hotSegments = hotPath.split("/");
    const scopeSegments = scopePath.split("/");
    let sharedSegments = 0;
    while (sharedSegments < hotSegments.length &&
        sharedSegments < scopeSegments.length &&
        hotSegments[sharedSegments] === scopeSegments[sharedSegments]) {
        sharedSegments++;
    }
    return sharedSegments * 60;
}
function normalizeScopePath(workingDirectory) {
    if (!workingDirectory) {
        return null;
    }
    const normalized = path
        .normalize(workingDirectory)
        .replace(/^\.[/\\]?/, "")
        .replace(/\\/g, "/");
    if (normalized === "" || normalized === ".") {
        return null;
    }
    return normalized;
}
//# sourceMappingURL=hot-path-tracker.js.map