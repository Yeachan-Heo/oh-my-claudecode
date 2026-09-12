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
var import_node_async_hooks = require("node:async_hooks");
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_os2 = require("os");
var import_path2 = require("path");
var import_url = require("url");

// src/utils/config-dir.ts
var import_path = require("path");
var import_os = require("os");
function stripTrailingSep(p) {
  if (!p.endsWith(import_path.sep)) {
    return p;
  }
  return p === (0, import_path.parse)(p).root ? p : p.slice(0, -1);
}
function getClaudeConfigDir() {
  const home = (0, import_os.homedir)();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) {
    return stripTrailingSep((0, import_path.normalize)((0, import_path.join)(home, ".claude")));
  }
  if (configured === "~") {
    return stripTrailingSep((0, import_path.normalize)(home));
  }
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return stripTrailingSep((0, import_path.normalize)((0, import_path.join)(home, configured.slice(2))));
  }
  return stripTrailingSep((0, import_path.normalize)(configured));
}

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
var gitTopLevelCacheMap = /* @__PURE__ */ new Map();
var superprojectCacheMap = /* @__PURE__ */ new Map();
var canonicalWorkingDirectoryRoots = /* @__PURE__ */ new WeakMap();
var GIT_PROBE_ENVIRONMENT_KEYS = [
  "PATH",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_EXEC_PATH",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_INDEX_FILE",
  "HOME",
  "XDG_CONFIG_HOME"
];
var MAX_GIT_MARKER_BYTES = 4096;
function gitProbeEnvironmentSignature() {
  const fixedEntries = GIT_PROBE_ENVIRONMENT_KEYS.map((key) => JSON.stringify([key, process.env[key] !== void 0, process.env[key] ?? ""]));
  const dynamicEntries = Object.keys(process.env).filter((key) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)).sort().map((key) => JSON.stringify([key, process.env[key] !== void 0, process.env[key] ?? ""]));
  return [...fixedEntries, ...dynamicEntries].join("\0");
}
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
    const cached = superprojectCacheMap.get(cacheKey);
    if (isStateRootCacheEntryValid(cacheKey, cached)) {
      superprojectCacheMap.delete(cacheKey);
      superprojectCacheMap.set(cacheKey, cached);
      return cached.root;
    }
    superprojectCacheMap.delete(cacheKey);
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
        timeout: 5e3,
        // Force English error text so isDefinitiveNonGitError's stderr match is
        // locale-independent (localized git output otherwise fails to match
        // and mis-classifies a plain "not a repository" as a generic failure).
        env: { ...process.env, LC_ALL: "C" }
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
    superprojectCacheMap.set(cacheKey, createStateRootCacheEntry(cacheKey, anchor));
  }
  return anchor;
}
var SENSITIVE_DIR_BASENAMES = /* @__PURE__ */ new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  "ssh",
  ".pki",
  ".config",
  ".claude",
  ".claude.json",
  ".codex",
  ".gemini",
  ".cursor",
  ".vscode",
  ".ollama",
  ".docker",
  ".npm",
  ".cache",
  ".local",
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "photos",
  "music",
  "movies",
  "videos",
  "public",
  "library"
]);
function sensitiveAbsoluteRoots() {
  const roots = [];
  const temp = (() => {
    try {
      return (0, import_path2.resolve)((0, import_os2.tmpdir)());
    } catch {
      return null;
    }
  })();
  if (temp) roots.push(temp);
  if (process.platform === "win32") {
    const home = (() => {
      try {
        return (0, import_path2.resolve)((0, import_os2.homedir)());
      } catch {
        return null;
      }
    })();
    roots.push("C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData");
    const drive = (home && /^[a-zA-Z]:/.exec(home))?.[0];
    if (drive) roots.push(`${drive}\\Windows`, `${drive}\\Program Files`, `${drive}\\Program Files (x86)`, `${drive}\\ProgramData`);
  } else {
    roots.push("/var", "/usr", "/etc", "/opt", "/private/var");
  }
  return roots;
}
function isFilesystemRoot(dir) {
  return (0, import_path2.dirname)(dir) === dir;
}
function isWithinPath(ancestor, candidate) {
  const rel = (0, import_path2.relative)(ancestor, candidate);
  return rel === "" || !rel.startsWith(`..${import_path2.sep}`) && rel !== ".." && !(0, import_path2.isAbsolute)(rel);
}
function isSensitiveStateLocation(dir) {
  let candidate;
  try {
    candidate = (0, import_path2.resolve)(dir);
    try {
      candidate = (0, import_fs.realpathSync)(candidate);
    } catch {
    }
  } catch {
    return true;
  }
  const home = (() => {
    try {
      const path = (0, import_path2.resolve)((0, import_os2.homedir)());
      try {
        return (0, import_fs.realpathSync)(path);
      } catch {
        return path;
      }
    } catch {
      return null;
    }
  })();
  let cursor = candidate;
  for (; ; ) {
    const name = (0, import_path2.basename)(cursor);
    const lowerName = name.toLowerCase();
    if (home && cursor === candidate && (cursor === home || process.platform === "win32" && cursor.toLowerCase() === home.toLowerCase())) return true;
    if (name.startsWith(".") && name !== OmcPaths.ROOT) return true;
    if (SENSITIVE_DIR_BASENAMES.has(lowerName)) return true;
    if (isFilesystemRoot(cursor)) break;
    cursor = (0, import_path2.dirname)(cursor);
  }
  if (candidate === "/tmp" || candidate === "/private/tmp") return true;
  if (isFilesystemRoot(candidate)) return true;
  return sensitiveAbsoluteRoots().some((root) => {
    const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    let canonicalRoot = root;
    try {
      canonicalRoot = (0, import_fs.realpathSync)(root);
    } catch {
    }
    const normalizedRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    return normalizedCandidate === normalizedRoot || isWithinPath(normalizedRoot, normalizedCandidate);
  });
}
function resolveNonGitFallbackRoot() {
  const home = (0, import_path2.resolve)((0, import_os2.homedir)());
  if (isFilesystemRoot(home)) {
    throw new Error("Cannot resolve a safe non-git OMC state root: home resolves to the filesystem root.");
  }
  return home;
}
function resolveNonGitStateAnchor(startDir) {
  try {
    const current = (0, import_path2.resolve)(startDir || process.cwd());
    const workspaceRoot = findWorkspaceRoot(current);
    if (workspaceRoot && !isSensitiveStateLocation(workspaceRoot)) return workspaceRoot;
    if (isSensitiveStateLocation(current)) return resolveNonGitFallbackRoot();
    return resolveNonGitFallbackRoot();
  } catch {
    return resolveNonGitFallbackRoot();
  }
}
function resolveStateAnchorRoot(worktreeRoot) {
  if (worktreeRoot) return resolveSuperprojectRoot(worktreeRoot) || worktreeRoot;
  return getWorktreeRoot() || resolveNonGitStateAnchor();
}
var worktreePathRenderScope = new import_node_async_hooks.AsyncLocalStorage();
var projectIdentifierOperationScope = new import_node_async_hooks.AsyncLocalStorage();
var gitShowToplevelProbeForTests;
function gitErrorStderr(error) {
  if (!error || typeof error !== "object") {
    return "";
  }
  const err = error;
  if (Buffer.isBuffer(err.stderr)) {
    return err.stderr.toString("utf8");
  }
  if (typeof err.stderr === "string") {
    return err.stderr;
  }
  return typeof err.message === "string" ? err.message : "";
}
function isGitCommandPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const base = (0, import_path2.basename)(path);
  return base === "git" || base === "git.exe" || base === "git.cmd" || base === "git.bat";
}
function isConfirmedGitExecutableNotFound(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error;
  if (err.code !== "ENOENT") {
    return false;
  }
  if (err.killed === true) {
    return false;
  }
  if (typeof err.status === "number") {
    return false;
  }
  if (typeof err.signal === "string" && err.signal.length > 0) {
    return false;
  }
  const syscall = typeof err.syscall === "string" ? err.syscall.toLowerCase() : "";
  if (!syscall.includes("spawn")) {
    return false;
  }
  return syscall.includes("git") || isGitCommandPath(err.path);
}
function isNotAGitRepositoryError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error;
  if (err.code === "ENOENT" || err.code === "ETIMEDOUT" || err.code === "EACCES") {
    return false;
  }
  if (typeof err.signal === "string" && err.signal.length > 0) {
    return false;
  }
  const stderr = gitErrorStderr(error);
  return err.status === 128 && /(?:not a git repository|must be run in a work tree)/i.test(stderr);
}
function formatGitProbeDetail(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const err = error;
  if (err.code === "ENOENT") {
    return "git executable not found";
  }
  if (err.code === "EACCES") {
    return "git executable not accessible";
  }
  if (err.code === "ETIMEDOUT" || err.killed === true) {
    return "git probe timed out";
  }
  if (typeof err.signal === "string" && err.signal.length > 0) {
    return `git killed by ${err.signal}`;
  }
  const stderr = gitErrorStderr(error).trim();
  if (stderr.length > 0) {
    return stderr.split("\n")[0] ?? stderr;
  }
  if (typeof err.message === "string" && err.message.length > 0) {
    return err.message;
  }
  if (typeof err.status === "number") {
    return `git exited ${err.status}`;
  }
  return "unknown git probe failure";
}
function findGitMetadataDir(start) {
  let current = start;
  for (; ; ) {
    if ((0, import_fs.existsSync)((0, import_path2.join)(current, ".git"))) {
      return current;
    }
    const parent = (0, import_path2.dirname)(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
function expandPathForCompare(path) {
  const normalized = (0, import_path2.resolve)(path);
  try {
    return import_fs.realpathSync.native(normalized);
  } catch {
    try {
      return (0, import_fs.realpathSync)(normalized);
    } catch {
      return null;
    }
  }
}
function canonicalizeExistingPath(path) {
  try {
    return (0, import_fs.realpathSync)((0, import_path2.resolve)(path));
  } catch {
    return null;
  }
}
function sameCanonicalPath(left, right) {
  const a = expandPathForCompare(left);
  const b = expandPathForCompare(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (process.platform !== "win32") {
    return false;
  }
  const fold = (value) => value.replaceAll("/", "\\").toLowerCase();
  return fold(a) === fold(b);
}
function isCredibleGitWorktreeRoot(root) {
  try {
    if (!(0, import_fs.statSync)(root).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  const rootReal = canonicalizeExistingPath(root);
  if (!rootReal) {
    return false;
  }
  const metadataDir = findGitMetadataDir(rootReal);
  return metadataDir !== null && sameCanonicalPath(metadataDir, rootReal);
}
function classifyGitShowToplevelStdout(stdout, cwd) {
  const root = stdout.trim();
  if (root.length === 0 || !(0, import_path2.isAbsolute)(root) || !isCredibleGitWorktreeRoot(root)) {
    return { status: "probe_failed", detail: "malformed git toplevel output" };
  }
  const cwdReal = canonicalizeExistingPath(cwd);
  if (!cwdReal) {
    return { status: "probe_failed", detail: "malformed git toplevel output" };
  }
  const metadataDir = findGitMetadataDir(cwdReal);
  if (!metadataDir || !sameCanonicalPath(metadataDir, root)) {
    return { status: "probe_failed", detail: "malformed git toplevel output" };
  }
  return { status: "ok", root: canonicalizeExistingPath(metadataDir) ?? metadataDir };
}
function classifyGitShowToplevelError(error) {
  if (isNotAGitRepositoryError(error)) {
    return { status: "not_a_repository" };
  }
  if (isConfirmedGitExecutableNotFound(error)) {
    return { status: "git_missing" };
  }
  return { status: "probe_failed", detail: formatGitProbeDetail(error) };
}
function runGitShowToplevel(cwd) {
  if (gitShowToplevelProbeForTests) {
    const result = gitShowToplevelProbeForTests(cwd);
    return Buffer.isBuffer(result) ? result.toString("utf8") : result;
  }
  return (0, import_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5e3,
    // Force English error text so isNotAGitRepositoryError's stderr match is
    // locale-independent (localized git output otherwise fails to match and
    // mis-classifies a plain "not a repository" as probe_failed, which then
    // fails closed and breaks callers such as the HUD statusline).
    env: { ...process.env, LC_ALL: "C" }
  });
}
function probeGitTopLevel(cwd) {
  const scope = worktreePathRenderScope.getStore();
  const scopeKey = scope ? canonicalizeExistingPath(cwd) ?? (0, import_path2.resolve)(cwd) : null;
  if (scope && scopeKey) {
    const cached = scope.gitTopLevelProbes.get(scopeKey);
    if (cached) return cached;
  }
  let result;
  try {
    result = classifyGitShowToplevelStdout(runGitShowToplevel(cwd), cwd);
  } catch (error) {
    result = classifyGitShowToplevelError(error);
  }
  if (scope && scopeKey) {
    scope.gitTopLevelProbes.set(scopeKey, result);
  }
  return result;
}
function gitMetadataFileSignature(path) {
  try {
    const metadata = (0, import_fs.statSync)(path);
    return [
      path,
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.size,
      metadata.mtimeMs,
      metadata.ctimeMs
    ].join(":");
  } catch {
    return `${path}:missing`;
  }
}
function readGitMarker(path) {
  let descriptor;
  try {
    if (!(0, import_fs.lstatSync)(path).isFile()) return null;
    descriptor = (0, import_fs.openSync)(path, "r");
    const buffer = Buffer.alloc(MAX_GIT_MARKER_BYTES);
    const bytesRead = (0, import_fs.readSync)(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== void 0) (0, import_fs.closeSync)(descriptor);
  }
}
function commonGitDirectorySignature(linkedGitDir) {
  const commondirPath = (0, import_path2.join)(linkedGitDir, "commondir");
  try {
    if (!(0, import_fs.existsSync)(commondirPath)) return `${commondirPath}:absent`;
    const marker = readGitMarker(commondirPath);
    if (marker === null) return `${commondirPath}:unreadable`;
    const commonDir = canonicalizeExistingPath((0, import_path2.resolve)(linkedGitDir, marker.trim()));
    if (!commonDir || !(0, import_fs.statSync)(commonDir).isDirectory()) {
      return `${commondirPath}:invalid:${marker}`;
    }
    return [
      commonDir,
      gitMetadataFileSignature(commonDir),
      gitMetadataFileSignature((0, import_path2.join)(commonDir, "HEAD")),
      gitMetadataFileSignature((0, import_path2.join)(commonDir, "index")),
      gitMetadataFileSignature((0, import_path2.join)(commonDir, "config"))
    ].join(":");
  } catch {
    return `${commondirPath}:invalid`;
  }
}
function getGitMetadataSnapshot(cwd) {
  const metadataDir = findGitMetadataDir(canonicalizeExistingPath(cwd) ?? (0, import_path2.resolve)(cwd));
  if (!metadataDir) return null;
  const canonicalDirectory = canonicalizeExistingPath(metadataDir);
  if (!canonicalDirectory) return null;
  const gitPath = (0, import_path2.join)(canonicalDirectory, ".git");
  try {
    const metadata = (0, import_fs.statSync)(gitPath);
    const marker = metadata.isFile() ? readGitMarker(gitPath) : "";
    if (marker === null) return null;
    let metadataPath = gitPath;
    let linkedGitDirSignature = "";
    if (metadata.isFile()) {
      const gitDirMatch = /^\s*gitdir:\s*(.+?)\s*$/im.exec(marker);
      if (!gitDirMatch?.[1]) return null;
      const linkedGitDir = (0, import_path2.resolve)(canonicalDirectory, gitDirMatch[1].trim());
      const linkedGitDirReal = canonicalizeExistingPath(linkedGitDir);
      if (!linkedGitDirReal || !(0, import_fs.statSync)(linkedGitDirReal).isDirectory()) return null;
      metadataPath = linkedGitDirReal;
      linkedGitDirSignature = [
        linkedGitDirReal,
        gitMetadataFileSignature(linkedGitDirReal),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "HEAD")),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "index")),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "config")),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "config.worktree")),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "commondir")),
        gitMetadataFileSignature((0, import_path2.join)(linkedGitDirReal, "gitdir")),
        commonGitDirectorySignature(linkedGitDirReal)
      ].join(":");
    }
    const gitPathReal = canonicalizeExistingPath(gitPath) ?? (0, import_path2.resolve)(gitPath);
    const metadataPathReal = canonicalizeExistingPath(metadataPath) ?? (0, import_path2.resolve)(metadataPath);
    const signature = [
      gitPathReal,
      gitMetadataFileSignature(gitPath),
      marker,
      linkedGitDirSignature,
      metadataPathReal,
      gitMetadataFileSignature((0, import_path2.join)(metadataPathReal, "HEAD")),
      gitMetadataFileSignature((0, import_path2.join)(metadataPathReal, "index")),
      gitMetadataFileSignature((0, import_path2.join)(metadataPathReal, "config")),
      gitMetadataFileSignature((0, import_path2.join)(metadataPathReal, "config.worktree"))
    ].join(":");
    return { directory: canonicalDirectory, signature };
  } catch {
    return null;
  }
}
function getGitTopologySignature(cwd) {
  const start = canonicalizeExistingPath(cwd) ?? (0, import_path2.resolve)(cwd);
  const signatures = [];
  let cursor = start;
  for (; ; ) {
    const gitPath = (0, import_path2.join)(cursor, ".git");
    if ((0, import_fs.existsSync)(gitPath)) {
      let metadataPath = gitPath;
      let marker = "";
      try {
        if ((0, import_fs.statSync)(gitPath).isFile()) {
          marker = readGitMarker(gitPath) ?? "<unreadable>";
          const gitDirMatch = /^\s*gitdir:\s*(.+?)\s*$/im.exec(marker);
          if (gitDirMatch?.[1]) metadataPath = (0, import_path2.resolve)(cursor, gitDirMatch[1].trim());
        }
      } catch {
      }
      const metadataReal = canonicalizeExistingPath(metadataPath) ?? (0, import_path2.resolve)(metadataPath);
      signatures.push([
        cursor,
        gitMetadataFileSignature(gitPath),
        marker,
        gitMetadataFileSignature((0, import_path2.join)(metadataReal, "HEAD")),
        gitMetadataFileSignature((0, import_path2.join)(metadataReal, "index")),
        gitMetadataFileSignature((0, import_path2.join)(metadataReal, "config")),
        gitMetadataFileSignature((0, import_path2.join)(metadataReal, "config.worktree")),
        commonGitDirectorySignature(metadataReal)
      ].join(":"));
    }
    const parent = (0, import_path2.dirname)(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return signatures.join("|");
}
function createStateRootCacheEntry(cwd, root) {
  return {
    root,
    metadataSignature: getGitMetadataSnapshot(cwd)?.signature ?? null,
    topologySignature: getGitTopologySignature(cwd),
    environmentSignature: gitProbeEnvironmentSignature()
  };
}
function isStateRootCacheEntryValid(cwd, entry) {
  return entry.metadataSignature === (getGitMetadataSnapshot(cwd)?.signature ?? null) && entry.topologySignature === getGitTopologySignature(cwd) && entry.environmentSignature === gitProbeEnvironmentSignature();
}
function isGitTopLevelCacheEntryValid(cwd, cached) {
  const current = getGitMetadataSnapshot(cwd);
  if (!current || current.signature !== cached.metadataSignature) return false;
  if (cached.topologySignature !== getGitTopologySignature(cwd)) return false;
  if (cached.environmentSignature !== gitProbeEnvironmentSignature()) return false;
  if (!sameCanonicalPath(current.directory, cached.metadataDir)) return false;
  if (!sameCanonicalPath(current.directory, cached.root)) return false;
  return isCredibleGitWorktreeRoot(cached.root);
}
function cacheGitTopLevel(key, root, cwd) {
  const metadata = getGitMetadataSnapshot(cwd);
  if (!metadata || !sameCanonicalPath(metadata.directory, root)) return;
  if (gitTopLevelCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = gitTopLevelCacheMap.keys().next().value;
    if (oldest !== void 0) gitTopLevelCacheMap.delete(oldest);
  }
  gitTopLevelCacheMap.set(key, {
    root,
    metadataDir: metadata.directory,
    metadataSignature: metadata.signature,
    topologySignature: getGitTopologySignature(cwd),
    environmentSignature: gitProbeEnvironmentSignature()
  });
}
function getGitTopLevel(cwd) {
  const effectiveCwd = cwd || process.cwd();
  const key = canonicalizeExistingPath(effectiveCwd) ?? (0, import_path2.resolve)(effectiveCwd);
  const cached = gitTopLevelCacheMap.get(key);
  if (cached) {
    if (isGitTopLevelCacheEntryValid(effectiveCwd, cached)) {
      gitTopLevelCacheMap.delete(key);
      gitTopLevelCacheMap.set(key, cached);
      return cached.root;
    }
    gitTopLevelCacheMap.delete(key);
  }
  const probe = probeGitTopLevel(effectiveCwd);
  if (probe.status !== "ok") return null;
  cacheGitTopLevel(key, probe.root, effectiveCwd);
  return probe.root;
}
function getWorktreeRoot(cwd) {
  const effectiveCwd = cwd || process.cwd();
  if (worktreeCacheMap.has(effectiveCwd)) {
    const cached = worktreeCacheMap.get(effectiveCwd);
    if (isStateRootCacheEntryValid(effectiveCwd, cached) && cached.root !== null && isCredibleGitWorktreeRoot(cached.root)) {
      worktreeCacheMap.delete(effectiveCwd);
      worktreeCacheMap.set(effectiveCwd, cached);
      return cached.root;
    }
    worktreeCacheMap.delete(effectiveCwd);
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
  worktreeCacheMap.set(effectiveCwd, createStateRootCacheEntry(effectiveCwd, root));
  return root;
}
var dualDirWarnings = /* @__PURE__ */ new Set();
function discoverCentralizedDirFromSettings() {
  const candidates = [];
  try {
    candidates.push((0, import_path2.join)(getClaudeConfigDir(), "settings.json"));
  } catch {
  }
  try {
    const cw = process.cwd();
    candidates.push((0, import_path2.join)(cw, ".claude", "settings.json"));
    candidates.push((0, import_path2.join)(cw, ".claude", "settings.local.json"));
  } catch {
  }
  for (const p of candidates) {
    try {
      const raw = (0, import_fs.readFileSync)(p, "utf-8");
      const parsed = JSON.parse(raw);
      const env = parsed?.env;
      const val = env?.OMC_STATE_DIR;
      if (typeof val === "string" && val.trim()) return val.trim();
    } catch {
    }
  }
  return null;
}
function getProjectIdentifier(worktreeRoot) {
  const root = worktreeRoot || getGitTopLevel() || process.cwd();
  const operationScope = projectIdentifierOperationScope.getStore();
  const operationScopeKey = operationScope ? canonicalizeExistingPath(root) ?? (0, import_path2.resolve)(root) : null;
  if (operationScope && operationScopeKey) {
    const cached = operationScope.get(operationScopeKey);
    if (cached !== void 0) return cached;
  }
  const scope = worktreePathRenderScope.getStore();
  const scopeKey = scope ? canonicalizeExistingPath(root) ?? (0, import_path2.resolve)(root) : null;
  if (scope && scopeKey) {
    const cached = scope.projectIdentifiers.get(scopeKey);
    if (cached !== void 0) return cached;
  }
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot) {
    const cfg = readWorkspaceMarkerConfig(workspaceRoot);
    if (cfg.id && typeof cfg.id === "string" && cfg.id.trim()) {
      const safeId = cfg.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
      const hash3 = (0, import_crypto.createHash)("sha256").update(safeId).digest("hex").slice(0, 16);
      const identifier3 = `${safeId}-${hash3}`;
      if (operationScope && operationScopeKey) operationScope.set(operationScopeKey, identifier3);
      if (scope && scopeKey) scope.projectIdentifiers.set(scopeKey, identifier3);
      return identifier3;
    }
    const hash2 = (0, import_crypto.createHash)("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
    const dirName2 = (0, import_path2.basename)(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
    const identifier2 = `${dirName2}-${hash2}`;
    if (operationScope && operationScopeKey) operationScope.set(operationScopeKey, identifier2);
    if (scope && scopeKey) scope.projectIdentifiers.set(scopeKey, identifier2);
    return identifier2;
  }
  let remoteUrl = "";
  try {
    remoteUrl = (0, import_child_process.execFileSync)("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5e3
    }).trim();
  } catch {
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
  const source = remoteUrl || primaryRoot;
  const hash = (0, import_crypto.createHash)("sha256").update(source).digest("hex").slice(0, 16);
  const dirName = (0, import_path2.basename)(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  const identifier = `${dirName}-${hash}`;
  if (operationScope && operationScopeKey) operationScope.set(operationScopeKey, identifier);
  if (scope && scopeKey) scope.projectIdentifiers.set(scopeKey, identifier);
  return identifier;
}
function getOmcRoot(worktreeRoot) {
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const root2 = worktreeRoot || getGitTopLevel() || process.cwd();
    const workspaceRoot = findWorkspaceRoot(root2);
    const gitTopLevel = getGitTopLevel(root2);
    const projectId = !gitTopLevel && !workspaceRoot ? "non-git" : getProjectIdentifier(root2);
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
  if (workspaceAnchor && !isSensitiveStateLocation(workspaceAnchor)) {
    try {
      const legacyPathW = (0, import_path2.join)(workspaceAnchor, OmcPaths.ROOT);
      const discoveredCentral = discoverCentralizedDirFromSettings();
      if (discoveredCentral) {
        const wsCfg = readWorkspaceMarkerConfig(workspaceAnchor);
        let projectIdW;
        if (wsCfg.id && typeof wsCfg.id === "string" && wsCfg.id.trim()) {
          const safeId = wsCfg.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
          projectIdW = `${safeId}-${(0, import_crypto.createHash)("sha256").update(safeId).digest("hex").slice(0, 16)}`;
        } else {
          projectIdW = `${(0, import_path2.basename)(workspaceAnchor).replace(/[^a-zA-Z0-9_-]/g, "_")}-${(0, import_crypto.createHash)("sha256").update(workspaceAnchor).digest("hex").slice(0, 16)}`;
        }
        const centralizedPathW = (0, import_path2.join)(discoveredCentral, projectIdW);
        const warningKeyW = `${legacyPathW}:${centralizedPathW}`;
        if (!dualDirWarnings.has(warningKeyW) && (0, import_fs.existsSync)(legacyPathW) && (0, import_fs.existsSync)(centralizedPathW)) {
          dualDirWarnings.add(warningKeyW);
          console.warn(
            `[omc] Both legacy state dir (${legacyPathW}) and centralized state dir (${centralizedPathW}) exist. Using legacy dir (OMC_STATE_DIR not set in this process). Set OMC_STATE_DIR via settings.json env to use centralized dir consistently.`
          );
        }
      }
    } catch {
    }
    return (0, import_path2.join)(workspaceAnchor, OmcPaths.ROOT);
  }
  const root = resolveStateAnchorRoot(worktreeRoot);
  if (!getGitTopLevel(root)) {
    return (0, import_path2.join)(resolveNonGitStateAnchor(root), OmcPaths.ROOT);
  }
  try {
    const legacyPath = (0, import_path2.join)(root, OmcPaths.ROOT);
    const discoveredCentral = discoverCentralizedDirFromSettings();
    if (discoveredCentral) {
      const projectId = getProjectIdentifier(root);
      const centralizedPath = (0, import_path2.join)(discoveredCentral, projectId);
      const warningKey = `${legacyPath}:${centralizedPath}`;
      if (!dualDirWarnings.has(warningKey) && (0, import_fs.existsSync)(legacyPath) && (0, import_fs.existsSync)(centralizedPath)) {
        dualDirWarnings.add(warningKey);
        console.warn(
          `[omc] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. Using legacy dir (OMC_STATE_DIR not set in this process). Set OMC_STATE_DIR via settings.json env to use centralized dir consistently.`
        );
      }
    }
  } catch {
  }
  return (0, import_path2.join)(root, OmcPaths.ROOT);
}
function callerVisibleTrustedRootLabel(trustedRoot) {
  const label = (0, import_path2.basename)(trustedRoot);
  return label.length > 0 ? label : "current repository";
}
function attachCanonicalWorkingDirectoryRoots(target, providedRoot, trustedRoot) {
  canonicalWorkingDirectoryRoots.set(target, { providedRoot, trustedRoot });
}
function canonicalRootAliases(root) {
  if (root.length === 0) {
    return [];
  }
  const aliases = /* @__PURE__ */ new Set([root]);
  try {
    aliases.add((0, import_url.pathToFileURL)(root).href);
  } catch {
  }
  try {
    const real = (0, import_fs.realpathSync)(root);
    aliases.add(real);
    aliases.add((0, import_url.pathToFileURL)(real).href);
  } catch {
  }
  if (import_path2.sep === "\\") {
    aliases.add(root.replaceAll("\\", "/"));
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}
function redactCanonicalRoots(text, providedRoot, trustedRoot) {
  let redacted = text;
  const roots = [...canonicalRootAliases(providedRoot), ...canonicalRootAliases(trustedRoot)].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    redacted = redacted.split(root).join("<redacted>");
  }
  return redacted;
}
function redactErrorStack(stack, providedRoot, trustedRoot) {
  const newline = stack.includes("\r\n") ? "\r\n" : "\n";
  const lines = stack.split(/\r?\n/);
  if (lines.length <= 1) {
    return stack;
  }
  const [header, ...frames] = lines;
  return [header, ...frames.map((frame) => redactCanonicalRoots(frame, providedRoot, trustedRoot))].join(newline);
}
var ForeignWorkingDirectoryError = class extends Error {
  callerLabel;
  constructor(providedRoot, trustedRoot, callerLabel) {
    super(
      `workingDirectory '${callerLabel}' belongs to a different repository than '${callerVisibleTrustedRootLabel(trustedRoot)}' and was not used. Cross-repository access is not permitted; pass a path inside the current repository or start the session there.`
    );
    this.name = "ForeignWorkingDirectoryError";
    this.callerLabel = callerLabel;
    attachCanonicalWorkingDirectoryRoots(this, providedRoot, trustedRoot);
    Object.defineProperty(this, "stack", {
      value: redactErrorStack(this.stack ?? `${this.name}: ${this.message}`, providedRoot, trustedRoot),
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      callerLabel: this.callerLabel
    };
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return this.stack ?? `${this.name}: ${this.message}`;
  }
};

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
