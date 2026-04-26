// src/team/worker-commit-cadence.ts
//
// PostToolUse hook installer + fs-watch fallback poller for worker auto-commit cadence.
//
// Two commit-cadence mechanisms:
//   hook   — writes {worktreePath}/.claude/settings.json with a PostToolUse hook that
//             auto-commits after every Write/Edit/MultiEdit tool use (Claude Code only).
//   fallback-poll — uses node:fs.watch with a 3 s debounce to detect filesystem changes
//             and auto-commit (for codex/gemini workers that lack PostToolUse support).
//
// Both mechanisms respect a sentinel file (.hook-paused in the worktree root) that
// suppresses commits during rebase conflict resolution.
import { existsSync, watch as fsWatch } from 'fs';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { exec } from 'child_process';
// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------
/** Sentinel file placed in worktree root to pause auto-commits during rebase. */
const SENTINEL_FILENAME = '.hook-paused';
/** PostToolUse hook matcher pattern. */
const HOOK_MATCHER = 'Write|Edit|MultiEdit';
/** Default debounce interval for the fallback poller (ms). */
const DEFAULT_POLL_DEBOUNCE_MS = 3000;
/**
 * Allowed worker-name pattern. The name is interpolated into a single-quoted
 * `sh -c '...'` body in the PostToolUse hook command, so a single-quote in the
 * name would break out of the quoted body and enable arbitrary command
 * injection. Constrain to alphanumerics, underscore, and dash, length 1..50.
 */
const WORKER_NAME_RE = /^[A-Za-z0-9_-]{1,50}$/;
function assertSafeWorkerName(workerName) {
    if (!WORKER_NAME_RE.test(workerName)) {
        throw new Error(`Invalid worker name for shell hook: "${workerName}" — must match ${WORKER_NAME_RE}`);
    }
}
// ---------------------------------------------------------------------------
// Hook command builder
// ---------------------------------------------------------------------------
/**
 * Builds the POSIX shell command embedded in the PostToolUse hook.
 * The command:
 *   1. Exits early if a rebase/merge is in progress or the sentinel is present.
 *   2. Stages all changes.
 *   3. Commits only when there is a non-empty diff (skips empty diffs).
 *
 * `workerName` is interpolated into a single-quoted shell body, so it must
 * pass `WORKER_NAME_RE` to prevent shell injection.
 */
function buildHookCommand(workerName) {
    assertSafeWorkerName(workerName);
    // Single-line POSIX sh command (no newlines — settings.json is a flat string).
    // The sentinel test must be `[ -e ${SENTINEL_FILENAME} ]` (one dot). A leading
    // `.` here would produce `..hook-paused` and never match the actual sentinel.
    return (`sh -c 'rebase_dir=$(git rev-parse --git-path rebase-merge 2>/dev/null || printf %s .git/rebase-merge); ` +
        `merge_head=$(git rev-parse --git-path MERGE_HEAD 2>/dev/null || printf %s .git/MERGE_HEAD); ` +
        `if [ -d "$rebase_dir" ] || [ -f "$merge_head" ] || [ -e ${SENTINEL_FILENAME} ]; then exit 0; fi; ` +
        `git add -A && (git diff --cached --quiet || git commit -m "auto-commit by worker ${workerName} at $(date -Iseconds)")'`);
}
/**
 * Reads existing settings.json (if any) and merges the PostToolUse hook into it.
 * Returns the merged settings object.
 */
async function mergeSettingsWithHook(settingsPath, hookCommand) {
    let existing = { hooks: { PostToolUse: [] } };
    try {
        const raw = await readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        existing = {
            ...parsed,
            hooks: {
                PostToolUse: [],
                ...(parsed.hooks ?? {}),
            },
        };
    }
    catch {
        // File absent or unparseable — start fresh.
    }
    // Remove any existing auto-commit entries for this matcher to avoid duplicates.
    const filteredHooks = (existing.hooks.PostToolUse ?? []).filter((h) => h.matcher !== HOOK_MATCHER);
    const newEntry = {
        matcher: HOOK_MATCHER,
        hooks: [{ type: 'command', command: hookCommand }],
    };
    return {
        ...existing,
        hooks: {
            ...existing.hooks,
            PostToolUse: [...filteredHooks, newEntry],
        },
    };
}
// ---------------------------------------------------------------------------
// installPostToolUseHook
// ---------------------------------------------------------------------------
/**
 * Writes `{worktreePath}/.claude/settings.json` containing a PostToolUse hook
 * that auto-commits after every Write/Edit/MultiEdit.
 *
 * Skips installation if the .hook-paused sentinel is present.
 */
