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
export declare const WORKSPACE_MARKER = ".omc-workspace";
/** Standard .omc subdirectories */
export declare const OmcPaths: {
    readonly ROOT: ".omc";
    readonly STATE: ".omc/state";
    readonly SESSIONS: ".omc/state/sessions";
    readonly PLANS: ".omc/plans";
    readonly RESEARCH: ".omc/research";
    readonly NOTEPAD: ".omc/notepad.md";
    readonly PROJECT_MEMORY: ".omc/project-memory.json";
    readonly DRAFTS: ".omc/drafts";
    readonly NOTEPADS: ".omc/notepads";
    readonly LOGS: ".omc/logs";
    readonly SCIENTIST: ".omc/scientist";
    readonly AUTOPILOT: ".omc/autopilot";
    readonly SKILLS: ".omc/skills";
    readonly SHARED_MEMORY: ".omc/state/shared-memory";
    readonly DEEPINIT_MANIFEST: ".omc/deepinit-manifest.json";
};
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
export declare function findWorkspaceRoot(startDir?: string): string | null;
/**
 * Read optional workspace marker config (id override). Returns {} when the
 * marker is empty or unparseable — callers should not throw on config errors.
 */
export declare function readWorkspaceMarkerConfig(workspaceRoot: string): WorkspaceMarkerConfig;
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
export declare function getGitTopLevel(cwd?: string): string | null;
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
export declare function getWorktreeRoot(cwd?: string): string | null;
/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export declare function validatePath(inputPath: string): void;
/**
 * Scan sibling subdirs of a workspace anchor for pre-existing .omc/state/ content.
 * Deduplicated per session via a disk marker so repeated hook firings within the
 * same session don't re-stat siblings or re-emit. A fresh session (new sessionId)
 * will re-warn — intentional, since the user may not have seen the prior warning.
 *
 * Call this once per session (e.g. from session-start.mjs) rather than on every
 * getOmcRoot() invocation to keep the hot path free of readdirSync calls.
 */
export declare function warnSiblingRetrofit(workspaceAnchor: string, sessionId?: string): void;
/**
 * Clear the sibling retrofit warning cache (useful for testing).
 * Also removes any disk markers under the given omcStateDir when provided.
 * @internal
 */
export declare function clearSiblingRetrofitWarnings(omcStateDir?: string): void;
/**
 * Clear the dual-directory warning cache (useful for testing).
 * @internal
 */
export declare function clearDualDirWarnings(): void;
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
export declare function getProjectIdentifier(worktreeRoot?: string): string;
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
export declare function getOmcRoot(worktreeRoot?: string): string;
/**
 * Resolve a relative path under .omc/ to an absolute path.
 * Validates the path is within the omc boundary.
 *
 * @param relativePath - Path relative to .omc/ (e.g., "state/ralph.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape omc boundary
 */
export declare function resolveOmcPath(relativePath: string, worktreeRoot?: string): string;
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
export declare function resolveStatePath(stateName: string, worktreeRoot?: string): string;
/**
 * Ensure a directory exists under .omc/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omc/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export declare function ensureOmcDir(relativePath: string, worktreeRoot?: string): string;
/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export declare function getWorktreeNotepadPath(worktreeRoot?: string): string;
/**
 * Get the absolute path to the project memory file.
 */
export declare function getWorktreeProjectMemoryPath(worktreeRoot?: string): string;
/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export declare function resolvePlanPath(planName: string, worktreeRoot?: string): string;
/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export declare function resolveResearchPath(name: string, worktreeRoot?: string): string;
/**
 * Resolve the logs directory path.
 */
export declare function resolveLogsPath(worktreeRoot?: string): string;
/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export declare function resolveWisdomPath(planName: string, worktreeRoot?: string): string;
/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export declare function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean;
/**
 * Ensure all standard .omc subdirectories exist.
 */
export declare function ensureAllOmcDirs(worktreeRoot?: string): void;
/**
 * Clear the worktree cache (useful for testing).
 */
export declare function clearWorktreeCache(): void;
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
export declare function getProcessSessionId(): string;
/**
 * Reset the process session ID (for testing only).
 * @internal
 */
export declare function resetProcessSessionId(): void;
/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export declare function validateSessionId(sessionId: string): void;
/**
 * Validate a transcript path to prevent arbitrary file reads.
 * Transcript files should only be read from known Claude directories.
 *
 * @param transcriptPath - The transcript path to validate
 * @returns true if path is valid, false otherwise
 */
export declare function isValidTranscriptPath(transcriptPath: string): boolean;
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
export declare function resolveSessionStatePath(stateName: string, sessionId: string, worktreeRoot?: string): string;
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
export type ReadPath = string & {
    readonly __brand: 'ReadPath';
};
export type WritePath = string & {
    readonly __brand: 'WritePath';
};
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
export declare function resolveSessionStatePaths(stateName: string, sessionId?: string, worktreeRoot?: string, _opts?: ResolveSessionStatePathsOptions): SessionStatePaths;
/**
 * Whether opt-in legacy→session migration is enabled for this process.
 * Checked by writers that wrap migration around their write step.
 */
export declare function isLegacyStateMigrationEnabled(): boolean;
/**
 * Get the session state directory path.
 * Path: {omcRoot}/state/sessions/{sessionId}/
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session state directory
 */
export declare function getSessionStateDir(sessionId: string, worktreeRoot?: string): string;
/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export declare function listSessionIds(worktreeRoot?: string): string[];
/**
 * Ensure the session state directory exists.
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the session state directory
 */
export declare function ensureSessionStateDir(sessionId: string, worktreeRoot?: string): string;
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
export declare function resolveToWorktreeRoot(directory?: string): string;
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
export declare function resolveTranscriptPath(transcriptPath: string | undefined, cwd?: string): string | undefined;
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
export declare function validateWorkingDirectory(workingDirectory?: string): string;
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
export declare function validateWorkingDirectoryOrLinkedWorktree(workingDirectory?: string): string;
export {};
//# sourceMappingURL=worktree-paths.d.ts.map