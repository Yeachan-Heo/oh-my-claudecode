/**
 * Skill Bridge Module
 *
 * Exports a focused API for skill-injector.mjs to use via esbuild bundle.
 * This module bridges the TypeScript learner infrastructure with the standalone hook script.
 *
 * Bundled to: dist/hooks/skill-bridge.cjs
 * Usage: const bridge = require('../dist/hooks/skill-bridge.cjs');
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { OmcPaths } from "../../lib/worktree-paths.js";

// Re-export constants
export const USER_SKILLS_DIR = join(
  homedir(),
  ".claude",
  "skills",
  "omc-learned",
);
export const GLOBAL_SKILLS_DIR = join(homedir(), ".omc", "skills");
export const PROJECT_SKILLS_SUBDIR = OmcPaths.SKILLS;
export const SKILL_EXTENSION = ".md";

/** Session TTL: 1 hour */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Maximum recursion depth for directory traversal */
const MAX_RECURSION_DEPTH = 10;

/** Levenshtein cache size limit */
const LEVENSHTEIN_CACHE_SIZE = 1000;

/** Skill metadata cache TTL in milliseconds (30 seconds) */
const SKILL_CACHE_TTL_MS = 30 * 1000;

// =============================================================================
// Performance Caches
// =============================================================================

/** LRU cache for Levenshtein distance calculations */
const levenshteinCache = new Map<string, number>();

/**
 * Get cached Levenshtein distance or compute and cache it.
 * Uses canonical key ordering to maximize cache hits.
 */
function getCachedLevenshtein(str1: string, str2: string): number {
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
    if (firstKey) levenshteinCache.delete(firstKey);
  }

  levenshteinCache.set(key, result);
  return result;
}

/** Cached skill metadata for faster matching */
interface CachedSkillData {
  path: string;
  name: string;
  triggers: string[];
  triggersLower: string[];
  matching: "exact" | "fuzzy" | undefined;
  content: string;
  scope: "user" | "project";
}

interface CachedSkillEntry {
  skills: CachedSkillData[];
  timestamp: number;
}

/** Skill metadata cache keyed by project root */
let skillMetadataCache: Map<string, CachedSkillEntry> | null = null;

/**
 * Get cached skill metadata or refresh if stale.
 */
function getSkillMetadataCache(projectRoot: string): CachedSkillData[] {
  if (!skillMetadataCache) {
    skillMetadataCache = new Map();
  }

  const cached = skillMetadataCache.get(projectRoot);
  const now = Date.now();

  if (cached && now - cached.timestamp < SKILL_CACHE_TTL_MS) {
    return cached.skills;
  }

  // Refresh cache
  const candidates = findSkillFiles(projectRoot);
  const skills: CachedSkillData[] = [];

  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate.path, "utf-8");
      const parsed = parseSkillFile(content);
      if (!parsed) continue;

      const triggers = parsed.metadata.triggers ?? [];
      if (triggers.length === 0) continue;

      const name =
        parsed.metadata.name || basename(candidate.path, SKILL_EXTENSION);

      skills.push({
        path: candidate.path,
        name,
        triggers,
        triggersLower: triggers.map((t) => t.toLowerCase()),
        matching: parsed.metadata.matching,
        content: parsed.content,
        scope: candidate.scope,
      });
    } catch {
      // Ignore file read errors
    }
  }

  skillMetadataCache.set(projectRoot, { skills, timestamp: now });
  return skills;
}

/**
 * Clear skill metadata cache (for testing).
 */
export function clearSkillMetadataCache(): void {
  skillMetadataCache = null;
}

/**
 * Clear Levenshtein cache (for testing).
 */
export function clearLevenshteinCache(): void {
  levenshteinCache.clear();
}

/** State file path */
const STATE_FILE = `${OmcPaths.STATE}/skill-sessions.json`;

// =============================================================================
// Types
// =============================================================================

export interface SkillFileCandidate {
  path: string;
  realPath: string;
  scope: "user" | "project";
  /** The root directory this skill was found in */
  sourceDir: string;
}

export interface ParseResult {
  metadata: {
    id?: string;
    name?: string;
    description?: string;
    triggers?: string[];
    tags?: string[];
    matching?: "exact" | "fuzzy";
    model?: string;
    agent?: string;
  };
  content: string;
  valid: boolean;
  errors: string[];
}