export async function installPostToolUseHook(worktreePath, workerName) {
    // Validate up-front so callers cannot pass an injectable name that would
    // later land in the shell hook body. Throws synchronously on bad input.
    assertSafeWorkerName(workerName);
    if (isHookPaused(worktreePath)) {
        return;
    }
    const claudeDir = join(worktreePath, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    const hookCommand = buildHookCommand(workerName);
    const merged = await mergeSettingsWithHook(settingsPath, hookCommand);
    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
// ---------------------------------------------------------------------------
// pauseHookViaSentinel / resumeHookViaSentinel / isHookPaused
// ---------------------------------------------------------------------------
/**
 * Touches `{worktreePath}/.hook-paused` to suppress auto-commits.
 * Idempotent — no error if already paused.
 */
export async function pauseHookViaSentinel(worktreePath) {
    const sentinelPath = join(worktreePath, SENTINEL_FILENAME);
    // Ensure parent dir exists (should always be the worktree root, but be safe).
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, '', 'utf-8');
}
/**
 * Removes `{worktreePath}/.hook-paused` to re-enable auto-commits.
 * Idempotent — no error if already absent.
 */
export async function resumeHookViaSentinel(worktreePath) {
    const sentinelPath = join(worktreePath, SENTINEL_FILENAME);
    try {
        await unlink(sentinelPath);
    }
    catch {
        // Already absent — idempotent.
    }
}
/**
 * Returns true when the .hook-paused sentinel is present (auto-commits suppressed).
 * Synchronous for use inside shell-hook preamble checks and tight loops.
 */
export function isHookPaused(worktreePath) {
    return existsSync(join(worktreePath, SENTINEL_FILENAME));
}
/**
 * Starts a filesystem watcher on `worktreePath` with a debounce.
 * On each debounce-fire, runs the same auto-commit command respecting the
 * .hook-paused sentinel. Returns a stop handle.
 *
 * Intended for codex/gemini workers that lack PostToolUse hook support.
 */
export function startFallbackPoller(worktreePath, workerName, opts) {
    // Validate up-front so a malicious name cannot reach `buildHookCommand` from
    // a debounce-timer callback (where the throw would be lost to the runtime).
    assertSafeWorkerName(workerName);
    const debounceMs = opts?.intervalMs ?? DEFAULT_POLL_DEBOUNCE_MS;
    let debounceTimer = null;
    let stopped = false;
    const runAutoCommit = () => {
        if (stopped)
            return;
        if (isHookPaused(worktreePath))
            return;
        const cmd = buildHookCommand(workerName);
        exec(cmd, { cwd: worktreePath }, (_err) => {
            // Errors are intentionally swallowed here — empty-diff case exits non-zero
            // from the sh -c preamble, and we do not want to crash the poller on
            // transient git errors. Persistent errors surface through normal git state.
        });
    };
    const scheduleDebounce = () => {
        if (stopped)
            return;
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            runAutoCommit();
        }, debounceMs);
    };
    // Watch the worktree root recursively (node:fs.watch with recursive flag).
    // On macOS/Linux this uses FSEvents/inotify.
    const watcher = fsWatch(worktreePath, { recursive: true }, (eventType, filename) => {
        if (stopped)
            return;
        // Ignore .git internal changes to avoid feedback loops.
        if (filename && (filename.startsWith('.git') || filename.startsWith('.git/')))
            return;
        scheduleDebounce();
    });
    return {
        stop() {
            stopped = true;
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            watcher.close();
        },
    };
}
// ---------------------------------------------------------------------------
// installCommitCadence / uninstallCommitCadence / pauseCommitCadence / resumeCommitCadence
// (higher-level façade used by merge-orchestrator / runtime-v2 integration)
// ---------------------------------------------------------------------------
/**
 * Installs the appropriate commit cadence for the worker agent type.
 * - claude  → PostToolUse hook in .claude/settings.json
 * - codex / gemini → fallback fs-watch poller (caller owns the handle)
 *
 * Returns the chosen method. The fallback-poll handle is NOT started here;
 * callers that need the poller should call startFallbackPoller directly.
 */
export async function installCommitCadence(ctx) {
    if (!ctx.enabled) {
        return { method: 'none' };
    }
    if (ctx.agentType === 'claude') {
        await installPostToolUseHook(ctx.worktreePath, ctx.workerName);
        return { method: 'hook' };
    }
    // codex / gemini: no PostToolUse hook; caller starts the fallback poller.
    return { method: 'fallback-poll' };
}
/**
 * Removes the auto-commit PostToolUse hook from .claude/settings.json.
 * For fallback-poll workers the caller is responsible for stopping the poller handle.
 */
export async function uninstallCommitCadence(ctx) {
    if (ctx.agentType !== 'claude')
        return;
    const settingsPath = join(ctx.worktreePath, '.claude', 'settings.json');
    try {
        const raw = await readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const filtered = (parsed.hooks?.PostToolUse ?? []).filter((h) => h.matcher !== HOOK_MATCHER);
        const updated = {
            ...parsed,
            hooks: {
                ...parsed.hooks,
                PostToolUse: filtered,
            },
        };
        await writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    }
    catch {
        // File absent — nothing to uninstall.
    }
}
/**
 * Pauses commit cadence by touching the sentinel file.
 * Used by the orchestrator before fanning out a rebase.
 */
export async function pauseCommitCadence(ctx) {
    await pauseHookViaSentinel(ctx.worktreePath);
}
/**
 * Resumes commit cadence by removing the sentinel file.
 * Used by the orchestrator after rebase conflict resolution.
 */
export async function resumeCommitCadence(ctx) {
    await resumeHookViaSentinel(ctx.worktreePath);
}
//# sourceMappingURL=worker-commit-cadence.js.map