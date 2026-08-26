/**
 * Worktree Path Enforcement
 *
 * Provides strict path validation and resolution for .omc/ paths,
 * ensuring all operations stay within the worktree boundary.
 *
 * Supports OMC_STATE_DIR environment variable for centralized state storage.
 * When set, state is stored at $OMC_STATE_DIR/{project-identifier}/ instead
 * of {worktree}/.omc/. This preserves state across worktree deletions.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, unlinkSync, statSync, lstatSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { resolve, normalize, relative, sep, join, isAbsolute, basename, dirname } from 'path';
import { pathToFileURL } from 'url';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { encodeProjectPath } from '../utils/encode-project-path.js';

/**
 * Workspace marker filename. A directory containing this file is treated as
 * the OMC anchor regardless of git status — enables multi-repo workspaces
 * where the parent dir is not itself a git repo (issue: bidchex-repos style).
 *
 * The marker can be empty or a JSON file with optional fields:
 *   { "id": "stable-workspace-identifier" }
 *
 * Resolution order in getOmcRoot(): OMC_STATE_DIR > workspace marker > git > cwd.
 */
export const WORKSPACE_MARKER = '.omc-workspace';

/** Standard .omc subdirectories */
export const OmcPaths = {
  ROOT: '.omc',
  STATE: '.omc/state',
  SESSIONS: '.omc/state/sessions',
  PLANS: '.omc/plans',
  RESEARCH: '.omc/research',
  NOTEPAD: '.omc/notepad.md',
  PROJECT_MEMORY: '.omc/project-memory.json',
  DRAFTS: '.omc/drafts',
  NOTEPADS: '.omc/notepads',
  LOGS: '.omc/logs',
  SCIENTIST: '.omc/scientist',
  AUTOPILOT: '.omc/autopilot',
  SKILLS: '.omc/skills',
  SHARED_MEMORY: '.omc/state/shared-memory',
  DEEPINIT_MANIFEST: '.omc/deepinit-manifest.json',
} as const;

/**
 * LRU cache for worktree root lookups to avoid repeated git subprocess calls.
 * Bounded to MAX_WORKTREE_CACHE_SIZE entries to prevent memory growth when
 * alternating between many different cwds (cache thrashing).
 */
const MAX_WORKTREE_CACHE_SIZE = 8;
const worktreeCacheMap = new Map<string, string>();
/** LRU cache for outermost superproject root lookups, including negative results. */
const superprojectCacheMap = new Map<string, string | null>();
const canonicalWorkingDirectoryRoots = new WeakMap<object, { providedRoot: string; trustedRoot: string }>();

/** LRU cache for non-git state-anchor lookups. */
const nonGitAnchorCacheMap = new Map<string, string>();

/**
 * LRU cache for workspace marker lookups.
 */
const workspaceCacheMap = new Map<string, string | null>();

interface WorkspaceMarkerConfig {
  id?: string;
}

/**
 * Walk up from the given directory looking for a WORKSPACE_MARKER file.
 * Returns the directory containing the marker, or null if none found before
 * reaching the filesystem root or the user's home directory.
 *
 * Walking stops at the home directory to prevent accidentally treating a
 * stray marker in $HOME or above as a workspace anchor.
 */
