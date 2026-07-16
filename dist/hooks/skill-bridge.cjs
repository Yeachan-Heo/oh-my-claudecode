"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/hooks/learner/bridge.ts
var bridge_exports = {};
__export(bridge_exports, {
  GLOBAL_SKILLS_DIR: () => GLOBAL_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_SUBDIR: () => PROJECT_AGENT_SKILLS_SUBDIR,
  PROJECT_SKILLS_SUBDIR: () => PROJECT_SKILLS_SUBDIR,
  SKILL_EXTENSION: () => SKILL_EXTENSION,
  USER_SKILLS_DIR: () => USER_SKILLS_DIR,
  clearLevenshteinCache: () => clearLevenshteinCache,
  clearSkillMetadataCache: () => clearSkillMetadataCache,
  findSkillFiles: () => findSkillFiles,
  getInjectedSkillPaths: () => getInjectedSkillPaths,
  markSkillsInjected: () => markSkillsInjected,
  matchSkillsForInjection: () => matchSkillsForInjection,
  parseSkillFile: () => parseSkillFile
});
module.exports = __toCommonJS(bridge_exports);
var import_fs2 = require("fs");
var import_path3 = require("path");
var import_os3 = require("os");

// src/lib/worktree-paths.ts
var import_crypto = require("crypto");
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_os2 = require("os");
var import_path2 = require("path");

// src/utils/config-dir.ts
var import_path = require("path");
var import_os = require("os");