export interface MatchedSkill {
  path: string;
  name: string;
  content: string;
  score: number;
  scope: "user" | "project";
  triggers: string[];
  matching?: "exact" | "fuzzy";
}

interface SessionState {
  sessions: {
    [sessionId: string]: {
      injectedPaths: string[];
      timestamp: number;
    };
  };
}

// =============================================================================
// Session Cache (File-Based)
// =============================================================================

/**
 * Get state file path for a project.
 */
function getStateFilePath(projectRoot: string): string {
  return join(projectRoot, STATE_FILE);
}

/**
 * Read session state from file.
 */
function readSessionState(projectRoot: string): SessionState {
  const stateFile = getStateFilePath(projectRoot);
  try {
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore read/parse errors
  }
  return { sessions: {} };
}

/**
 * Write session state to file.
 */
function writeSessionState(projectRoot: string, state: SessionState): void {
  const stateFile = getStateFilePath(projectRoot);
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Ignore write errors (non-critical)
  }
}

/**
 * Get paths of skills already injected in this session.
 */
export function getInjectedSkillPaths(
  sessionId: string,
  projectRoot: string,
): string[] {
  const state = readSessionState(projectRoot);
  const session = state.sessions[sessionId];

  if (!session) return [];

  // Check TTL
  if (Date.now() - session.timestamp > SESSION_TTL_MS) {
    return [];
  }

  return session.injectedPaths;
}

/**
 * Mark skills as injected for this session.
 */