export function findWorkspaceRoot(startDir?: string): string | null {
  if (process.env.OMC_DISABLE_MULTIREPO === '1') return null;
  const effectiveStart = startDir || process.cwd();
  let current: string;
  try {
    current = resolve(effectiveStart);
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
    try { return resolve(homedir()); } catch { return null; }
  })();

  let cursor = current;
  let result: string | null = null;
  while (true) {
    // Stop before scanning $HOME (or above) so a stray ~/.omc-workspace does
    // not collapse unrelated repos under home into one shared state root.
    if (home && cursor === home) break;
    if (existsSync(join(cursor, WORKSPACE_MARKER))) {
      result = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (workspaceCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = workspaceCacheMap.keys().next().value;
    if (oldest !== undefined) workspaceCacheMap.delete(oldest);
  }
  workspaceCacheMap.set(current, result);
  return result;
}

/**
 * Read optional workspace marker config (id override). Returns {} when the
 * marker is empty or unparseable — callers should not throw on config errors.
 */
export function readWorkspaceMarkerConfig(workspaceRoot: string): WorkspaceMarkerConfig {
  try {
    const raw = readFileSync(join(workspaceRoot, WORKSPACE_MARKER), 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as WorkspaceMarkerConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * If `cwd` is inside a git submodule, return the outermost superproject working
 * tree; otherwise return null. A submodule is a full git repo, so
 * `git rev-parse --show-toplevel` stops at the submodule and `.omc/` would be
 * created there instead of at the monorepo root (#3349). Climbing via
 * `--show-superproject-working-tree` anchors state to the superproject, walking
 * up through nested submodules until no superproject remains.
 */
function isDefinitiveNonGitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, stderr } = error as { status?: unknown; stderr?: unknown };
  if (status !== 128) return false;
  const output =
    typeof stderr === 'string'
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString()
        : '';
  return /not a git repository/i.test(output);
}

function resolveSuperprojectRoot(cwd: string): string | null {
  const cacheKey = resolve(cwd);
  if (superprojectCacheMap.has(cacheKey)) {
    const cached = superprojectCacheMap.get(cacheKey) ?? null;
    superprojectCacheMap.delete(cacheKey);
    superprojectCacheMap.set(cacheKey, cached);
    return cached;
  }

  let anchor: string | null = null;
  let probeCwd = cacheKey;
  let completed = false;
  // Bounded by submodule nesting depth; guard against pathological loops.
  for (let depth = 0; depth < 32; depth++) {
    let superRoot: string;
    try {
      superRoot = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
        cwd: probeCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 5000,
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
      if (oldest !== undefined) superprojectCacheMap.delete(oldest);
    }
    superprojectCacheMap.set(cacheKey, anchor);
  }
  return anchor;
}

// ============================================================================
// NON-GIT STATE ANCHORING (#3873)
// ============================================================================

const SENSITIVE_DIR_BASENAMES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', 'ssh', '.pki',
  '.config', '.claude', '.claude.json', '.codex', '.gemini', '.cursor',
  '.vscode', '.ollama', '.docker', '.npm', '.cache', '.local',
  'desktop', 'documents', 'downloads', 'pictures', 'photos', 'music',
  'movies', 'videos', 'public', 'library',
]);

function sensitiveAbsoluteRoots(): string[] {
  const roots: string[] = [];
  const home = (() => { try { return resolve(homedir()); } catch { return null; } })();
  const temp = (() => { try { return resolve(tmpdir()); } catch { return null; } })();
  if (home) roots.push(home);
  if (temp) roots.push(temp);
  if (process.platform === 'win32') {
    roots.push('C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
    const drive = (home && /^[a-zA-Z]:/.exec(home))?.[0];
    if (drive) roots.push(`${drive}\\Windows`, `${drive}\\Program Files`, `${drive}\\Program Files (x86)`, `${drive}\\ProgramData`);
  } else {
    roots.push('/', '/tmp', '/var', '/usr', '/etc', '/opt', '/private/var', '/private/tmp');
  }
  return roots;
}

function isFilesystemRoot(dir: string): boolean {
  return dirname(dir) === dir;
}

/** Return true when state must not be anchored at this directory. */
export function isSensitiveStateLocation(dir: string): boolean {
  let candidate: string;
  try {
    candidate = resolve(dir);
  } catch {
    return true;
  }
  const home = (() => { try { return resolve(homedir()); } catch { return null; } })();
  let cursor = candidate;
  for (;;) {
    const name = basename(cursor);
    const lowerName = name.toLowerCase();
    if (home && cursor === candidate && (cursor === home || (process.platform === 'win32' && cursor.toLowerCase() === home.toLowerCase()))) return true;
    if (name.startsWith('.') && name !== OmcPaths.ROOT) return true;
    if (SENSITIVE_DIR_BASENAMES.has(lowerName)) return true;
    if (isFilesystemRoot(cursor)) break;
    cursor = dirname(cursor);
  }
  return sensitiveAbsoluteRoots().some((root) => candidate === root || (process.platform === 'win32' && candidate.toLowerCase() === root.toLowerCase()));
}

function resolveNonGitFallbackRoot(): string {
  const home = resolve(homedir());
  if (isFilesystemRoot(home)) {
    throw new Error('Cannot resolve a safe non-git OMC state root: home resolves to the filesystem root.');
  }
  return home;
}

/**
 * Resolve a stable anchor directory for a non-git cwd.
 * Existing safe `.omc/` ancestors are adopted; otherwise `$HOME/.omc` is used.
 * This function never creates or deletes state.
 */
export function resolveNonGitStateAnchor(startDir?: string): string {
  let current: string;
  try {
    current = resolve(startDir || process.cwd());
    try { current = realpathSync(current); } catch { /* keep lexical path for a missing cwd */ }
  } catch {
    current = resolveNonGitFallbackRoot();
  }

  const cached = nonGitAnchorCacheMap.get(current);
  if (cached !== undefined) return cached;

  let cursor = current;
  let anchor: string | undefined;
  for (let depth = 0; depth < 128; depth++) {
    if (!isSensitiveStateLocation(cursor)) {
      try {
        const candidate = join(cursor, OmcPaths.ROOT);
        const candidateStat = lstatSync(candidate);
        const safeSymlink = candidateStat.isSymbolicLink() && (() => {
          try {
            return !isSensitiveStateLocation(realpathSync(candidate)) && statSync(candidate).isDirectory();
          } catch {
            return false;
          }
        })();
        if (candidateStat.isDirectory() || safeSymlink) {
          anchor = cursor;
          break;
        }
      } catch {
        // Missing or inaccessible legacy roots are ignored.
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (anchor) {
    if (nonGitAnchorCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = nonGitAnchorCacheMap.keys().next().value;
      if (oldest !== undefined) nonGitAnchorCacheMap.delete(oldest);
    }
    nonGitAnchorCacheMap.set(current, anchor);
    return anchor;
  }
  return resolveNonGitFallbackRoot();
}

/**
 * Resolve the state-anchor root for an optional worktreeRoot argument.
 * Explicit git-backed directories retain the historical literal contract;
 * non-git directories use the stable non-git anchor.
 */
function resolveStateAnchorRoot(worktreeRoot?: string): string {
  if (worktreeRoot) return resolveSuperprojectRoot(worktreeRoot) || worktreeRoot;
  return getWorktreeRoot() || resolveNonGitStateAnchor();
}

/**
 * Get the literal git toplevel for a directory: `git rev-parse --show-toplevel`
 * with NO submodule→superproject climb. Returns null if not in a git repository.
 *
 * SECURITY: this is the correct primitive for path-restriction / containment
 * checks. A tool operating inside a submodule must be confined to that submodule
 * working tree, not the parent superproject. Use this — NOT getWorktreeRoot() —
 * for boundary validation (getWorktreeRoot climbs to the superproject for state
 * anchoring and would widen the boundary across submodule borders; see #3349
 * and the Codex review on PR #3350).
 */
type GitTopLevelProbe =
  | { status: 'ok'; root: string }
  | { status: 'not_a_repository' }
  | { status: 'git_missing' }
  | { status: 'probe_failed'; detail: string };

/**
 * Injectable `git rev-parse --show-toplevel` runner for tests (#3858).
 * Throw to simulate spawn/exit failures; return stdout to simulate success.
 */
export type GitShowToplevelProbe = (cwd: string) => string | Buffer;

let gitShowToplevelProbeForTests: GitShowToplevelProbe | undefined;

export function setGitShowToplevelProbeForTests(probe?: GitShowToplevelProbe): void {
  gitShowToplevelProbeForTests = probe;
}

function gitErrorStderr(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const err = error as { stderr?: Buffer | string; message?: string };
  if (Buffer.isBuffer(err.stderr)) {
    return err.stderr.toString('utf8');
  }
  if (typeof err.stderr === 'string') {
    return err.stderr;
  }
  return typeof err.message === 'string' ? err.message : '';
}

function isGitCommandPath(path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }
  const base = basename(path);
  return base === 'git' || base === 'git.exe' || base === 'git.cmd' || base === 'git.bat';
}

function isConfirmedGitExecutableNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    code?: string;
    path?: string;
    syscall?: string;
    status?: number | null;
    signal?: NodeJS.Signals | string | null;
    killed?: boolean;
  };
  if (err.code !== 'ENOENT') {
    return false;
  }
  if (err.killed === true) {
    return false;
  }
  if (typeof err.status === 'number') {
    return false;
  }
  if (typeof err.signal === 'string' && err.signal.length > 0) {
    return false;
  }
  const syscall = typeof err.syscall === 'string' ? err.syscall.toLowerCase() : '';
  if (!syscall.includes('spawn')) {
    return false;
  }
  return syscall.includes('git') || isGitCommandPath(err.path);
}

function isNotAGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    status?: number;
    code?: string;
    signal?: NodeJS.Signals | string | null;
  };
  if (err.code === 'ENOENT' || err.code === 'ETIMEDOUT' || err.code === 'EACCES') {
    return false;
  }
  if (typeof err.signal === 'string' && err.signal.length > 0) {
    return false;
  }
  const stderr = gitErrorStderr(error);
  return err.status === 128 && /not a git repository/i.test(stderr);
}