// src/lib/worktree-paths.ts
var WORKSPACE_MARKER = ".omc-workspace";
var OmcPaths = {
  ROOT: ".omc",
  STATE: ".omc/state",
  SESSIONS: ".omc/state/sessions",
  PLANS: ".omc/plans",
  RESEARCH: ".omc/research",
  NOTEPAD: ".omc/notepad.md",
  PROJECT_MEMORY: ".omc/project-memory.json",
  DRAFTS: ".omc/drafts",
  NOTEPADS: ".omc/notepads",
  LOGS: ".omc/logs",
  SCIENTIST: ".omc/scientist",
  AUTOPILOT: ".omc/autopilot",
  SKILLS: ".omc/skills",
  SHARED_MEMORY: ".omc/state/shared-memory",
  DEEPINIT_MANIFEST: ".omc/deepinit-manifest.json"
};
var MAX_WORKTREE_CACHE_SIZE = 8;
var worktreeCacheMap = /* @__PURE__ */ new Map();
var toplevelCacheMap = /* @__PURE__ */ new Map();
var superprojectCacheMap = /* @__PURE__ */ new Map();
var workspaceCacheMap = /* @__PURE__ */ new Map();
function findWorkspaceRoot(startDir) {
  if (process.env.OMC_DISABLE_MULTIREPO === "1") return null;
  const effectiveStart = startDir || process.cwd();
  let current;
  try {
    current = (0, import_path2.resolve)(effectiveStart);
  } catch {
    return null;
  }
  if (workspaceCacheMap.has(current)) {
    const cached = workspaceCacheMap.get(current) ?? null;
    workspaceCacheMap.delete(current);
    workspaceCacheMap.set(current, cached);
    return cached;
  }
  const home = (() => {
    try {
      return (0, import_path2.resolve)((0, import_os2.homedir)());
    } catch {
      return null;
    }
  })();
  let cursor = current;
  let result = null;
  while (true) {
    if (home && cursor === home) break;
    if ((0, import_fs.existsSync)((0, import_path2.join)(cursor, WORKSPACE_MARKER))) {
      result = cursor;
      break;
    }
    const parent = (0, import_path2.dirname)(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (workspaceCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = workspaceCacheMap.keys().next().value;
    if (oldest !== void 0) workspaceCacheMap.delete(oldest);
  }
  workspaceCacheMap.set(current, result);
  return result;
}
function readWorkspaceMarkerConfig(workspaceRoot) {
  try {
    const raw = (0, import_fs.readFileSync)((0, import_path2.join)(workspaceRoot, WORKSPACE_MARKER), "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
function isDefinitiveNonGitError(error) {
  if (!error || typeof error !== "object") return false;
  const { status, stderr } = error;
  if (status !== 128) return false;
  const output = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  return /not a git repository/i.test(output);
}
function resolveSuperprojectRoot(cwd) {
  const cacheKey = (0, import_path2.resolve)(cwd);
  if (superprojectCacheMap.has(cacheKey)) {
    const cached = superprojectCacheMap.get(cacheKey) ?? null;
    superprojectCacheMap.delete(cacheKey);
    superprojectCacheMap.set(cacheKey, cached);
    return cached;
  }
  let anchor = null;
  let probeCwd = cacheKey;
  let completed = false;
  for (let depth = 0; depth < 32; depth++) {
    let superRoot;
    try {
      superRoot = (0, import_child_process.execFileSync)("git", ["rev-parse", "--show-superproject-working-tree"], {
        cwd: probeCwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5e3
      }).trim();
    } catch (error) {
      completed = depth === 0 && isDefinitiveNonGitError(error);
      break;
    }
    if (!superRoot) {
      completed = true;
      break;
    }
    anchor = superRoot;
    probeCwd = superRoot;
  }
  if (completed) {
    if (superprojectCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = superprojectCacheMap.keys().next().value;
      if (oldest !== void 0) superprojectCacheMap.delete(oldest);
    }
    superprojectCacheMap.set(cacheKey, anchor);
  }
  return anchor;
}
function resolveStateAnchorRoot(worktreeRoot) {
  if (worktreeRoot) return resolveSuperprojectRoot(worktreeRoot) || worktreeRoot;
  return getWorktreeRoot() || process.cwd();
}
function getGitTopLevel(cwd) {
  const effectiveCwd = cwd || process.cwd();
  if (toplevelCacheMap.has(effectiveCwd)) {
    const root = toplevelCacheMap.get(effectiveCwd);
    toplevelCacheMap.delete(effectiveCwd);
    toplevelCacheMap.set(effectiveCwd, root);
    return root || null;
  }
  try {
    const root = (0, import_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: effectiveCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5e3
    }).trim();
    if (toplevelCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = toplevelCacheMap.keys().next().value;
      if (oldest !== void 0) toplevelCacheMap.delete(oldest);
    }
    toplevelCacheMap.set(effectiveCwd, root);
    return root;
  } catch {
    return null;
  }
}
function getWorktreeRoot(cwd) {
  const effectiveCwd = cwd || process.cwd();
  if (worktreeCacheMap.has(effectiveCwd)) {
    const root2 = worktreeCacheMap.get(effectiveCwd);
    worktreeCacheMap.delete(effectiveCwd);
    worktreeCacheMap.set(effectiveCwd, root2);
    return root2 || null;
  }
  const root = resolveSuperprojectRoot(effectiveCwd) || getGitTopLevel(effectiveCwd);
  if (!root) {
    return null;
  }
  if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = worktreeCacheMap.keys().next().value;
    if (oldest !== void 0) {
      worktreeCacheMap.delete(oldest);
    }
  }
  worktreeCacheMap.set(effectiveCwd, root);
  return root;
}
var dualDirWarnings = /* @__PURE__ */ new Set();
function getProjectIdentifier(worktreeRoot) {
  const root = worktreeRoot || getGitTopLevel() || process.cwd();
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot) {
    const cfg = readWorkspaceMarkerConfig(workspaceRoot);
    if (cfg.id && typeof cfg.id === "string" && cfg.id.trim()) {
      const safeId = cfg.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
      const hash3 = (0, import_crypto.createHash)("sha256").update(safeId).digest("hex").slice(0, 16);
      return `${safeId}-${hash3}`;
    }
    const hash2 = (0, import_crypto.createHash)("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
    const dirName2 = (0, import_path2.basename)(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${dirName2}-${hash2}`;
  }
  let source;
  try {
    const remoteUrl = (0, import_child_process.execFileSync)("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }).trim();
    source = remoteUrl || root;
  } catch {
    source = root;
  }
  let primaryRoot = root;
  try {
    const commonDir = (0, import_child_process.execFileSync)("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5e3
    }).trim();
    const isGitDir = (0, import_path2.basename)(commonDir) === ".git";
    const isSubmodule = commonDir.includes(`${import_path2.sep}.git${import_path2.sep}modules`);
    if (isGitDir && !isSubmodule) {
      const resolved = (0, import_path2.dirname)(commonDir);
      if (resolved && resolved !== root) {
        primaryRoot = resolved;
      }
    }
  } catch {
  }
  const hash = (0, import_crypto.createHash)("sha256").update(source).digest("hex").slice(0, 16);
  const dirName = (0, import_path2.basename)(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${dirName}-${hash}`;
}
function getOmcRoot(worktreeRoot) {
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const root2 = worktreeRoot || getGitTopLevel() || process.cwd();
    const projectId = getProjectIdentifier(root2);
    const centralizedPath = (0, import_path2.join)(customDir, projectId);
    const legacyPath = (0, import_path2.join)(root2, OmcPaths.ROOT);
    const warningKey = `${legacyPath}:${centralizedPath}`;
    if (!dualDirWarnings.has(warningKey) && (0, import_fs.existsSync)(legacyPath) && (0, import_fs.existsSync)(centralizedPath)) {
      dualDirWarnings.add(warningKey);
      console.warn(
        `[omc] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. Using centralized dir. Consider migrating data from the legacy dir and removing it.`
      );
    }
    return centralizedPath;
  }
  const workspaceAnchor = findWorkspaceRoot(worktreeRoot);
  if (workspaceAnchor) {
    return (0, import_path2.join)(workspaceAnchor, OmcPaths.ROOT);
  }
  const root = resolveStateAnchorRoot(worktreeRoot);
  return (0, import_path2.join)(root, OmcPaths.ROOT);
}

// src/hooks/learner/parser.ts
function parseYamlMetadata(yamlContent) {
  const lines = yamlContent.split("\n");
  const metadata = {};
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
      case "source":
        metadata.source = parseStringValue(rawValue);
        break;
      case "createdAt":
        metadata.createdAt = parseStringValue(rawValue);
        break;
      case "sessionId":
        metadata.sessionId = parseStringValue(rawValue);
        break;
      case "model":
        metadata.model = parseStringValue(rawValue);
        break;
      case "agent":
        metadata.agent = parseStringValue(rawValue);
        break;
      case "matching":
        metadata.matching = parseStringValue(rawValue);
        break;
      case "quality":
        metadata.quality = parseInt(rawValue, 10) || void 0;
        break;
      case "usageCount":
        metadata.usageCount = parseInt(rawValue, 10) || 0;
        break;
      case "triggers":
      case "tags": {
        const { value, consumed } = parseArrayValue(rawValue, lines, i);
        if (key === "triggers") {
          metadata.triggers = normalizeStringArray(value);
        } else {
          metadata.tags = normalizeStringArray(value);
        }
        i += consumed - 1;
        break;
      }
    }
    i++;
  }
  return metadata;
}
function parseStringValue(value) {
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter(Boolean);
}
function parseArrayValue(rawValue, lines, currentIndex) {
  if (rawValue.startsWith("[")) {
    const endIdx = rawValue.lastIndexOf("]");
    if (endIdx === -1) return { value: [], consumed: 1 };
    const content = rawValue.slice(1, endIdx).trim();
    if (!content) return { value: [], consumed: 1 };
    const items = content.split(",").map((s) => parseStringValue(s.trim())).filter(Boolean);
    return { value: items, consumed: 1 };
  }
  if (!rawValue || rawValue === "") {
    const items = [];
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
  return { value: parseStringValue(rawValue), consumed: 1 };
}

// src/hooks/learner/transliteration-map.ts
var KOREAN_MAP = {
  // === deep-dive skill ===
  "deep dive": ["\uB525\uB2E4\uC774\uBE0C", "\uB525 \uB2E4\uC774\uBE0C"],
  "deep-dive": ["\uB525\uB2E4\uC774\uBE0C"],
  "trace and interview": ["\uD2B8\uB808\uC774\uC2A4 \uC564 \uC778\uD130\uBDF0"],
  // === deep-pipeline skill ===
  "deep-pipeline": ["\uB525\uD30C\uC774\uD504\uB77C\uC778", "\uB525 \uD30C\uC774\uD504\uB77C\uC778"],
  "deep-pipe": ["\uB525\uD30C\uC774\uD504"]
};
function expandTriggers(triggersLower) {
  const expanded = new Set(triggersLower);
  for (const trigger of triggersLower) {
    const koreanVariants = KOREAN_MAP[trigger];
    if (koreanVariants) {
      for (const variant of koreanVariants) {
        expanded.add(variant);
      }
    }
  }
  return Array.from(expanded);
}

// src/hooks/learner/bridge.ts
var USER_SKILLS_DIR = (0, import_path3.join)(
  (0, import_os3.homedir)(),
  ".claude",
  "skills",
  "omc-learned"
);
var GLOBAL_SKILLS_DIR = (0, import_path3.join)((0, import_os3.homedir)(), ".omc", "skills");
var PROJECT_SKILLS_SUBDIR = OmcPaths.SKILLS;
var PROJECT_AGENT_SKILLS_SUBDIR = (0, import_path3.join)(".agents", "skills");
var SKILL_EXTENSION = ".md";
var SESSION_TTL_MS = 60 * 60 * 1e3;
var MAX_RECURSION_DEPTH = 10;
var LEVENSHTEIN_CACHE_SIZE = 1e3;
var SKILL_CACHE_TTL_MS = 30 * 1e3;
var MAX_CACHE_ENTRIES = 50;
var levenshteinCache = /* @__PURE__ */ new Map();
function getCachedLevenshtein(str1, str2) {
  const key = str1 < str2 ? `${str1}|${str2}` : `${str2}|${str1}`;
  const cached = levenshteinCache.get(key);
  if (cached !== void 0) {
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
var skillMetadataCache = null;
function getSkillMetadataCache(projectRoot) {
  if (!skillMetadataCache) {
    skillMetadataCache = /* @__PURE__ */ new Map();
  }
  const cached = skillMetadataCache.get(projectRoot);
  const now = Date.now();
  if (cached && now - cached.timestamp < SKILL_CACHE_TTL_MS) {
    skillMetadataCache.delete(projectRoot);
    skillMetadataCache.set(projectRoot, cached);
    return cached.skills;
  }
  const candidates = findSkillFiles(projectRoot);
  const skills = [];
  for (const candidate of candidates) {
    try {
      const content = (0, import_fs2.readFileSync)(candidate.path, "utf-8");
      const parsed = parseSkillFile(content);
      if (!parsed) continue;
      const triggers = (parsed.metadata.triggers ?? []).map((trigger) => trigger.trim()).filter(Boolean);
      if (triggers.length === 0) continue;
      const name = parsed.metadata.name || (0, import_path3.basename)(candidate.path, SKILL_EXTENSION);
      skills.push({
        path: candidate.path,
        name,
        triggers,
        triggersLower: expandTriggers(triggers.map((t) => t.toLowerCase())),
        matching: parsed.metadata.matching,
        content: parsed.content,
        description: parsed.metadata.description,
        summary: summarizeSkillContent(parsed.content),
        scope: candidate.scope
      });
    } catch {
    }
  }
  if (skillMetadataCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = skillMetadataCache.keys().next().value;
    if (firstKey !== void 0) skillMetadataCache.delete(firstKey);
  }
  skillMetadataCache.set(projectRoot, { skills, timestamp: now });
  return skills;
}
function clearSkillMetadataCache() {
  skillMetadataCache = null;
}
function clearLevenshteinCache() {
  levenshteinCache.clear();
}
function summarizeSkillContent(content) {
  const firstUsefulLine = content.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line && !line.startsWith("---"));
  return (firstUsefulLine || content.replace(/\s+/g, " ").trim()).slice(0, 240);
}
function getStateFilePath(projectRoot) {
  return (0, import_path3.join)(getOmcRoot(projectRoot), "state", "skill-sessions.json");
}
function readSessionState(projectRoot) {
  const stateFile = getStateFilePath(projectRoot);
  try {
    if ((0, import_fs2.existsSync)(stateFile)) {
      const content = (0, import_fs2.readFileSync)(stateFile, "utf-8");
      return JSON.parse(content);
    }
  } catch {
  }
  return { sessions: {} };
}
function writeSessionState(projectRoot, state) {
  const stateFile = getStateFilePath(projectRoot);
  try {
    (0, import_fs2.mkdirSync)((0, import_path3.dirname)(stateFile), { recursive: true });
    (0, import_fs2.writeFileSync)(stateFile, JSON.stringify(state, null, 2), "utf-8");
  } catch {
  }
}
function getInjectedSkillPaths(sessionId, projectRoot) {
  const state = readSessionState(projectRoot);
  const session = state.sessions[sessionId];
  if (!session) return [];
  if (Date.now() - session.timestamp > SESSION_TTL_MS) {
    return [];
  }
  return session.injectedPaths;
}
function markSkillsInjected(sessionId, paths, projectRoot) {
  const state = readSessionState(projectRoot);
  const now = Date.now();
  for (const [id, session] of Object.entries(state.sessions)) {
    if (now - session.timestamp > SESSION_TTL_MS) {
      delete state.sessions[id];
    }
  }
  const existing = state.sessions[sessionId]?.injectedPaths ?? [];
  state.sessions[sessionId] = {
    injectedPaths: [.../* @__PURE__ */ new Set([...existing, ...paths])],
    timestamp: now
  };
  writeSessionState(projectRoot, state);
}
function findSkillFilesRecursive(dir, results, depth = 0) {
  if (!(0, import_fs2.existsSync)(dir)) return;
  if (depth > MAX_RECURSION_DEPTH) return;
  try {
    const entries = (0, import_fs2.readdirSync)(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = (0, import_path3.join)(dir, entry.name);
      if (entry.isDirectory()) {
        findSkillFilesRecursive(fullPath, results, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(SKILL_EXTENSION)) {
        results.push(fullPath);
      }
    }
  } catch {
  }
}
function safeRealpathSync(filePath) {
  try {
    return (0, import_fs2.realpathSync)(filePath);
  } catch {
    return filePath;
  }
}
function isWithinBoundary(realPath, boundary) {
  const normalizedReal = safeRealpathSync(realPath).replace(/\\/g, "/").replace(/\/+/g, "/");
  const normalizedBoundary = safeRealpathSync(boundary).replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalizedReal === normalizedBoundary || normalizedReal.startsWith(normalizedBoundary + "/");
}
function findSkillFiles(projectRoot, options) {
  const candidates = [];
  const seenRealPaths = /* @__PURE__ */ new Set();
  const scope = options?.scope ?? "all";
  if (scope === "project" || scope === "all") {
    const projectSkillDirs = [
      (0, import_path3.join)(projectRoot, PROJECT_SKILLS_SUBDIR),
      (0, import_path3.join)(projectRoot, PROJECT_AGENT_SKILLS_SUBDIR)
    ];
    for (const projectSkillsDir of projectSkillDirs) {
      const projectFiles = [];
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
          sourceDir: projectSkillsDir
        });
      }
    }
  }
  if (scope === "user" || scope === "all") {
    const userDirs = [GLOBAL_SKILLS_DIR, USER_SKILLS_DIR];
    for (const userDir of userDirs) {
      const userFiles = [];
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
          sourceDir: userDir
        });
      }
    }
  }
  return candidates;
}
function parseSkillFile(content) {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (!match) {
    return {
      metadata: {},
      content: content.trim(),
      valid: true,
      errors: []
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
      errors
    };
  } catch (e) {
    return {
      metadata: {},
      content: body,
      valid: false,
      errors: [`YAML parse error: ${e}`]
    };
  }
}
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  if (m < n) {
    return levenshteinDistance(str2, str1);
  }
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
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
function fuzzyMatchTrigger(prompt, trigger) {
  const words = prompt.split(/\s+/).filter((w) => w.length > 0);
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
    const similarity = maxLen > 0 ? (maxLen - distance) / maxLen * 100 : 0;
    bestScore = Math.max(bestScore, similarity);
  }
  return Math.round(bestScore);
}
function matchSkillsForInjection(prompt, projectRoot, sessionId, options = {}) {
  const { fuzzyThreshold = 60, maxResults = 5 } = options;
  const promptLower = prompt.toLowerCase();
  const alreadyInjected = new Set(
    getInjectedSkillPaths(sessionId, projectRoot)
  );
  const cachedSkills = getSkillMetadataCache(projectRoot);
  const matches = [];
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
        description: skill.description,
        summary: skill.summary,
        score: totalScore,
        scope: skill.scope,
        triggers: skill.triggers,
        matching: skill.matching
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, maxResults);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GLOBAL_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_SUBDIR,
  PROJECT_SKILLS_SUBDIR,
  SKILL_EXTENSION,
  USER_SKILLS_DIR,
  clearLevenshteinCache,
  clearSkillMetadataCache,
  findSkillFiles,
  getInjectedSkillPaths,
  markSkillsInjected,
  matchSkillsForInjection,
  parseSkillFile
});
