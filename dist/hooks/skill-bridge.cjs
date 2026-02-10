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
var import_path2 = require("path");
var import_os = require("os");

// src/lib/worktree-paths.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
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
  SKILLS: ".omc/skills"
};

// src/hooks/learner/bridge.ts
var USER_SKILLS_DIR = (0, import_path2.join)(
  (0, import_os.homedir)(),
  ".claude",
  "skills",
  "omc-learned"
);
var GLOBAL_SKILLS_DIR = (0, import_path2.join)((0, import_os.homedir)(), ".omc", "skills");
var PROJECT_SKILLS_SUBDIR = OmcPaths.SKILLS;
var SKILL_EXTENSION = ".md";
var SESSION_TTL_MS = 60 * 60 * 1e3;
var MAX_RECURSION_DEPTH = 10;
var LEVENSHTEIN_CACHE_SIZE = 1e3;
var SKILL_CACHE_TTL_MS = 30 * 1e3;
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
    return cached.skills;
  }
  const candidates = findSkillFiles(projectRoot);
  const skills = [];
  for (const candidate of candidates) {
    try {
      const content = (0, import_fs2.readFileSync)(candidate.path, "utf-8");
      const parsed = parseSkillFile(content);
      if (!parsed) continue;
      const triggers = parsed.metadata.triggers ?? [];
      if (triggers.length === 0) continue;
      const name = parsed.metadata.name || (0, import_path2.basename)(candidate.path, SKILL_EXTENSION);
      skills.push({
        path: candidate.path,
        name,
        triggers,
        triggersLower: triggers.map((t) => t.toLowerCase()),
        matching: parsed.metadata.matching,
        content: parsed.content,
        scope: candidate.scope
      });
    } catch {
    }
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
var STATE_FILE = `${OmcPaths.STATE}/skill-sessions.json`;
function getStateFilePath(projectRoot) {
  return (0, import_path2.join)(projectRoot, STATE_FILE);
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
    (0, import_fs2.mkdirSync)((0, import_path2.dirname)(stateFile), { recursive: true });
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
      const fullPath = (0, import_path2.join)(dir, entry.name);
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
  const normalizedReal = realPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const normalizedBoundary = boundary.replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalizedReal === normalizedBoundary || normalizedReal.startsWith(normalizedBoundary + "/");
}
function findSkillFiles(projectRoot, options) {
  const candidates = [];
  const seenRealPaths = /* @__PURE__ */ new Set();
  const scope = options?.scope ?? "all";
  if (scope === "project" || scope === "all") {
    const projectSkillsDir = (0, import_path2.join)(projectRoot, PROJECT_SKILLS_SUBDIR);
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
      case "model":
        metadata.model = parseStringValue(rawValue);
        break;
      case "agent":
        metadata.agent = parseStringValue(rawValue);
        break;
      case "matching":
        metadata.matching = parseStringValue(rawValue);
        break;
      case "triggers":
      case "tags": {
        const { value, consumed } = parseArrayValue(rawValue, lines, i);
        if (key === "triggers") {
          metadata.triggers = Array.isArray(value) ? value : value ? [value] : [];
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
function parseStringValue(value) {
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
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