function formatGitProbeDetail(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const err = error as {
    code?: string;
    status?: number;
    message?: string;
    signal?: NodeJS.Signals | string | null;
    killed?: boolean;
  };
  if (err.code === 'ENOENT') {
    return 'git executable not found';
  }
  if (err.code === 'EACCES') {
    return 'git executable not accessible';
  }
  if (err.code === 'ETIMEDOUT' || err.killed === true) {
    return 'git probe timed out';
  }
  if (typeof err.signal === 'string' && err.signal.length > 0) {
    return `git killed by ${err.signal}`;
  }
  const stderr = gitErrorStderr(error).trim();
  if (stderr.length > 0) {
    return stderr.split('\n')[0] ?? stderr;
  }
  if (typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  if (typeof err.status === 'number') {
    return `git exited ${err.status}`;
  }
  return 'unknown git probe failure';
}

function findGitMetadataDir(start: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function expandPathForCompare(path: string): string | null {
  const normalized = resolve(path);
  try {
    return realpathSync.native(normalized);
  } catch {
    try {
      return realpathSync(normalized);
    } catch {
      return null;
    }
  }
}

function canonicalizeExistingPath(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = expandPathForCompare(left);
  const b = expandPathForCompare(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (process.platform !== 'win32') {
    return false;
  }
  const fold = (value: string): string => value.replaceAll('/', '\\').toLowerCase();
  return fold(a) === fold(b);
}

function isCredibleGitWorktreeRoot(root: string): boolean {
  try {
    if (!statSync(root).isDirectory()) {
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

function classifyGitShowToplevelStdout(stdout: string, cwd: string): GitTopLevelProbe {
  const root = stdout.trim();
  if (root.length === 0 || !isAbsolute(root) || !isCredibleGitWorktreeRoot(root)) {
    return { status: 'probe_failed', detail: 'malformed git toplevel output' };
  }
  const cwdReal = canonicalizeExistingPath(cwd);
  if (!cwdReal) {
    return { status: 'probe_failed', detail: 'malformed git toplevel output' };
  }
  const metadataDir = findGitMetadataDir(cwdReal);
  if (!metadataDir || !sameCanonicalPath(metadataDir, root)) {
    return { status: 'probe_failed', detail: 'malformed git toplevel output' };
  }
  return { status: 'ok', root: canonicalizeExistingPath(metadataDir) ?? metadataDir };
}

function classifyGitShowToplevelError(error: unknown): GitTopLevelProbe {
  if (isNotAGitRepositoryError(error)) {
    return { status: 'not_a_repository' };
  }
  if (isConfirmedGitExecutableNotFound(error)) {
    return { status: 'git_missing' };
  }
  return { status: 'probe_failed', detail: formatGitProbeDetail(error) };
}

function runGitShowToplevel(cwd: string): string {
  if (gitShowToplevelProbeForTests) {
    const result = gitShowToplevelProbeForTests(cwd);
    return Buffer.isBuffer(result) ? result.toString('utf8') : result;
  }
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 5000,
  });
}

function probeGitTopLevel(cwd: string): GitTopLevelProbe {
  // Never cache security decisions: PATH, the git executable, and .git
  // metadata can change between calls in the same process.
  try {
    return classifyGitShowToplevelStdout(runGitShowToplevel(cwd), cwd);
  } catch (error) {
    return classifyGitShowToplevelError(error);
  }
}

export function getGitTopLevel(cwd?: string): string | null {
  const probe = probeGitTopLevel(cwd || process.cwd());
  return probe.status === 'ok' ? probe.root : null;
}


function formatGitProbeFailedMessage(workingDirectory: string): string {
  return (
    `workingDirectory '${workingDirectory}' git probe failed and was not used. ` +
    `Cross-repository access is not permitted; pass a path inside the current repository or start the session there.`
  );
}

/**
 * Get the state-anchor "worktree root" for a directory.
 *
 * When cwd is inside a git submodule this climbs to the outermost superproject
 * working tree so `.omc/` state anchors to the monorepo root rather than
 * polluting the submodule working tree (#3349). For normal repos and linked
 * worktrees (no superproject) it returns the literal git toplevel unchanged.
 * Returns null if not in a git repository.
 *
 * SECURITY: do NOT use this for path-restriction / containment checks — the
 * submodule climb widens the boundary across submodule borders. Use
 * getGitTopLevel() for confinement.
 */
export function getWorktreeRoot(cwd?: string): string | null {
  const effectiveCwd = cwd || process.cwd();

  // Return cached value if present (LRU: move to end on access)
  if (worktreeCacheMap.has(effectiveCwd)) {
    const root = worktreeCacheMap.get(effectiveCwd)!;
    // Refresh insertion order for LRU eviction
    worktreeCacheMap.delete(effectiveCwd);
    worktreeCacheMap.set(effectiveCwd, root);
    return root || null;
  }

  // Prefer the superproject working tree when cwd is inside a submodule (#3349);
  // otherwise the literal git toplevel.
  const root = resolveSuperprojectRoot(effectiveCwd) || getGitTopLevel(effectiveCwd);
  if (!root) {
    // Not in a git repository - do NOT cache fallback
    // so that if directory becomes a git repo later, we re-detect
    return null;
  }

  // Evict oldest entry when at capacity
  if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = worktreeCacheMap.keys().next().value;
    if (oldest !== undefined) {
      worktreeCacheMap.delete(oldest);
    }
  }
  worktreeCacheMap.set(effectiveCwd, root);
  return root;
}

/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export function validatePath(inputPath: string): void {
  // Reject explicit path traversal
  if (inputPath.includes('..')) {
    throw new Error(`Invalid path: path traversal not allowed (${inputPath})`);
  }

  // Reject absolute paths - use isAbsolute() for cross-platform coverage
  // Covers: /unix, ~/home, C:\windows, D:/windows, \\UNC
  if (inputPath.startsWith('~') || isAbsolute(inputPath)) {
    throw new Error(`Invalid path: absolute paths not allowed (${inputPath})`);
  }
}

// ============================================================================
// OMC_STATE_DIR SUPPORT (Issue #1014)
// ============================================================================

/** Track which dual-dir warnings have been logged to avoid repeated warnings */
const dualDirWarnings = new Set<string>();

/** Track which workspace anchors have already had sibling-scan warnings emitted (once per process) */
const siblingRetrofitWarned = new Set<string>();

/**
 * Scan sibling subdirs of a workspace anchor for pre-existing .omc/state/ content.
 * Deduplicated per session via a disk marker so repeated hook firings within the
 * same session don't re-stat siblings or re-emit. A fresh session (new sessionId)
 * will re-warn — intentional, since the user may not have seen the prior warning.
 *
 * Call this once per session (e.g. from session-start.mjs) rather than on every
 * getOmcRoot() invocation to keep the hot path free of readdirSync calls.
 */
export function warnSiblingRetrofit(workspaceAnchor: string, sessionId?: string): void {
  if (siblingRetrofitWarned.has(workspaceAnchor)) return;

  // Persistent per-session disk dedupe
  const sharedOmc = join(workspaceAnchor, OmcPaths.ROOT);
  if (sessionId) {
    const markerPath = join(sharedOmc, 'state', `sibling-retrofit-warned-${sessionId}.json`);
    if (existsSync(markerPath)) {
      siblingRetrofitWarned.add(workspaceAnchor);
      return;
    }
  }

  siblingRetrofitWarned.add(workspaceAnchor);

  let entries: import('fs').Dirent<string>[];
  try {
    entries = readdirSync(workspaceAnchor, { withFileTypes: true, encoding: 'utf-8' }) as import('fs').Dirent<string>[];
  } catch {
    return;
  }

  const legacyDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryName = entry.name as string;
    const siblingStateDir = join(workspaceAnchor, entryName, OmcPaths.ROOT, 'state');
    if (existsSync(siblingStateDir)) {
      legacyDirs.push(join(workspaceAnchor, entryName, OmcPaths.ROOT));
    }
  }

  if (legacyDirs.length === 0) return;

  const dirList = legacyDirs.map(d => `  - ${d}`).join('\n');
  process.stderr.write(
    `[omc] workspace-retrofit warning: .omc-workspace anchor found at ${workspaceAnchor}\n` +
    `  but sibling repos have pre-existing local .omc/state/ content:\n${dirList}\n` +
    `  Shared state will go to: ${sharedOmc}\n` +
    `  To migrate legacy state: OMC_MIGRATE_LEGACY_STATE=1 omc setup\n` +
    `  Or manually copy state files to ${sharedOmc}/state/\n`
  );

  // Write disk marker so subsequent hook firings in the same session stay silent
  if (sessionId) {
    try {
      const stateDir = join(sharedOmc, 'state');
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
      const markerPath = join(stateDir, `sibling-retrofit-warned-${sessionId}.json`);
      writeFileSync(markerPath, JSON.stringify({ warnedAt: new Date().toISOString(), anchor: workspaceAnchor }));
    } catch {
      // Non-fatal — dedupe falls back to in-memory Set for this process
    }
  }
}

/**
 * Clear the sibling retrofit warning cache (useful for testing).
 * Also removes any disk markers under the given omcStateDir when provided.
 * @internal
 */
export function clearSiblingRetrofitWarnings(omcStateDir?: string): void {
  siblingRetrofitWarned.clear();
  if (omcStateDir) {
    try {
      const stateDir = join(omcStateDir, 'state');
      if (!existsSync(stateDir)) return;
      const entries = readdirSync(stateDir, { withFileTypes: true, encoding: 'utf-8' }) as import('fs').Dirent<string>[];
      for (const entry of entries) {
        const name = entry.name as string;
        if (name.startsWith('sibling-retrofit-warned-') && name.endsWith('.json')) {
          try { unlinkSync(join(stateDir, name)); } catch { /* non-fatal */ }
        }
      }
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Clear the dual-directory warning cache (useful for testing).
 * @internal
 */
export function clearDualDirWarnings(): void {
  dualDirWarnings.clear();
}

/**
 * Get a stable project identifier for centralized state storage.
 *
 * Uses a hybrid strategy:
 * 1. Git remote URL hash (stable across worktrees and clones of the same repo)
 * 2. Fallback to worktree root path hash (for local-only repos without remotes)
 *
 * Format: `{dirName}-{hash}` where hash is first 16 chars of SHA-256.
 * Example: `my-project-a1b2c3d4e5f6g7h8`
 *
 * @param worktreeRoot - Optional worktree root path
 * @returns A stable project identifier string
 */
export function getProjectIdentifier(worktreeRoot?: string): string {
  // NOTE: intentionally does NOT apply the submodule→superproject climb. The
  // project identifier is a state *identity* (used for OMC_STATE_DIR centralized
  // dirs, which never live inside the working tree), and a submodule must keep
  // its OWN identity — see the "should not change identifier for submodules"
  // test. The #3349 climb applies only to the on-disk `.omc/` *location*
  // (getOmcRoot's default branch), not to identity. The no-arg fallback uses
  // getGitTopLevel() (literal toplevel, no climb) so a process launched inside a
  // submodule still resolves the submodule's own identity, and findWorkspaceRoot
  // below sees the unclimbed root so an inner `.omc-workspace` marker is honored.
  const root = worktreeRoot || getGitTopLevel() || process.cwd();

  // Workspace marker can supply a stable, user-controlled identifier.
  // This wins over git remote so multi-repo workspaces have one consistent ID.
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot) {
    const cfg = readWorkspaceMarkerConfig(workspaceRoot);
    if (cfg.id && typeof cfg.id === 'string' && cfg.id.trim()) {
      const safeId = cfg.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      const hash = createHash('sha256').update(safeId).digest('hex').slice(0, 16);
      return `${safeId}-${hash}`;
    }
    // No explicit id — derive a stable identifier from the workspace path so
    // sibling subrepos inside the same workspace share one ID.
    const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
    const dirName = basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${dirName}-${hash}`;
  }

  let source: string;
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    source = remoteUrl || root;
  } catch {
    // No git remote (local-only repo or not a git repo) — use path
    source = root;
  }

  // For linked worktrees (created via `git worktree add`), resolve to the
  // primary repository root so all worktrees of the same repo produce the
  // same project identifier. Without this, sibling worktrees like
  // `repo.feature-x/` and `repo.feature-y/` would create separate state
  // directories despite sharing the same remote URL hash.
  let primaryRoot = root;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    // Only resolve when --git-common-dir points to a .git directory.
    // - Linked worktrees: returns <primary>/.git → dirname gives primary root ✓
    // - Submodules: returns <super>/.git/modules/<name> → skip (wrong parent)
    // - Bare repos: returns the repo root itself (no .git suffix) → skip
    //   (dirname would go up to the parent folder, colliding sibling repos)
    const isGitDir = basename(commonDir) === '.git';
    const isSubmodule = commonDir.includes(`${sep}.git${sep}modules`);
    if (isGitDir && !isSubmodule) {
      const resolved = dirname(commonDir);
      if (resolved && resolved !== root) {
        primaryRoot = resolved;
      }
    }
  } catch {
    // Not a git repo or command failed — fall back to worktree root
  }

  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dirName = basename(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${dirName}-${hash}`;
}

/**
 * Get the .omc root directory path.
 *
 * When OMC_STATE_DIR is set, returns $OMC_STATE_DIR/{project-identifier}/
 * instead of {worktree}/.omc/. This allows centralized state storage that
 * survives worktree deletion.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the omc root directory
 */
export function getOmcRoot(worktreeRoot?: string): string {
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    // Centralized state lives at $OMC_STATE_DIR/{projectId} — outside the
    // working tree — so the #3349 stray-`.omc`-in-submodule problem does not
    // apply here. Identity must NOT climb: use the literal git toplevel
    // (getGitTopLevel) for the no-arg fallback so a submodule launched without
    // an explicit worktreeRoot keeps its own centralized id rather than merging
    // into the parent project's (preserves submodule identity).
    const root = worktreeRoot || getGitTopLevel() || process.cwd();
    const workspaceRoot = findWorkspaceRoot(root);
    const projectId = !worktreeRoot && !workspaceRoot && !getGitTopLevel(root)
      ? 'non-git'
      : getProjectIdentifier(root);
    const centralizedPath = join(customDir, projectId);

    // Log notice if both legacy .omc/ and new centralized dir exist
    const legacyPath = join(root, OmcPaths.ROOT);
    const warningKey = `${legacyPath}:${centralizedPath}`;
    if (!dualDirWarnings.has(warningKey) && existsSync(legacyPath) && existsSync(centralizedPath)) {
      dualDirWarnings.add(warningKey);
      console.warn(
        `[omc] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. ` +
        `Using centralized dir. Consider migrating data from the legacy dir and removing it.`
      );
    }

    return centralizedPath;
  }

  // Workspace marker overrides git root resolution. This enables multi-repo
  // workspaces where the parent dir is not itself a git repo: all sub-repos
  // share the same .omc/ at the marker location.
  const workspaceAnchor = findWorkspaceRoot(worktreeRoot);
  if (workspaceAnchor && !isSensitiveStateLocation(workspaceAnchor)) {
    return join(workspaceAnchor, OmcPaths.ROOT);
  }

  const root = resolveStateAnchorRoot(worktreeRoot);
  if (isSensitiveStateLocation(root) && !getGitTopLevel(root)) {
    return join(resolveNonGitStateAnchor(root), OmcPaths.ROOT);
  }
  return join(root, OmcPaths.ROOT);
}

/**
 * Resolve a relative path under .omc/ to an absolute path.
 * Validates the path is within the omc boundary.
 *
 * @param relativePath - Path relative to .omc/ (e.g., "state/ralph.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape omc boundary
 */
export function resolveOmcPath(relativePath: string, worktreeRoot?: string): string {
  validatePath(relativePath);

  const omcDir = getOmcRoot(worktreeRoot);
  const fullPath = normalize(resolve(omcDir, relativePath));

  // Verify resolved path is still under omc directory
  const relativeToOmc = relative(omcDir, fullPath);
  if (relativeToOmc.startsWith('..') || relativeToOmc.startsWith(sep + '..')) {
    throw new Error(`Path escapes omc boundary: ${relativePath}`);
  }

  return fullPath;
}

/**
 * Resolve a state file path.
 *
 * State files follow the naming convention: {mode}-state.json
 * Examples: ralph-state.json, ultrawork-state.json, autopilot-state.json
 *
 * @deprecated Use resolveSessionStatePaths instead.
 * @param stateName - State name (e.g., "ralph", "ultrawork", or "ralph-state")
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to state file
 */
export function resolveStatePath(stateName: string, worktreeRoot?: string): string {
  // Normalize: ensure -state suffix is present, then add .json
  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  return resolveOmcPath(`state/${normalizedName}.json`, worktreeRoot);
}

/**
 * Ensure a directory exists under .omc/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omc/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export function ensureOmcDir(relativePath: string, worktreeRoot?: string): string {
  const fullPath = resolveOmcPath(relativePath, worktreeRoot);

  if (!existsSync(fullPath)) {
    try {
      mkdirSync(fullPath, { recursive: true });
    } catch (err) {
      // On Windows, concurrent hooks can race past the existsSync check and
      // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return fullPath;
}

/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export function getWorktreeNotepadPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'notepad.md');
}

/**
 * Get the absolute path to the project memory file.
 */
export function getWorktreeProjectMemoryPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'project-memory.json');
}

/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export function resolvePlanPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  return join(getOmcRoot(worktreeRoot), 'plans', `${planName}.md`);
}

/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export function resolveResearchPath(name: string, worktreeRoot?: string): string {
  validatePath(name);
  return join(getOmcRoot(worktreeRoot), 'research', name);
}

/**
 * Resolve the logs directory path.
 */
export function resolveLogsPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'logs');
}

