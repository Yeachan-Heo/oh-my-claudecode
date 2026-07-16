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
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { resolve, normalize, relative, sep, join, isAbsolute, basename, dirname } from 'path';
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
};
/**
 * LRU cache for worktree root lookups to avoid repeated git subprocess calls.
 * Bounded to MAX_WORKTREE_CACHE_SIZE entries to prevent memory growth when
 * alternating between many different cwds (cache thrashing).
 */
const MAX_WORKTREE_CACHE_SIZE = 8;
const worktreeCacheMap = new Map();
/** LRU cache for literal git-toplevel lookups (getGitTopLevel, no submodule climb). */
const toplevelCacheMap = new Map();
/** LRU cache for outermost superproject root lookups, including negative results. */
const superprojectCacheMap = new Map();
/**
 * LRU cache for workspace marker lookups.
 */
const workspaceCacheMap = new Map();
/**
 * Walk up from the given directory looking for a WORKSPACE_MARKER file.
 * Returns the directory containing the marker, or null if none found before
 * reaching the filesystem root or the user's home directory.
 *
 * Walking stops at the home directory to prevent accidentally treating a
 * stray marker in $HOME or above as a workspace anchor.
 */
export function findWorkspaceRoot(startDir) {
    if (process.env.OMC_DISABLE_MULTIREPO === '1')
        return null;
    const effectiveStart = startDir || process.cwd();
    let current;
    try {
        current = resolve(effectiveStart);
    }
    catch {
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
            return resolve(homedir());
        }
        catch {
            return null;
        }
    })();
    let cursor = current;
    let result = null;
    while (true) {
        // Stop before scanning $HOME (or above) so a stray ~/.omc-workspace does
        // not collapse unrelated repos under home into one shared state root.
        if (home && cursor === home)
            break;
        if (existsSync(join(cursor, WORKSPACE_MARKER))) {
            result = cursor;
            break;
        }
        const parent = dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    if (workspaceCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
        const oldest = workspaceCacheMap.keys().next().value;
        if (oldest !== undefined)
            workspaceCacheMap.delete(oldest);
    }
    workspaceCacheMap.set(current, result);
    return result;
}
/**
 * Read optional workspace marker config (id override). Returns {} when the
 * marker is empty or unparseable — callers should not throw on config errors.
 */
export function readWorkspaceMarkerConfig(workspaceRoot) {
    try {
        const raw = readFileSync(join(workspaceRoot, WORKSPACE_MARKER), 'utf-8').trim();
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
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
function isDefinitiveNonGitError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const { status, stderr } = error;
    if (status !== 128)
        return false;
    const output = typeof stderr === 'string'
        ? stderr
        : Buffer.isBuffer(stderr)
            ? stderr.toString()
            : '';
    return /not a git repository/i.test(output);
}
function resolveSuperprojectRoot(cwd) {
    const cacheKey = resolve(cwd);
    if (superprojectCacheMap.has(cacheKey)) {
        const cached = superprojectCacheMap.get(cacheKey) ?? null;
        superprojectCacheMap.delete(cacheKey);
        superprojectCacheMap.set(cacheKey, cached);
        return cached;
    }
    let anchor = null;
    let probeCwd = cacheKey;
    let completed = false;
    // Bounded by submodule nesting depth; guard against pathological loops.
    for (let depth = 0; depth < 32; depth++) {
        let superRoot;
        try {
            superRoot = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
                cwd: probeCwd,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                timeout: 5000,
            }).trim();
        }
        catch (error) {
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
            if (oldest !== undefined)
                superprojectCacheMap.delete(oldest);
        }
        superprojectCacheMap.set(cacheKey, anchor);
    }
    return anchor;
}
/**
 * Resolve the state-anchor root for an optional worktreeRoot argument.
 *
 * Many callers pass a raw cwd as `worktreeRoot` (e.g. hooks forwarding
 * `process.cwd()`). When that cwd is inside a git submodule we climb to the
 * outermost superproject so `.omc/` anchors to the monorepo root rather than
 * the submodule (#3349).
 *
 * Crucially, when the provided dir is NOT inside a submodule the path is used
 * VERBATIM (the historical contract) — it is NOT resolved up to its git
 * toplevel. Callers that pass an explicit directory (including tests that
 * isolate state under a per-process subdir of the repo) rely on it being the
 * literal `.omc` base; resolving such a subdir up to the repo root would
 * collapse separately-scoped state dirs into one and corrupt them.
 */
