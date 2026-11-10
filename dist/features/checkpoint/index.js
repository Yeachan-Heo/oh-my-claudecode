/**
 * Workspace checkpoints: snapshot-and-rollback for autonomous runs.
 *
 * A checkpoint is a git "shadow commit": the full working tree (tracked,
 * modified, and untracked-but-not-ignored files) is captured via a
 * temporary index and stored under `refs/omc/checkpoints/<sha>` without
 * touching HEAD, the real index, or the worktree. Rolling back restores
 * the worktree + index from that tree.
 *
 * Design constraints:
 * - Git-only by design: OMC already requires git for its core workflows,
 *   and shadow commits are the only snapshot mechanism that is cheap
 *   (no file copying), complete (includes untracked files), and safe
 *   (nothing outside refs/omc/ changes at snapshot time).
 * - Rollback removes files created after the snapshot (git clean -fd,
 *   which keeps ignored paths like node_modules) and requires --force
 *   when the working tree is dirty, because it discards uncommitted work.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const GIT_TIMEOUT_MS = 60_000;
const REF_PREFIX = "refs/omc/checkpoints/";
/** Author/committer identity for shadow commits (never uses user git config). */
const SHADOW_IDENTITY = [
    "-c", "user.name=omc checkpoint",
    "-c", "user.email=checkpoint@omc.invalid",
];
export class CheckpointError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
        this.name = "CheckpointError";
    }
}
function git(args, options = {}) {
    try {
        return execFileSync("git", args, {
            cwd: options.cwd ?? process.cwd(),
            env: options.env ?? process.env,
            timeout: GIT_TIMEOUT_MS,
            encoding: "utf8",
            windowsHide: true,
        }).trim();
    }
    catch (error) {
        const err = error;
        const detail = (err.stderr ?? err.message ?? "").trim();
        throw new CheckpointError(`git ${args[0]} failed: ${detail}`, 1);
    }
}
/** Resolve the enclosing repository toplevel, failing closed outside git. */
function repoToplevel(cwd) {
    const toplevel = git(["rev-parse", "--show-toplevel"], { cwd });
    if (!toplevel) {
        throw new CheckpointError("not inside a git repository");
    }
    return toplevel;
}
/**
 * Snapshot the whole working tree (including untracked non-ignored files)
 * as a shadow commit and store it under refs/omc/checkpoints/.
 *
 * Returns the 12-char checkpoint id (abbreviated commit sha).
 */
export function createCheckpoint(cwd, label) {
    if (typeof label !== "string" || label.trim().length === 0) {
        throw new CheckpointError("checkpoint label must not be empty");
    }
    const toplevel = repoToplevel(cwd);
    // Build a tree from the live worktree using a temporary index so the
    // user's real index and HEAD are never touched.
    const tmpIndexDir = mkdtempSync(join(tmpdir(), "omc-checkpoint-"));
    try {
        const tmpIndexPath = join(tmpIndexDir, "index");
        git(["add", "-A", "--"], {
            cwd: toplevel,
            env: { ...process.env, GIT_INDEX_FILE: tmpIndexPath },
        });
        const tree = git(["write-tree"], { cwd: toplevel, env: { ...process.env, GIT_INDEX_FILE: tmpIndexPath } });
        // Parent onto HEAD when the repository has commits; orphan trees are
        // valid snapshots for freshly-initialized repositories.
        let hasHead = true;
        try {
            git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: toplevel });
        }
        catch {
            hasHead = false;
        }
        const parentArgs = hasHead ? ["-p", "HEAD"] : [];
        const commit = git([...SHADOW_IDENTITY, "commit-tree", tree, ...parentArgs, "-m", `omc checkpoint: ${label}`], { cwd: toplevel });
        git(["update-ref", `${REF_PREFIX}${commit}`, commit], { cwd: toplevel });
        return commit.slice(0, 12);
    }
    finally {
        rmSync(tmpIndexDir, { recursive: true, force: true });
    }
}
/** List checkpoints (oldest first) for the enclosing repository. */
export function listCheckpoints(cwd) {
    repoToplevel(cwd);
    const raw = git([
        "for-each-ref",
        `--format=%(refname:short)%09%(creatordate:iso-strict)%09%(subject)`,
        "--sort=creatordate",
        REF_PREFIX,
    ], { cwd });
    if (!raw)
        return [];
    return raw.split("\n").map((line) => {
        const [ref, createdAt, subject = ""] = line.split("\t");
        return {
            id: ref.replace(/^omc\/checkpoints\//, "").slice(0, 12),
            createdAt,
            label: subject.replace(/^omc checkpoint: /, ""),
        };
    });
}
/**
 * True when the working tree differs from HEAD (tracked modifications or
 * untracked non-ignored files). Used to gate rollback behind --force.
 */
export function isWorktreeDirty(cwd) {
    const toplevel = repoToplevel(cwd);
    const status = git(["status", "--porcelain"], { cwd: toplevel });
    return status.length > 0;
}
/**
 * Restore the worktree and index from a checkpoint.
 *
 * Files created after the snapshot are removed (git clean -fd keeps
 * ignored paths such as node_modules). Refuses when the worktree is dirty
 * unless force is set, because rollback discards uncommitted work.
 */
export function rollbackToCheckpoint(cwd, checkpointId, force = false) {
    const toplevel = repoToplevel(cwd);
    if (!/^[0-9a-f]{4,40}$/.test(checkpointId)) {
        throw new CheckpointError(`invalid checkpoint id "${checkpointId}"`);
    }
    // Resolve against the checkpoints namespace by sha prefix. Ref names do
    // not support prefix lookup (unlike object shas), so match candidates via
    // for-each-ref; ambiguity is an error rather than a guess.
    const candidates = git(["for-each-ref", "--format=%(objectname)", REF_PREFIX], { cwd: toplevel })
        .split("\n")
        .filter((sha) => sha.startsWith(checkpointId));
    if (candidates.length === 0) {
        throw new CheckpointError(`unknown checkpoint "${checkpointId}" (see: omc checkpoint list)`);
    }
    if (candidates.length > 1) {
        throw new CheckpointError(`ambiguous checkpoint id "${checkpointId}"; use more characters`);
    }
    const full = candidates[0];
    // The resolved sha must be a commit (a shadow checkpoint), never a blob or
    // tree an attacker planted at a colliding ref path. Fail closed otherwise.
    const objectType = git(["cat-file", "-t", full], { cwd: toplevel });
    if (objectType !== "commit") {
        throw new CheckpointError(`checkpoint "${checkpointId}" is not a valid snapshot`);
    }
    if (!force && isWorktreeDirty(toplevel)) {
        throw new CheckpointError("working tree has uncommitted changes; rollback would discard them. Re-run with --force to proceed.", 2);
    }
    git(["restore", "--source", full, "--staged", "--worktree", ":/"], { cwd: toplevel });
    git(["clean", "-fd"], { cwd: toplevel });
}
//# sourceMappingURL=index.js.map