/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export function resolveWisdomPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  return join(getOmcRoot(worktreeRoot), 'notepads', planName);
}

/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean {
  const omcRoot = getOmcRoot(worktreeRoot);
  const normalizedPath = normalize(absolutePath);
  const normalizedOmc = normalize(omcRoot);
  return normalizedPath.startsWith(normalizedOmc + sep) || normalizedPath === normalizedOmc;
}

/**
 * Ensure all standard .omc subdirectories exist.
 */
export function ensureAllOmcDirs(worktreeRoot?: string): void {
  const omcRoot = getOmcRoot(worktreeRoot);
  const subdirs = ['', 'state', 'plans', 'research', 'logs', 'notepads', 'drafts'];
  for (const subdir of subdirs) {
    const fullPath = subdir ? join(omcRoot, subdir) : omcRoot;
    if (!existsSync(fullPath)) {
      try {
        mkdirSync(fullPath, { recursive: true });
      } catch (err) {
        // On Windows, concurrent hooks can race past the existsSync check and
        // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
}

/**
 * Clear the worktree cache (useful for testing).
 */
export function clearWorktreeCache(): void {
  worktreeCacheMap.clear();
  superprojectCacheMap.clear();
  workspaceCacheMap.clear();
  nonGitAnchorCacheMap.clear();
}

// ============================================================================
// SESSION-SCOPED STATE PATHS
// ============================================================================

/** Regex for valid session IDs: alphanumeric, hyphens, underscores, max 256 chars */
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

// ============================================================================
// AUTOMATIC PROCESS SESSION ID (Issue #456)
// ============================================================================

/**
 * Auto-generated session ID for the current process.
 * Uses PID + process start timestamp to be unique even if PIDs are reused.
 * Generated once at module load time and stable for the process lifetime.
 */
let processSessionId: string | null = null;

/**
 * Get or generate a unique session ID for the current process.
 *
 * Format: `pid-{PID}-{startTimestamp}`
 * Example: `pid-12345-1707350400000`
 *
 * This prevents concurrent Claude Code instances in the same repo from
 * sharing state files (Issue #456). The ID is stable for the process
 * lifetime and unique across concurrent processes.
 *
 * @returns A unique session ID for the current process
 */
export function getProcessSessionId(): string {
  if (!processSessionId) {
    // process.pid is unique among concurrent processes.
    // Adding a timestamp handles PID reuse after process exit.
    const pid = process.pid;
    const startTime = Date.now();
    processSessionId = `pid-${pid}-${startTime}`;
  }
  return processSessionId;
}

/**
 * Reset the process session ID (for testing only).
 * @internal
 */
export function resetProcessSessionId(): void {
  processSessionId = null;
}

/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export function validateSessionId(sessionId: string): void {
  if (!sessionId) {
    throw new Error('Session ID cannot be empty');
  }
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error(`Invalid session ID: path traversal not allowed (${sessionId})`);
  }
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(`Invalid session ID: must be alphanumeric with hyphens/underscores, max 256 chars (${sessionId})`);
  }
}

/**
 * Validate a transcript path to prevent arbitrary file reads.
 * Transcript files should only be read from known Claude directories.
 *
 * @param transcriptPath - The transcript path to validate
 * @returns true if path is valid, false otherwise
 */
export function isValidTranscriptPath(transcriptPath: string): boolean {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return false;
  }

  // Reject path traversal
  if (transcriptPath.includes('..')) {
    return false;
  }

  // Must be absolute
  if (!isAbsolute(transcriptPath) && !transcriptPath.startsWith('~')) {
    return false;
  }

  // Expand home directory if present
  let expandedPath = transcriptPath;
  if (transcriptPath.startsWith('~')) {
    expandedPath = join(homedir(), transcriptPath.slice(1));
  }

  // Normalize and check it's within allowed directories
  const normalized = normalize(expandedPath);
  const home = homedir();

  // Allowed: [$CLAUDE_CONFIG_DIR|~/.claude], ~/.omc/..., system temp dir
  const allowedPrefixes = [
    getClaudeConfigDir(),
    join(home, '.omc'),
    tmpdir(), // honors $TMPDIR; covers /tmp and macOS /var/folders defaults
    '/tmp',
    '/var/folders', // macOS temp
  ];

  return allowedPrefixes.some((prefix) => {
    const rel = relative(prefix, normalized);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}


/**
 * Resolve a session-scoped state file path.
 * Path: {omcRoot}/state/sessions/{sessionId}/{mode}-state.json
 *
 * @deprecated Use resolveSessionStatePaths instead.
 * @param stateName - State name (e.g., "ralph", "ultrawork")
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session-scoped state file
 */
export function resolveSessionStatePath(stateName: string, sessionId: string, worktreeRoot?: string): string {
  validateSessionId(sessionId);

  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  return resolveOmcPath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
}

// ============================================================================
// SessionStatePaths — branded struct return (multi-repo Wave A)
// ============================================================================

/**
 * Branded path types prevent silently passing a read-only fallback path to a
 * writer (or vice versa) across 19+ call sites. The brand is intentionally
 * structural-only (no runtime cost) — TS-level discrimination.
 *
 * Producer of the brand: `resolveSessionStatePaths()` exclusively.
 * Consumers (writeModeState / readModeState etc.) accept only the branded
 * variant for their direction, so a hook that grabs `effectiveRead` when it
 * meant `effectiveWrite` becomes a compile-time error.
 */
export type ReadPath = string & { readonly __brand: 'ReadPath' };
export type WritePath = string & { readonly __brand: 'WritePath' };

/**
 * Resolved paths for a session-scoped state file. Use `effectiveRead` for
 * reads (probes session-scoped first, then legacy fallback) and
 * `effectiveWrite` for writes (always session-scoped when sessionId is
 * provided; legacy root only when sessionId is absent — back-compat mode).
 *
 * Fields:
 *  - `sessionScoped`: `.omc/state/sessions/{sessionId}/{name}.json` (or empty when no sid).
 *  - `legacy`: `.omc/state/{name}.json` — preserved for backwards-compat reads.
 *  - `effectiveRead`: brand-typed path the caller should READ from.
 *    When sid is set and the session-scoped file exists, this is sessionScoped;
 *    otherwise legacy.
 *  - `effectiveWrite`: brand-typed path the caller should WRITE to.
 *    When sid is set, always sessionScoped. When sid is absent, legacy.
 */
export interface SessionStatePaths {
  sessionScoped: string;
  legacy: string;
  effectiveRead: ReadPath;
  effectiveWrite: WritePath;
}

/**
 * Options for resolveSessionStatePaths.
 *
 * `migrate`: opt-in one-shot legacy→session copy. Default: false (read-legacy-as-
 * fallback, write session-only). When migrate=true OR `OMC_MIGRATE_LEGACY_STATE=1`
 * is set, callers that wrap their write through a migration helper will copy the
 * legacy file using a `.migrating` sentinel + atomic rename for crash recovery.
 */
export interface ResolveSessionStatePathsOptions {
  migrate?: boolean;
}

/**
 * Canonical session-scoped state path resolver. Returns a branded struct so
 * callers cannot accidentally write to the read-fallback path. See
 * `SessionStatePaths` for field semantics.
 *
 * When `sessionId` is undefined or empty, the function operates in legacy
 * mode: `sessionScoped` is the empty string, both `effectiveRead` and
 * `effectiveWrite` brand the legacy path. This preserves single-plan/single-
 * session repos unchanged.
 *
 * @internal Internal-ish helpers (resolveStatePath, resolveSessionStatePath
 * single-string variant) remain for back-compat but new code should prefer
 * this helper.
 */
export function resolveSessionStatePaths(
  stateName: string,
  sessionId?: string,
  worktreeRoot?: string,
  _opts?: ResolveSessionStatePathsOptions,
): SessionStatePaths {
  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  const legacy = resolveStatePath(stateName, worktreeRoot);
  if (!sessionId) {
    return {
      sessionScoped: '',
      legacy,
      effectiveRead: legacy as ReadPath,
      effectiveWrite: legacy as WritePath,
    };
  }
  validateSessionId(sessionId);
  const sessionScoped = resolveOmcPath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
  // effectiveRead probes session-scoped first; fall back to legacy when the
  // session-scoped file does not yet exist (first-read back-compat).
  const effectiveRead = (existsSync(sessionScoped) ? sessionScoped : legacy) as ReadPath;
  return {
    sessionScoped,
    legacy,
    effectiveRead,
    effectiveWrite: sessionScoped as WritePath,
  };
}

/**
 * Whether opt-in legacy→session migration is enabled for this process.
 * Checked by writers that wrap migration around their write step.
 */
export function isLegacyStateMigrationEnabled(): boolean {
  return process.env.OMC_MIGRATE_LEGACY_STATE === '1';
}

/**
 * Get the session state directory path.
 * Path: {omcRoot}/state/sessions/{sessionId}/
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session state directory
 */
export function getSessionStateDir(sessionId: string, worktreeRoot?: string): string {
  validateSessionId(sessionId);
  return join(getOmcRoot(worktreeRoot), 'state', 'sessions', sessionId);
}

/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export function listSessionIds(worktreeRoot?: string): string[] {
  const sessionsDir = join(getOmcRoot(worktreeRoot), 'state', 'sessions');

  if (!existsSync(sessionsDir)) {
    return [];
  }

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && SESSION_ID_REGEX.test(entry.name))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * Ensure the session state directory exists.
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the session state directory
 */
export function ensureSessionStateDir(sessionId: string, worktreeRoot?: string): string {
  const sessionDir = getSessionStateDir(sessionId, worktreeRoot);

  if (!existsSync(sessionDir)) {
    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      // On Windows, concurrent hooks can race past the existsSync check and
      // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return sessionDir;
}

/**
 * Resolve a directory path to its git worktree root.
 *
 * Walks up from `directory` using `git rev-parse --show-toplevel`.
 * Falls back to `getWorktreeRoot(process.cwd())`, then `process.cwd()`.
 *
 * This ensures .omc/ state is always written at the worktree root,
 * even when called from a subdirectory (fixes #576).
 *
 * @param directory - Any directory inside a git worktree (optional)
 * @returns The worktree root (never a subdirectory)
 */
export function resolveToWorktreeRoot(directory?: string): string {
  // The resolved root feeds BOTH on-disk `.omc/` placement AND, under
  // OMC_STATE_DIR, the centralized-state *identity* (getProjectIdentifier).
  // The #3349 submodule→superproject climb exists ONLY to place `.omc/` at the
  // superproject working tree; it must NOT change a submodule's centralized
  // identity (that contract is documented on getProjectIdentifier/getOmcRoot).
  // So when OMC_STATE_DIR is set — where on-disk placement is moot and identity
  // is all that matters — resolve to the literal git toplevel (no climb) so a
  // hook/session launched inside a submodule keeps its own id instead of
  // merging into the parent superproject's. Non-submodule repos and linked
  // worktrees are unaffected: with no superproject the two resolvers are equal.
  // See PR #3350 Codex review (hook normalization / submodule identity).
  const resolveRoot = process.env.OMC_STATE_DIR ? getGitTopLevel : getWorktreeRoot;
  if (directory) {
    const resolved = resolve(directory);
    const root = resolveRoot(resolved);
    if (root) return root;

    console.error('[worktree] non-git directory provided, falling back to process root', {
      directory: resolved,
    });
  }
  // Fallback: derive from process CWD (the MCP server / CLI entry point)
  return resolveRoot(process.cwd()) || process.cwd();
}

// ============================================================================
// TRANSCRIPT PATH RESOLUTION (Issue #1094)
// ============================================================================

/**
 * Resolve a Claude Code transcript path that may be mismatched in worktree sessions.
 *
 * When Claude Code runs inside a worktree (.claude/worktrees/X), it encodes the
 * worktree CWD into the project directory path, creating a transcript_path like:
 *   ~/.claude/projects/-path-to-project--claude-worktrees-X/<session>.jsonl
 *
 * But the actual transcript lives at the original project's path:
 *   ~/.claude/projects/-path-to-project/<session>.jsonl
 *
 * Claude Code encodes `/` and `.` as `-`. The `.claude/worktrees/`
 * segment becomes `-claude-worktrees-`, preceded by a `-` from the path
 * separator, yielding the distinctive `--claude-worktrees-` pattern in the
 * encoded directory name.
 *
 * This function detects the mismatch and resolves to the correct path.
 *
 * @param transcriptPath - The transcript_path from Claude Code hook input
 * @param cwd - Optional CWD for fallback detection
 * @returns The resolved transcript path (original if already correct or no resolution found)
 */
export function resolveTranscriptPath(transcriptPath: string | undefined, cwd?: string): string | undefined {
  if (!transcriptPath) return undefined;

  // Fast path: if the file already exists, no resolution needed
  if (existsSync(transcriptPath)) return transcriptPath;

  // Strategy 1: Detect worktree-encoded segment in the transcript path itself.
  // The pattern `--claude-worktrees-` appears when Claude Code encodes a CWD
  // containing `/.claude/worktrees/` (separator `/` → `-`, dot `.` → `-`).
  // Strip everything from this pattern to the next `/` to recover the original
  // project directory encoding.
  const worktreeSegmentPattern = /--claude-worktrees-[^/\\]+/;
  if (worktreeSegmentPattern.test(transcriptPath)) {
    const resolved = transcriptPath.replace(worktreeSegmentPattern, '');
    if (existsSync(resolved)) return resolved;
  }

  // Strategy 2: Use CWD to detect worktree and reconstruct the path.
  // When the CWD contains `<sep>.claude<sep>worktrees<sep>`, we can derive the
  // main project root and look for the transcript there. The marker is
  // normalized so it matches the OS-native separator — on Windows the CWD uses
  // `\`, so a hard-coded `/.claude/worktrees/` would never match.
  const effectiveCwd = cwd || process.cwd();
  const normalizedCwd = normalize(effectiveCwd);
  const worktreeMarker = normalize('/.claude/worktrees/');
  const markerIdx = normalizedCwd.indexOf(worktreeMarker);
  if (markerIdx !== -1) {
    // The marker includes its leading separator, so everything before it is
    // the main project root.
    const mainProjectRoot = normalizedCwd.substring(0, markerIdx);

    // Extract the session filename. basename handles both separators on
    // Windows (transcript_path arrives with `\`) and `/` on POSIX.
    const sessionFile = basename(transcriptPath);
    if (sessionFile) {
      // The projects directory is under the Claude config dir
      const projectsDir = join(getClaudeConfigDir(), 'projects');

      if (existsSync(projectsDir)) {
        // Encode the main project root the same way Claude Code does.
        const encodedMain = encodeProjectPath(mainProjectRoot);
        const resolvedPath = join(projectsDir, encodedMain, sessionFile);
        if (existsSync(resolvedPath)) return resolvedPath;
      }
    }
  }

  // Strategy 3: Detect native git worktree via git-common-dir.
  // When CWD is a linked worktree (created by `git worktree add`), the
  // transcript path encodes the worktree CWD, but the file lives under
  // the main repo's encoded path. Use `git rev-parse --git-common-dir`
  // to find the main repo root and re-encode.
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
    // For linked worktrees, git-common-dir is <repo>/.git/worktrees/<name>
    // so dirname gives <repo>/.git/worktrees — navigate up to the actual repo root
    let mainRepoRoot = dirname(absoluteCommonDir);
    if (mainRepoRoot.endsWith(join('.git', 'worktrees'))) {
      mainRepoRoot = dirname(dirname(mainRepoRoot));
    }
    // Resolve symlinks for consistent comparison (e.g. /tmp -> /private/tmp on macOS,
    // ecryptfs $HOME on Linux, autofs /home, etc.)
    try { mainRepoRoot = realpathSync(mainRepoRoot); } catch { /* keep as-is */ }

    const worktreeTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    if (mainRepoRoot !== worktreeTop) {
      // basename handles `\` (Windows transcript_path) and `/` (POSIX).
      const sessionFile = basename(transcriptPath);
      if (sessionFile) {
        const projectsDir = join(getClaudeConfigDir(), 'projects');
        if (existsSync(projectsDir)) {
          const encodedMain = encodeProjectPath(mainRepoRoot);
          const resolvedPath = join(projectsDir, encodedMain, sessionFile);
          if (existsSync(resolvedPath)) return resolvedPath;
        }
      }
    }
  } catch {
    // Not in a git repo or git not available — skip
  }

  // No resolution found — return original path.
  // Callers should handle non-existent paths gracefully.
  return transcriptPath;
}
/**
 * Caller-visible workingDirectory labels for rejection errors (#3858).
 * Retain the original caller-supplied string; never substitute realpath.
 * Trusted root is basename-only so the full host path is not disclosed.
 */
function callerVisibleTrustedRootLabel(trustedRoot: string): string {
  const label = basename(trustedRoot);
  return label.length > 0 ? label : 'current repository';
}

function formatOutsideTrustedRootMessage(workingDirectory: string, trustedRoot: string): string {
  return (
    `workingDirectory '${workingDirectory}' ` +
    `is outside the trusted worktree root '${callerVisibleTrustedRootLabel(trustedRoot)}'.`
  );
}
function attachCanonicalWorkingDirectoryRoots(
  target: object,
  providedRoot: string,
  trustedRoot: string,
): void {
  canonicalWorkingDirectoryRoots.set(target, { providedRoot, trustedRoot });
}

export function getCanonicalWorkingDirectoryRoots(
  target: object,
): { providedRoot: string; trustedRoot: string } {
  const roots = canonicalWorkingDirectoryRoots.get(target);
  if (!roots) {
    throw new Error('canonical working directory roots are not attached');
  }
  return roots;
}

function canonicalRootAliases(root: string): string[] {
  if (root.length === 0) {
    return [];
  }
  const aliases = new Set<string>([root]);
  try {
    aliases.add(pathToFileURL(root).href);
  } catch {
    // Ignore roots that cannot be represented as file URLs.
  }
  try {
    const real = realpathSync(root);
    aliases.add(real);
    aliases.add(pathToFileURL(real).href);
  } catch {
    // Root may not exist on disk (synthetic test paths).
  }
  if (sep === '\\') {
    aliases.add(root.replaceAll('\\', '/'));
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

function redactCanonicalRoots(text: string, providedRoot: string, trustedRoot: string): string {
  let redacted = text;
  const roots = [...canonicalRootAliases(providedRoot), ...canonicalRootAliases(trustedRoot)]
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    redacted = redacted.split(root).join('<redacted>');
  }
  return redacted;
}
function redactErrorStack(stack: string, providedRoot: string, trustedRoot: string): string {
  const newline = stack.includes('\r\n') ? '\r\n' : '\n';
  const lines = stack.split(/\r?\n/);
  if (lines.length <= 1) {
    return stack;
  }
  const [header, ...frames] = lines;
  return [header, ...frames.map((frame) => redactCanonicalRoots(frame, providedRoot, trustedRoot))].join(newline);
}



function foreignRepositoryResolution(
  providedRoot: string,
  trustedRoot: string,
  callerLabel: string,
): Extract<WorkingDirectoryResolution, { status: 'foreign_repository' }> {
  const resolution = {
    status: 'foreign_repository' as const,
    callerLabel,
  };
  attachCanonicalWorkingDirectoryRoots(resolution, providedRoot, trustedRoot);
  Object.defineProperty(resolution, 'toJSON', {
    enumerable: false,
    writable: false,
    configurable: false,
    value: (): { status: 'foreign_repository'; callerLabel: string } => ({
      status: 'foreign_repository',
      callerLabel,
    }),
  });
  return resolution;
}


/**
 * Validate that a workingDirectory is within the trusted git top-level.
 * The trusted root is derived from process.cwd(), NOT from user input.
 *
 * Always returns a git top-level — never a subdirectory.
 * This prevents .omc/state/ from being created in subdirectories (#576)
 * without widening submodule launches to their superproject.
 *
 * @param workingDirectory - User-supplied working directory
 * @returns The validated worktree root
 * @throws Error if workingDirectory is outside trusted root
 */
export function validateWorkingDirectory(workingDirectory?: string): string {
  const trustedRoot = getGitTopLevel(process.cwd()) || process.cwd();

  if (!workingDirectory) {
    return trustedRoot;
  }

  // Resolve to absolute
  const resolved = resolve(workingDirectory);

  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot;
  }

  // Try to resolve the provided directory to its literal git top-level.
  const providedRoot = getGitTopLevel(resolved);

  if (providedRoot) {
    // Git resolution succeeded — require exact worktree identity.
    let providedRootReal: string;
    try {
      providedRootReal = realpathSync(providedRoot);
    } catch {
      throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }

    if (providedRootReal !== trustedRootReal) {
      console.error('[worktree] workingDirectory resolved to different git worktree root, using trusted root', {
        workingDirectory: resolved,
        providedRoot: providedRootReal,
        trustedRoot: trustedRootReal,
      });
      return trustedRoot;
    }

    return providedRoot;
  }

  // Git resolution failed (lock contention, env issues, non-repo dir).
  // Validate that the raw directory is under the trusted root before falling
  // back — otherwise reject it as truly outside (#576).
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch {
    throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
  }

  const rel = relative(trustedRootReal, resolvedReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(formatOutsideTrustedRootMessage(workingDirectory, trustedRoot));
  }

  if (trustedRootReal === resolvedReal) {
    return trustedRoot;
  }

  // Git-backed sessions still normalize subdirectories to the repository
  // root. A git-less session has no repository root to normalize to, so keep
  // the explicitly requested directory; getOmcRoot() applies the stable
  // non-git anchor and prevents a per-directory .omc/ from being created.
  if (getGitTopLevel(process.cwd())) {
    return trustedRoot;
  }
  return resolvedReal;
}

/**
 * Resolve a state-tool workingDirectory with visible repository-boundary
 * failures. Git sessions may target the same repository or a linked worktree;
 * git-less sessions retain an explicit child directory while still rejecting
 * paths outside the trusted non-git context.
 */
export function resolveStateWorkingDirectory(workingDirectory?: string): string {
  if (!workingDirectory) return validateWorkingDirectory();

  if (getGitTopLevel(process.cwd())) {
    return validateWorkingDirectoryOrLinkedWorktree(workingDirectory);
  }

  // Run the strict resolver first so a mixed git/non-git or foreign-repository
  // request cannot be silently substituted with the startup cwd.
  validateWorkingDirectoryOrLinkedWorktree(workingDirectory);
  const validated = validateWorkingDirectory(workingDirectory);
  return resolveNonGitStateAnchor(validated);
}

function getGitCommonDir(cwd: string): string | null {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return realpathSync(commonDir);
  } catch {
    return null;
  }
}

/**
 * Result of resolving a caller-provided workingDirectory against the trusted
 * startup repository (#3858).
 *
 * - `ok`: the directory is usable as the wiki/root; `root` is either the
 *   trusted root (default, subdirectory, or non-repo directory under it) or an
 *   accepted same-repo/same-common-dir worktree root.
 * - `foreign_repository`: the directory belongs to a different git repository.
 *   Callers MUST NOT use it and MUST NOT silently fall back to the trusted
 *   root; they are expected to surface the rejection to their caller.
 *
 * Canonical roots are stored in a WeakMap keyed by the resolution or error
 * object. They are not own properties and cannot be recovered by
 * JSON.stringify, object spread, structuredClone, showHidden inspection,
 * or getOwnPropertyNames. Internal consumers use
 * `getCanonicalWorkingDirectoryRoots()`. Caller-visible text must use
 * `callerLabel` and a basename-only trusted-root label.
 */
export type WorkingDirectoryResolution =
  | { status: 'ok'; root: string }
  | {
      status: 'foreign_repository';
      callerLabel: string;
    };

/**
 * Typed error thrown when a workingDirectory resolves to a different git
 * repository than the trusted startup repository. The rejection must reach the
 * tool caller; it is never silently substituted (#3858).
 *
 * `.message` is the caller-visible contract: the original workingDirectory
 * label plus a basename-only trusted-root identity. Canonical roots are
 * WeakMap-only internal diagnostics. `callerLabel` is required and enumerable.
 */
export class ForeignWorkingDirectoryError extends Error {
  readonly callerLabel: string;

  constructor(providedRoot: string, trustedRoot: string, callerLabel: string) {
    super(
      `workingDirectory '${callerLabel}' belongs to a different repository than '${callerVisibleTrustedRootLabel(trustedRoot)}' and was not used. ` +
        `Cross-repository access is not permitted; pass a path inside the current repository or start the session there.`
    );
    this.name = 'ForeignWorkingDirectoryError';
    this.callerLabel = callerLabel;
    attachCanonicalWorkingDirectoryRoots(this, providedRoot, trustedRoot);
    Object.defineProperty(this, 'stack', {
      value: redactErrorStack(this.stack ?? `${this.name}: ${this.message}`, providedRoot, trustedRoot),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  toJSON(): { name: string; message: string; callerLabel: string } {
    return {
      name: this.name,
      message: this.message,
      callerLabel: this.callerLabel,
    };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.stack ?? `${this.name}: ${this.message}`;
  }
}

/**
 * Resolve a workingDirectory while permitting linked git worktrees for the same
 * repository, returning a typed result (#3858).
 *
 * Same-root and linked-worktree (shared git common directory) directories
 * resolve to `ok` with the provided root. A directory inside a *different* git
 * repository resolves to `foreign_repository` — callers must reject it
 * visibly. Non-repo paths outside the trusted root are rejected by throwing,
 * matching validateWorkingDirectory. Generic git-probe failures (anything other
 * than confirmed executable-not-found ENOENT or `rev-parse` 128 not-a-repo)
 * fail closed — including omitted/empty workingDirectory — and never fall
 * through to trusted-root/subdir/non-repo gitless behavior.
 */
export function resolveWorkingDirectoryOrLinkedWorktree(workingDirectory?: string): WorkingDirectoryResolution {
  const callerLabel = workingDirectory && workingDirectory.length > 0 ? workingDirectory : 'session cwd';
  const trustedProbe = probeGitTopLevel(process.cwd());
  if (trustedProbe.status === 'probe_failed') {
    throw new Error(formatGitProbeFailedMessage(callerLabel));
  }
  let trustedRoot: string;
  if (trustedProbe.status === 'ok') {
    trustedRoot = trustedProbe.root;
  } else if (trustedProbe.status === 'not_a_repository') {
    let cwdReal = process.cwd();
    try {
      cwdReal = realpathSync(cwdReal);
    } catch {
      cwdReal = process.cwd();
    }
    if (existsSync(join(cwdReal, '.git'))) {
      throw new Error(formatGitProbeFailedMessage(callerLabel));
    }
    trustedRoot = process.cwd();
  } else {
    trustedRoot = process.cwd();
  }

  if (!workingDirectory) {
    return { status: 'ok', root: trustedRoot };
  }

  const resolved = resolve(workingDirectory);

  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot;
  }

  const providedProbe = probeGitTopLevel(resolved);

  if (providedProbe.status === 'ok') {
    const providedRoot = providedProbe.root;
    let providedRootReal: string;
    try {
      providedRootReal = realpathSync(providedRoot);
    } catch {
      throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }

    if (providedRootReal === trustedRootReal) {
      return { status: 'ok', root: providedRoot };
    }

    const trustedCommonDir = getGitCommonDir(trustedRoot);
    const providedCommonDir = getGitCommonDir(providedRoot);
    if (trustedCommonDir && providedCommonDir && providedCommonDir === trustedCommonDir) {
      return { status: 'ok', root: providedRoot };
    }

    // Different repository (#3858): reject visibly instead of silently
    // substituting the trusted root.
    return foreignRepositoryResolution(providedRootReal, trustedRootReal, workingDirectory);
  }
  if (providedProbe.status === 'probe_failed') {
    throw new Error(formatGitProbeFailedMessage(workingDirectory));
  }

  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch {
    throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
  }

  if (providedProbe.status === 'not_a_repository' && existsSync(join(resolvedReal, '.git'))) {
    throw new Error(formatGitProbeFailedMessage(workingDirectory));
  }

  const gitMetadataDir = findGitMetadataDir(resolvedReal);
  if (gitMetadataDir) {
    let gitMetadataReal = gitMetadataDir;
    try {
      gitMetadataReal = realpathSync(gitMetadataDir);
    } catch {
      gitMetadataReal = gitMetadataDir;
    }
    if (gitMetadataReal !== trustedRootReal) {
      throw new Error(formatGitProbeFailedMessage(workingDirectory));
    }
  }

  const rel = relative(trustedRootReal, resolvedReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(formatOutsideTrustedRootMessage(workingDirectory, trustedRoot));
  }

  return { status: 'ok', root: trustedRoot };
}

/**
 * Validate a workingDirectory while permitting linked git worktrees for the
 * same repository.
 *
 * This preserves validateWorkingDirectory's default cwd behavior and its
 * same-root/subdirectory normalization, but allows a per-call directory to
 * resolve to a sibling manual `git worktree` when both worktrees share the
 * same git common directory. A directory inside a different git repository is
 * rejected with ForeignWorkingDirectoryError instead of silently falling back
 * to the trusted startup cwd (#3858); non-repo paths outside the trusted root
 * are rejected by throwing.
 */
export function validateWorkingDirectoryOrLinkedWorktree(workingDirectory?: string): string {
  const resolution = resolveWorkingDirectoryOrLinkedWorktree(workingDirectory);
  if (resolution.status === 'foreign_repository') {
    const roots = getCanonicalWorkingDirectoryRoots(resolution);
    throw new ForeignWorkingDirectoryError(
      roots.providedRoot,
      roots.trustedRoot,
      resolution.callerLabel,
    );
  }
  return resolution.root;
}