export function markSkillsInjected(
  sessionId: string,
  paths: string[],
  projectRoot: string,
): void {
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
function findSkillFilesRecursive(
  dir: string,
  results: string[],
  depth: number = 0,
): void {
  if (!existsSync(dir)) return;
  if (depth > MAX_RECURSION_DEPTH) return;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        findSkillFilesRecursive(fullPath, results, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(SKILL_EXTENSION)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission denied or other errors - silently skip
  }
}

/**
 * Resolve symlinks safely with fallback.
 */
function safeRealpathSync(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Check if a resolved path is within a boundary directory.
 */
function isWithinBoundary(realPath: string, boundary: string): boolean {
  const normalizedReal = realPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const normalizedBoundary = boundary.replace(/\\/g, "/").replace(/\/+/g, "/");
  return (
    normalizedReal === normalizedBoundary ||
    normalizedReal.startsWith(normalizedBoundary + "/")
  );
}

/**
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 * Now supports RECURSIVE discovery (subdirectories included).
 */
export function findSkillFiles(
  projectRoot: string,
  options?: { scope?: "project" | "user" | "all" },
): SkillFileCandidate[] {
  const candidates: SkillFileCandidate[] = [];
  const seenRealPaths = new Set<string>();
  const scope = options?.scope ?? "all";

  // 1. Search project-level skills (higher priority)
  if (scope === "project" || scope === "all") {
    const projectSkillsDir = join(projectRoot, PROJECT_SKILLS_SUBDIR);
    const projectFiles: string[] = [];
    findSkillFilesRecursive(projectSkillsDir, projectFiles);

    for (const filePath of projectFiles) {
      const realPath = safeRealpathSync(filePath);
      if (seenRealPaths.has(realPath)) continue;
      if (!isWithinBoundary(realPath, projectSkillsDir)) continue;
      seenRealPaths.add(realPath);

      candidates.push({
        path: filePath,
        realPath,
        scope: "project",
        sourceDir: projectSkillsDir,
      });
    }
  }

  // 2. Search user-level skills from both directories (lower priority)
  if (scope === "user" || scope === "all") {
    const userDirs = [GLOBAL_SKILLS_DIR, USER_SKILLS_DIR];
    for (const userDir of userDirs) {
      const userFiles: string[] = [];
      findSkillFilesRecursive(userDir, userFiles);

      for (const filePath of userFiles) {
        const realPath = safeRealpathSync(filePath);
        if (seenRealPaths.has(realPath)) continue;
        if (!isWithinBoundary(realPath, userDir)) continue;
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
export function parseSkillFile(content: string): ParseResult | null {
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
  const errors: string[] = [];

  try {
    const metadata = parseYamlMetadata(yamlContent);
    return {
      metadata,
      content: body,
      valid: true,
      errors,
    };
  } catch (e) {
    return {
      metadata: {},
      content: body,
      valid: false,
      errors: [`YAML parse error: ${e}`],
    };
  }
}

/**
 * Simple YAML parser for skill frontmatter.
 * Handles: id, name, description, triggers, tags, matching, model, agent
 */
function parseYamlMetadata(yamlContent: string): ParseResult["metadata"] {
  const lines = yamlContent.split("\n");
  const metadata: ParseResult["metadata"] = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIndex = line.indexOf(":");

    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    switch (key) {
      case "id":
        metadata.id = parseStringValue(rawValue);
        break;
      case "name":
        metadata.name = parseStringValue(rawValue);
        break;
      case "description":
        metadata.description = parseStringValue(rawValue);
        break;
      case "model":
        metadata.model = parseStringValue(rawValue);
        break;
      case "agent":
        metadata.agent = parseStringValue(rawValue);
        break;
      case "matching":
        metadata.matching = parseStringValue(rawValue) as "exact" | "fuzzy";
        break;
      case "triggers":
      case "tags": {
        const { value, consumed } = parseArrayValue(rawValue, lines, i);
        if (key === "triggers") {
          metadata.triggers = Array.isArray(value)
            ? value
            : value
              ? [value]
              : [];
        } else {
          metadata.tags = Array.isArray(value) ? value : value ? [value] : [];
        }
        i += consumed - 1;
        break;
      }
    }

    i++;
  }

  return metadata;
}

function parseStringValue(value: string): string {
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArrayValue(
  rawValue: string,
  lines: string[],
  currentIndex: number,
): { value: string | string[]; consumed: number } {
  // Inline array: ["a", "b"]
  if (rawValue.startsWith("[")) {
    const endIdx = rawValue.lastIndexOf("]");
    if (endIdx === -1) return { value: [], consumed: 1 };
    const content = rawValue.slice(1, endIdx).trim();
    if (!content) return { value: [], consumed: 1 };

    const items = content
      .split(",")
      .map((s) => parseStringValue(s.trim()))
      .filter(Boolean);
    return { value: items, consumed: 1 };
  }

  // Multi-line array
  if (!rawValue || rawValue === "") {
    const items: string[] = [];
    let consumed = 1;

    for (let j = currentIndex + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      const arrayMatch = nextLine.match(/^\s+-\s*(.*)$/);

      if (arrayMatch) {
        const itemValue = parseStringValue(arrayMatch[1].trim());
        if (itemValue) items.push(itemValue);
        consumed++;
      } else if (nextLine.trim() === "") {
        consumed++;
      } else {
        break;
      }
    }

    if (items.length > 0) {
      return { value: items, consumed };
    }
  }

  // Single value
  return { value: parseStringValue(rawValue), consumed: 1 };
}

// =============================================================================
// Matching
// =============================================================================

/**
 * Calculate Levenshtein distance using O(n) space with 2 rows.
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Optimize by making n the smaller dimension
  if (m < n) {
    return levenshteinDistance(str2, str1);
  }

  // Use 2 rows instead of full matrix for O(n) space
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
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
function fuzzyMatchTrigger(prompt: string, trigger: string): number {
  const words = prompt.split(/\s+/).filter((w) => w.length > 0);

  // Exact word match
  for (const word of words) {
    if (word === trigger) return 100;
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
export function matchSkillsForInjection(
  prompt: string,
  projectRoot: string,
  sessionId: string,
  options: { fuzzyThreshold?: number; maxResults?: number } = {},
): MatchedSkill[] {
  const { fuzzyThreshold = 60, maxResults = 5 } = options;
  const promptLower = prompt.toLowerCase();

  const alreadyInjected = new Set(
    getInjectedSkillPaths(sessionId, projectRoot),
  );

  // Use cached skill metadata instead of re-reading files each time
  const cachedSkills = getSkillMetadataCache(projectRoot);
  const matches: MatchedSkill[] = [];

  for (const skill of cachedSkills) {
    if (alreadyInjected.has(skill.path)) continue;

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