function resolveStateAnchorRoot(worktreeRoot) {
    if (worktreeRoot)
        return resolveSuperprojectRoot(worktreeRoot) || worktreeRoot;
    return getWorktreeRoot() || process.cwd();
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
export function getGitTopLevel(cwd) {
    const effectiveCwd = cwd || process.cwd();
    // Return cached value if present (LRU: move to end on access)
    if (toplevelCacheMap.has(effectiveCwd)) {
        const root = toplevelCacheMap.get(effectiveCwd);
        toplevelCacheMap.delete(effectiveCwd);
        toplevelCacheMap.set(effectiveCwd, root);
        return root || null;
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: effectiveCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: 5000,
        }).trim();
        if (toplevelCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
            const oldest = toplevelCacheMap.keys().next().value;
            if (oldest !== undefined)
                toplevelCacheMap.delete(oldest);
        }
        toplevelCacheMap.set(effectiveCwd, root);
        return root;
    }
    catch {
        // Not in a git repository - do NOT cache so a later git init re-detects.
        return null;
    }
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
export function getWorktreeRoot(cwd) {
    const effectiveCwd = cwd || process.cwd();
    // Return cached value if present (LRU: move to end on access)
    if (worktreeCacheMap.has(effectiveCwd)) {
        const root = worktreeCacheMap.get(effectiveCwd);
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
export function validatePath(inputPath) {
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
const dualDirWarnings = new Set();
/** Track which workspace anchors have already had sibling-scan warnings emitted (once per process) */
const siblingRetrofitWarned = new Set();
/**
 * Scan sibling subdirs of a workspace anchor for pre-existing .omc/state/ content.
 * Deduplicated per session via a disk marker so repeated hook firings within the
 * same session don't re-stat siblings or re-emit. A fresh session (new sessionId)
 * will re-warn — intentional, since the user may not have seen the prior warning.
 *
 * Call this once per session (e.g. from session-start.mjs) rather than on every
 * getOmcRoot() invocation to keep the hot path free of readdirSync calls.
 */
export function warnSiblingRetrofit(workspaceAnchor, sessionId) {
    if (siblingRetrofitWarned.has(workspaceAnchor))
        return;
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
    let entries;
    try {
        entries = readdirSync(workspaceAnchor, { withFileTypes: true, encoding: 'utf-8' });
    }
    catch {
        return;
    }
    const legacyDirs = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const entryName = entry.name;
        const siblingStateDir = join(workspaceAnchor, entryName, OmcPaths.ROOT, 'state');
        if (existsSync(siblingStateDir)) {
            legacyDirs.push(join(workspaceAnchor, entryName, OmcPaths.ROOT));
        }
    }
    if (legacyDirs.length === 0)
        return;
    const dirList = legacyDirs.map(d => `  - ${d}`).join('\n');
    process.stderr.write(`[omc] workspace-retrofit warning: .omc-workspace anchor found at ${workspaceAnchor}\n` +
        `  but sibling repos have pre-existing local .omc/state/ content:\n${dirList}\n` +
        `  Shared state will go to: ${sharedOmc}\n` +
        `  To migrate legacy state: OMC_MIGRATE_LEGACY_STATE=1 omc setup\n` +
        `  Or manually copy state files to ${sharedOmc}/state/\n`);
    // Write disk marker so subsequent hook firings in the same session stay silent
    if (sessionId) {
        try {
            const stateDir = join(sharedOmc, 'state');
            if (!existsSync(stateDir))
                mkdirSync(stateDir, { recursive: true });
            const markerPath = join(stateDir, `sibling-retrofit-warned-${sessionId}.json`);
            writeFileSync(markerPath, JSON.stringify({ warnedAt: new Date().toISOString(), anchor: workspaceAnchor }));
        }
        catch {
            // Non-fatal — dedupe falls back to in-memory Set for this process
        }
    }
}
/**
 * Clear the sibling retrofit warning cache (useful for testing).
 * Also removes any disk markers under the given omcStateDir when provided.
 * @internal
 */
export function clearSiblingRetrofitWarnings(omcStateDir) {
    siblingRetrofitWarned.clear();
    if (omcStateDir) {
        try {
            const stateDir = join(omcStateDir, 'state');
            if (!existsSync(stateDir))
                return;
            const entries = readdirSync(stateDir, { withFileTypes: true, encoding: 'utf-8' });
            for (const entry of entries) {
                const name = entry.name;
                if (name.startsWith('sibling-retrofit-warned-') && name.endsWith('.json')) {
                    try {
                        unlinkSync(join(stateDir, name));
                    }
                    catch { /* non-fatal */ }
                }
            }
        }
        catch {
            // Non-fatal
        }
    }
}
/**
 * Clear the dual-directory warning cache (useful for testing).
 * @internal
 */
export function clearDualDirWarnings() {
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
export function getProjectIdentifier(worktreeRoot) {
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
    let source;
    try {
        const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
        source = remoteUrl || root;
    }
    catch {
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
    }
    catch {
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
export function getOmcRoot(worktreeRoot) {
    const customDir = process.env.OMC_STATE_DIR;
    if (customDir) {
        // Centralized state lives at $OMC_STATE_DIR/{projectId} — outside the
        // working tree — so the #3349 stray-`.omc`-in-submodule problem does not
        // apply here. Identity must NOT climb: use the literal git toplevel
        // (getGitTopLevel) for the no-arg fallback so a submodule launched without
        // an explicit worktreeRoot keeps its own centralized id rather than merging
        // into the parent project's (preserves submodule identity).
        const root = worktreeRoot || getGitTopLevel() || process.cwd();
        const projectId = getProjectIdentifier(root);
        const centralizedPath = join(customDir, projectId);
        // Log notice if both legacy .omc/ and new centralized dir exist
        const legacyPath = join(root, OmcPaths.ROOT);
        const warningKey = `${legacyPath}:${centralizedPath}`;
        if (!dualDirWarnings.has(warningKey) && existsSync(legacyPath) && existsSync(centralizedPath)) {
            dualDirWarnings.add(warningKey);
            console.warn(`[omc] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. ` +
                `Using centralized dir. Consider migrating data from the legacy dir and removing it.`);
        }
        return centralizedPath;
    }
    // Workspace marker overrides git root resolution. This enables multi-repo
    // workspaces where the parent dir is not itself a git repo: all sub-repos
    // share the same .omc/ at the marker location.
    const workspaceAnchor = findWorkspaceRoot(worktreeRoot);
    if (workspaceAnchor) {
        return join(workspaceAnchor, OmcPaths.ROOT);
    }
    const root = resolveStateAnchorRoot(worktreeRoot);
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
export function resolveOmcPath(relativePath, worktreeRoot) {
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
export function resolveStatePath(stateName, worktreeRoot) {
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
export function ensureOmcDir(relativePath, worktreeRoot) {
    const fullPath = resolveOmcPath(relativePath, worktreeRoot);
    if (!existsSync(fullPath)) {
        try {
            mkdirSync(fullPath, { recursive: true });
        }
        catch (err) {
            // On Windows, concurrent hooks can race past the existsSync check and
            // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
            if (err.code !== "EEXIST")
                throw err;
        }
    }
    return fullPath;
}
/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export function getWorktreeNotepadPath(worktreeRoot) {
    return join(getOmcRoot(worktreeRoot), 'notepad.md');
}
/**
 * Get the absolute path to the project memory file.
 */
export function getWorktreeProjectMemoryPath(worktreeRoot) {
    return join(getOmcRoot(worktreeRoot), 'project-memory.json');
}
/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export function resolvePlanPath(planName, worktreeRoot) {
    validatePath(planName);
    return join(getOmcRoot(worktreeRoot), 'plans', `${planName}.md`);
}
/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export function resolveResearchPath(name, worktreeRoot) {
    validatePath(name);
    return join(getOmcRoot(worktreeRoot), 'research', name);
}
/**
 * Resolve the logs directory path.
 */
export function resolveLogsPath(worktreeRoot) {
    return join(getOmcRoot(worktreeRoot), 'logs');
}
/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export function resolveWisdomPath(planName, worktreeRoot) {
    validatePath(planName);
    return join(getOmcRoot(worktreeRoot), 'notepads', planName);
}
/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export function isPathUnderOmc(absolutePath, worktreeRoot) {
    const omcRoot = getOmcRoot(worktreeRoot);
    const normalizedPath = normalize(absolutePath);
    const normalizedOmc = normalize(omcRoot);
    return normalizedPath.startsWith(normalizedOmc + sep) || normalizedPath === normalizedOmc;
}
/**
 * Ensure all standard .omc subdirectories exist.
 */
export function ensureAllOmcDirs(worktreeRoot) {
    const omcRoot = getOmcRoot(worktreeRoot);
    const subdirs = ['', 'state', 'plans', 'research', 'logs', 'notepads', 'drafts'];
    for (const subdir of subdirs) {
        const fullPath = subdir ? join(omcRoot, subdir) : omcRoot;
        if (!existsSync(fullPath)) {
            try {
                mkdirSync(fullPath, { recursive: true });
            }
            catch (err) {
                // On Windows, concurrent hooks can race past the existsSync check and
                // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
                if (err.code !== "EEXIST")
                    throw err;
            }
        }
    }
}
/**
 * Clear the worktree cache (useful for testing).
 */
export function clearWorktreeCache() {
    worktreeCacheMap.clear();
    toplevelCacheMap.clear();
    superprojectCacheMap.clear();
    workspaceCacheMap.clear();
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
let processSessionId = null;
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
export function getProcessSessionId() {
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
export function resetProcessSessionId() {
    processSessionId = null;
}
/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export function validateSessionId(sessionId) {
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
export function isValidTranscriptPath(transcriptPath) {
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
export function resolveSessionStatePath(stateName, sessionId, worktreeRoot) {
    validateSessionId(sessionId);
    const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
    return resolveOmcPath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
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
export function resolveSessionStatePaths(stateName, sessionId, worktreeRoot, _opts) {
    const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
    const legacy = resolveStatePath(stateName, worktreeRoot);
    if (!sessionId) {
        return {
            sessionScoped: '',
            legacy,
            effectiveRead: legacy,
            effectiveWrite: legacy,
        };
    }
    validateSessionId(sessionId);
    const sessionScoped = resolveOmcPath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
    // effectiveRead probes session-scoped first; fall back to legacy when the
    // session-scoped file does not yet exist (first-read back-compat).
    const effectiveRead = (existsSync(sessionScoped) ? sessionScoped : legacy);
    return {
        sessionScoped,
        legacy,
        effectiveRead,
        effectiveWrite: sessionScoped,
    };
}
/**
 * Whether opt-in legacy→session migration is enabled for this process.
 * Checked by writers that wrap migration around their write step.
 */
export function isLegacyStateMigrationEnabled() {
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
export function getSessionStateDir(sessionId, worktreeRoot) {
    validateSessionId(sessionId);
    return join(getOmcRoot(worktreeRoot), 'state', 'sessions', sessionId);
}
/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export function listSessionIds(worktreeRoot) {
    const sessionsDir = join(getOmcRoot(worktreeRoot), 'state', 'sessions');
    if (!existsSync(sessionsDir)) {
        return [];
    }
    try {
        const entries = readdirSync(sessionsDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory() && SESSION_ID_REGEX.test(entry.name))
            .map(entry => entry.name);
    }
    catch {
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
export function ensureSessionStateDir(sessionId, worktreeRoot) {
    const sessionDir = getSessionStateDir(sessionId, worktreeRoot);
    if (!existsSync(sessionDir)) {
        try {
            mkdirSync(sessionDir, { recursive: true });
        }
        catch (err) {
            // On Windows, concurrent hooks can race past the existsSync check and
            // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
            if (err.code !== "EEXIST")
                throw err;
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
export function resolveToWorktreeRoot(directory) {
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
        if (root)
            return root;
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
export function resolveTranscriptPath(transcriptPath, cwd) {
    if (!transcriptPath)
        return undefined;
    // Fast path: if the file already exists, no resolution needed
    if (existsSync(transcriptPath))
        return transcriptPath;
    // Strategy 1: Detect worktree-encoded segment in the transcript path itself.
    // The pattern `--claude-worktrees-` appears when Claude Code encodes a CWD
    // containing `/.claude/worktrees/` (separator `/` → `-`, dot `.` → `-`).
    // Strip everything from this pattern to the next `/` to recover the original
    // project directory encoding.
    const worktreeSegmentPattern = /--claude-worktrees-[^/\\]+/;
    if (worktreeSegmentPattern.test(transcriptPath)) {
        const resolved = transcriptPath.replace(worktreeSegmentPattern, '');
        if (existsSync(resolved))
            return resolved;
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
                if (existsSync(resolvedPath))
                    return resolvedPath;
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
        try {
            mainRepoRoot = realpathSync(mainRepoRoot);
        }
        catch { /* keep as-is */ }
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
                    if (existsSync(resolvedPath))
                        return resolvedPath;
                }
            }
        }
    }
    catch {
        // Not in a git repo or git not available — skip
    }
    // No resolution found — return original path.
    // Callers should handle non-existent paths gracefully.
    return transcriptPath;
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
export function validateWorkingDirectory(workingDirectory) {
    const trustedRoot = getGitTopLevel(process.cwd()) || process.cwd();
    if (!workingDirectory) {
        return trustedRoot;
    }
    // Resolve to absolute
    const resolved = resolve(workingDirectory);
    let trustedRootReal;
    try {
        trustedRootReal = realpathSync(trustedRoot);
    }
    catch {
        trustedRootReal = trustedRoot;
    }
    // Try to resolve the provided directory to its literal git top-level.
    const providedRoot = getGitTopLevel(resolved);
    if (providedRoot) {
        // Git resolution succeeded — require exact worktree identity.
        let providedRootReal;
        try {
            providedRootReal = realpathSync(providedRoot);
        }
        catch {
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
    let resolvedReal;
    try {
        resolvedReal = realpathSync(resolved);
    }
    catch {
        throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }
    const rel = relative(trustedRootReal, resolvedReal);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`workingDirectory '${workingDirectory}' is outside the trusted worktree root '${trustedRoot}'.`);
    }
    // Directory is under trusted root but git failed — return trusted root,
    // never the subdirectory, to prevent .omc/ creation in subdirs (#576).
    return trustedRoot;
}
function getGitCommonDir(cwd) {
    try {
        const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: 5000,
        }).trim();
        return realpathSync(commonDir);
    }
    catch {
        return null;
    }
}
/**
 * Validate a workingDirectory while permitting linked git worktrees for the
 * same repository.
 *
 * This preserves validateWorkingDirectory's default cwd behavior and its
 * same-root/subdirectory normalization, but allows a per-call directory to
 * resolve to a sibling manual `git worktree` when both worktrees share the
 * same git common directory. Other unrelated git repositories still fall back
 * to the trusted startup cwd, and non-repo paths outside the trusted root are
 * rejected.
 */
export function validateWorkingDirectoryOrLinkedWorktree(workingDirectory) {
    const trustedRoot = getGitTopLevel(process.cwd()) || process.cwd();
    if (!workingDirectory) {
        return trustedRoot;
    }
    const resolved = resolve(workingDirectory);
    let trustedRootReal;
    try {
        trustedRootReal = realpathSync(trustedRoot);
    }
    catch {
        trustedRootReal = trustedRoot;
    }
    const providedRoot = getGitTopLevel(resolved);
    if (providedRoot) {
        let providedRootReal;
        try {
            providedRootReal = realpathSync(providedRoot);
        }
        catch {
            throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
        }
        if (providedRootReal === trustedRootReal) {
            return providedRoot;
        }
        const trustedCommonDir = getGitCommonDir(trustedRoot);
        const providedCommonDir = getGitCommonDir(providedRoot);
        if (trustedCommonDir && providedCommonDir && providedCommonDir === trustedCommonDir) {
            return providedRoot;
        }
        console.error('[worktree] workingDirectory resolved to different git worktree root, using trusted root', {
            workingDirectory: resolved,
            providedRoot: providedRootReal,
            trustedRoot: trustedRootReal,
        });
        return trustedRoot;
    }
    let resolvedReal;
    try {
        resolvedReal = realpathSync(resolved);
    }
    catch {
        throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }
    const rel = relative(trustedRootReal, resolvedReal);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`workingDirectory '${workingDirectory}' is outside the trusted worktree root '${trustedRoot}'.`);
    }
    return trustedRoot;
}
//# sourceMappingURL=worktree-paths.js.map