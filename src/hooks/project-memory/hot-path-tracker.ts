/**
 * Hot Path Tracker
 * Tracks frequently accessed files and directories
 */

import path from "path";
import { HotPath, ProjectMemoryContext } from "./types.js";

const MAX_HOT_PATHS = 50;
// Counts halve per idle day, so a file hammered weeks ago cannot outrank today's work forever.
const ACCESS_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/**
 * Track file or directory access
 */
export function trackAccess(
  hotPaths: HotPath[] | null | undefined,
  filePath: string,
  projectRoot: string,
  type: "file" | "directory",
): HotPath[] {
  // path.relative() returns the platform separator (backslashes on Windows).
  // Store hot paths with forward slashes so the persisted data, the rendered
  // output, and the scope-affinity comparison are identical on every OS
  // (a no-op on POSIX, where paths already use forward slashes).
  const relativePath = (
    path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath
  ).replace(/\\/g, "/");

  const normalizedHotPaths = ensureHotPathList(hotPaths);
  const now = Date.now();

  if (relativePath.startsWith("..") || shouldIgnorePath(relativePath)) {
    return normalizedHotPaths;
  }

  const existing = normalizedHotPaths.find((hp) => hp.path === relativePath);

  if (existing) {
    // Fold idle decay into the stored count, so one touch cannot revive a count built weeks ago.
    existing.accessCount = weightedAccessCount(existing, now) + 1;
    existing.lastAccessed = now;
    return normalizedHotPaths;
  }

  // Evict the least recently touched before adding, so files of the current work can build up counts.
  // On a tie the earliest added goes, so a new file never evicts the one added just before it.
  while (normalizedHotPaths.length >= MAX_HOT_PATHS) {
    const oldest = normalizedHotPaths.reduce(
      (min, hp, i) => (hp.lastAccessed < normalizedHotPaths[min].lastAccessed ? i : min),
      0,
    );
    normalizedHotPaths.splice(oldest, 1);
  }
  normalizedHotPaths.push({
    path: relativePath,
    accessCount: 1,
    lastAccessed: now,
    type,
  });
  return normalizedHotPaths;
}


function ensureHotPathList(hotPaths: HotPath[] | null | undefined): HotPath[] {
  return Array.isArray(hotPaths) ? hotPaths : [];
}

function shouldIgnorePath(relativePath: string): boolean {
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
export function getTopHotPaths(
  hotPaths: HotPath[] | null | undefined,
  limit: number = 10,
  context?: ProjectMemoryContext,
): HotPath[] {
  const now = context?.now ?? Date.now();
  const scopePath = normalizeScopePath(context?.workingDirectory);

  return ensureHotPathList(hotPaths)
    .filter((hp) => !shouldIgnorePath(hp.path))
    .sort(
      (a, b) =>
        scoreHotPath(b, scopePath, now) - scoreHotPath(a, scopePath, now),
    )
    .slice(0, limit)
    .map((hp) => ({ ...hp, accessCount: weightedAccessCount(hp, now) }));
}

/**
 * Decay old hot paths (reduce access count over time)
 */
export function decayHotPaths(hotPaths: HotPath[] | null | undefined): HotPath[] {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;

  return ensureHotPathList(hotPaths)
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

function weightedAccessCount(hotPath: HotPath, now: number): number {
  const idleMs = Math.max(0, now - hotPath.lastAccessed);
  return hotPath.accessCount * 0.5 ** (idleMs / ACCESS_HALF_LIFE_MS);
}

function scoreHotPath(
  hotPath: HotPath,
  scopePath: string | null,
  now: number,
): number {
  const ageMs = Math.max(0, now - hotPath.lastAccessed);
  const recencyScore = Math.max(0, 120 - Math.floor(ageMs / (60 * 60 * 1000)));
  const accessScore = weightedAccessCount(hotPath, now) * 10;
  const typeBonus = hotPath.type === "file" ? 6 : 3;
  const scopeBonus = getScopeAffinityScore(hotPath.path, scopePath);

  return accessScore + recencyScore + typeBonus + scopeBonus;
}

function getScopeAffinityScore(
  hotPath: string,
  scopePath: string | null,
): number {
  if (!scopePath || scopePath === "." || scopePath.length === 0) {
    return 0;
  }

  // hotPath is stored from path.relative(), which uses the platform separator
  // (backslashes on Windows), while scopePath is already normalized to forward
  // slashes by normalizeScopePath(). Normalize the separators so the comparisons
  // below match on every OS (a no-op on POSIX).
  const normalizedHotPath = hotPath.replace(/\\/g, "/");

  if (normalizedHotPath === scopePath) {
    return 400;
  }

  if (normalizedHotPath.startsWith(`${scopePath}/`)) {
    return 320;
  }

  if (scopePath.startsWith(`${normalizedHotPath}/`)) {
    return 220;
  }

  const hotSegments = normalizedHotPath.split("/");
  const scopeSegments = scopePath.split("/");
  let sharedSegments = 0;

  while (
    sharedSegments < hotSegments.length &&
    sharedSegments < scopeSegments.length &&
    hotSegments[sharedSegments] === scopeSegments[sharedSegments]
  ) {
    sharedSegments++;
  }

  return sharedSegments * 60;
}

function normalizeScopePath(workingDirectory?: string): string | null {
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
