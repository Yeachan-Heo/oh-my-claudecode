/**
 * Worktree dirty-evidence collection for abnormal agent termination (issue #3663).
 *
 * When a background agent terminates abnormally (API error / stalled mid-stream
 * / failed task-notification), its isolated git worktree can be left holding
 * uncommitted work with no checkpoint and no warning to the coordinator. This
 * module records bounded, READ-ONLY evidence about that dirty state at
 * SubagentStop time so a coordinator can see the work exists BEFORE running
 * destructive cleanup (`git reset --hard`, worktree removal, campaign clean,
 * ...).
 *
 * Safety contract:
 *  - READ-ONLY: never stages, commits, stashes, resets, or removes anything.
 *  - BOUNDED: path lists are capped and file CONTENT is never read or emitted.
 *  - BUDGETED: total git wall-time is capped by a shared bounded deadline
 *    (EVIDENCE_DEADLINE_MS) well below the SubagentStop hook timeout so durable
 *    state writes can never be starved by evidence collection (issue #3663 B5).
 *  - FAIL-CLOSED: any git failure degrades to a structured non-dirty kind and
 *    never throws out of the hook boundary.
 *  - NO AUTO-COMMIT: checkpointing agent work is deliberately left to the
 *    coordinator. Authorship, secrets, hooks, ignored files, and partially
 *    written content are not safely boundable from this hook surface, so a
 *    silent WIP commit is never created here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
export const MAX_EVIDENCE_ENTRIES = 20;
export const GIT_TIMEOUT_MS = 2500;
export const MAX_EVIDENCE_PATH_LENGTH = 200;
/**
 * Shared bounded deadline for ALL evidence-collection git work (issue #3663
 * B5 + B8). The SubagentStop hook is declared at 5s in hooks/hooks.json; run.cjs
 * enforces a 500ms cushion and kills the child fail-open at that boundary, so
 * any durable state write after evidence collection would be lost. The
 * collector budget is deliberately smaller than the hook budget so that the
 * post-collection work — lock acquisition (500ms worst case), synchronous
 * durable state flush, replay/mission writes, hook output — has a reserved
 * worst-case budget before the 4.5s runner deadline (issue #3663 B8).
 */
export const EVIDENCE_DEADLINE_MS = 3000;
/**
 * Deliberate output bound for a single git call. Node's execFileSync default
 * maxBuffer is 1 MiB and raises ENOBUFS on large `--untracked-files=all`
 * output, silently losing ALL evidence (issue #3663 B7). We raise the child
 * buffer to this bound so a normal large dirty tree is fully counted, while
 * the incremental parser stops storing paths once MAX_EVIDENCE_ENTRIES is
 * reached (bounded memory) and keeps counting lines past the bound.
 */
export const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Structured failure envelopes Claude Code emits on abnormal termination. */
const STRUCTURED_FAILURE_ENVELOPES = [
    // Whole-line <status>failed</status> (task-notification envelope).
    /^\s*<status>failed<\/status>\s*$/im,
    // Start-of-line API-error phrases (API-error/stalled terminations).
    /^(?:Agent terminated early due to an API error|API Error: Response stalled mid-stream)\b/im,
];
/**
 * Whether a SubagentStop input represents an abnormal termination.
 *
 * The Claude Code SDK does not reliably set `success` on SubagentStop (it
 * defaults to "completed" when undefined), so abnormal termination is inferred
 * from the failure markers Claude Code emits in the stop output summary for
 * API-error terminations (issue #3663).
 *
 * Precedence (issue #3663 B6):
 *  1. EXPLICIT success wins. `success: true` is never abnormal, even when the
 *     final report merely mentions an API-error phrase.
 *  2. Explicit `success: false` is abnormal regardless of output.
 *  3. When `success` is omitted, marker inference fires ONLY on structured
 *     failure envelopes — a whole-line `<status>failed</status>` or a
 *     start-of-line API-error phrase — never on arbitrary prose that happens
 *     to contain a diagnostic word.
 *
 * User-initiated cancels / interrupts are NOT treated as abnormal.
 */
export function isAbnormalTermination(input) {
    if (input.success === true)
        return false;
    if (input.success === false)
        return true;
    if (typeof input.output !== "string" || input.output.trim() === "") {
        return false;
    }
    const output = input.output;
    return STRUCTURED_FAILURE_ENVELOPES.some((pattern) => pattern.test(output));
}
/** Classify a `git status --porcelain` row by its two-character status code. */
function statusCategory(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith("??"))
        return "untracked";
    if (trimmed.startsWith("!!"))
        return "ignored";
    return "tracked";
}
function runGitBounded(cwd, args, opts, remainingMs) {
    const git = opts.gitCommand || "git";
    const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? GIT_TIMEOUT_MS, remainingMs));
    try {
        return execFileSync(git, args, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: GIT_MAX_BUFFER,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
                GIT_OPTIONAL_LOCKS: "0",
            },
        }).trim();
    }
    catch (err) {
        const code = err.code;
        throw Object.assign(new Error(`git call failed: ${String(code ?? "git_failed")}`), {
            code: code === "ETIMEDOUT" ? "ETIMEDOUT" : code,
        });
    }
}
function runGitStatus(cwd, args, opts, remainingMs) {
    const git = opts.gitCommand || "git";
    const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? GIT_TIMEOUT_MS, remainingMs));
    // GIT_TERMINAL_PROMPT=0 prevents credential prompts from hanging the hook;
    // GIT_OPTIONAL_LOCKS=0 keeps `git status` from taking optional index locks
    // (read-only, no contention with a concurrent coordinator). The per-call
    // timeout is clamped to the remaining shared deadline so the SUM of all git
    // calls can never exceed the collector budget (issue #3663 B5/B8).
    let raw;
    try {
        raw = execFileSync(git, args, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: GIT_MAX_BUFFER,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
                GIT_OPTIONAL_LOCKS: "0",
            },
        });
    }
    catch (err) {
        const code = err.code;
        return {
            rows: [],
            outputTruncated: false,
            overflow: { tracked: 0, untracked: 0, ignored: 0 },
            error: code === "ETIMEDOUT" ? "deadline" : String(code ?? "git_failed"),
        };
    }
    // Incremental bounded parse: stop storing rows once the entry cap is full,
    // keep counting lines so totals stay exact even past the cap.
    const rows = [];
    let outputTruncated = false;
    const overflow = { tracked: 0, untracked: 0, ignored: 0 };
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (rows.length < MAX_EVIDENCE_ENTRIES) {
            rows.push(line);
        }
        else {
            outputTruncated = true;
            overflow[statusCategory(line)]++;
        }
    }
    return { rows, outputTruncated, overflow };
}
function isLinkedWorktree(toplevel) {
    try {
        // A linked worktree's toplevel has a `.git` FILE (gitdir: ...); the main
        // repo has a `.git` directory.
        return statSync(join(toplevel, ".git")).isFile();
    }
    catch {
        return false;
    }
}
function sanitizePathPart(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]/g, "?")
        .trim()
        .substring(0, MAX_EVIDENCE_PATH_LENGTH);
}
/** Extract the path from a `git status --porcelain` line (rename-aware). */
function statusEntryPath(line) {
    const payload = line.slice(3);
    const renameSeparator = " -> ";
    const renameIndex = payload.indexOf(renameSeparator);
    const raw = renameIndex >= 0
        ? payload.slice(renameIndex + renameSeparator.length)
        : payload;
    return sanitizePathPart(raw);
}
const empty = () => ({
    kind: "clean",
    isLinkedWorktree: false,
    trackedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
    entries: [],
    truncated: false,
});
/**
 * Collect bounded dirty-worktree evidence for a directory. READ-ONLY and
 * fail-closed: never throws, never mutates the repository. Total git wall-time
 * is capped by the shared EVIDENCE_DEADLINE_MS budget (issue #3663 B5/B8) so
 * durable state writes after collection can never be starved by the collector.
 */
export function collectWorktreeDirtyEvidence(cwd, opts = {}) {
    const startedAt = Date.now();
    const deadlineMs = opts.deadlineMs ?? EVIDENCE_DEADLINE_MS;
    const remaining = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
    try {
        if (!existsSync(cwd)) {
            return { ...empty(), kind: "cwd_missing", error: "cwd_missing" };
        }
        let toplevel;
        try {
            // rev-parse is a single tiny line; bypass the streaming parser and use a
            // direct bounded call so a fake-git seam (which answers the same status
            // for every subcommand) still resolves the toplevel correctly.
            toplevel = runGitBounded(cwd, ["rev-parse", "--show-toplevel"], opts, remaining());
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT") {
                return {
                    ...empty(),
                    kind: "git_unavailable",
                    error: `git_unavailable:${String(code)}`,
                };
            }
            // ETIMEDOUT means the shared bounded deadline (B5/B8) fired — git is
            // present but the budget was exhausted; never misreport that as a
            // non-repository directory.
            const isTimeout = code === "ETIMEDOUT";
            return {
                ...empty(),
                kind: isTimeout ? "git_unavailable" : "not_git",
                error: isTimeout ? "git_unavailable:deadline" : "not_git",
            };
        }
        if (!toplevel)
            return { ...empty(), kind: "not_git", error: "not_git" };
        const linked = isLinkedWorktree(toplevel);
        // Two bounded read-only calls: regular status (tracked+untracked) and
        // ignored status (informational — ignored files are not at-risk work).
        // Each call's timeout is clamped to the remaining shared deadline so the
        // sum of every git call stays under EVIDENCE_DEADLINE_MS (B5/B8), and each
        // call streams through a bounded incremental parser (B7) so huge
        // --untracked-files=all output can never raise ENOBUFS and lose counts.
        const status = runGitStatus(toplevel, ["status", "--porcelain", "--untracked-files=all"], opts, remaining());
        if (status.error) {
            // A bounded git failure degrades fail-open (never throws). A deadline
            // hit means the shared budget was exhausted; anything else that is not
            // an ENOBUFS overflow is a non-repository or failed-git signal.
            if (status.error === "deadline") {
                return {
                    ...empty(),
                    kind: "git_unavailable",
                    error: "git_unavailable:deadline",
                };
            }
            return {
                ...empty(),
                kind: status.error === "ENOBUFS" ? "git_unavailable" : "not_git",
                error: status.error === "ENOBUFS" ? "git_unavailable:output_overflow" : status.error,
            };
        }
        const ignoredStatus = runGitStatus(toplevel, ["status", "--porcelain", "--ignored=matching"], opts, remaining());
        if (ignoredStatus.error) {
            // The regular status already succeeded, so its dirty/clean verdict is
            // authoritative. Ignored info is purely informational: degrade the
            // ignored count to 0 and record the bounded secondary failure WITHOUT
            // overwriting the kind (issue #3663 P1). Reporting git_unavailable here
            // suppressed both the coordinator notice and the replay dirty_worktree
            // record for a worktree that was proven dirty.
            const base = statusToEvidence(toplevel, linked, status);
            return {
                ...base,
                error: `ignored_scan_failed:${ignoredStatus.error}`,
            };
        }
        return statusToEvidence(toplevel, linked, status, ignoredStatus);
    }
    catch {
        // Fail-closed: any unexpected git/filesystem failure must not break the
        // stop hook and must not claim the worktree is dirty.
        return { ...empty(), kind: "git_unavailable", error: "evidence_failed" };
    }
}
function statusToEvidence(toplevel, linked, status, ignoredStatus) {
    const tracked = [];
    const untracked = [];
    const ignored = [];
    // B7/P2 (#3663): the incremental parser caps stored rows at
    // MAX_EVIDENCE_ENTRIES and counts every additional line PER CATEGORY, so
    // totals reflect the FULL output with the right kind even when paths are
    // not stored.
    for (const line of status.rows) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith("??")) {
            untracked.push(statusEntryPath(line));
        }
        else {
            tracked.push(statusEntryPath(line));
        }
    }
    // NOTE: git's `--ignored=matching` output repeats the `??` untracked lines
    // from the regular status call; only `!!` lines are ignored-file evidence.
    // Counting those `??` lines again would double-count untracked totals (B7).
    // The ignored call runs with a tight budget: with the regular status already
    // counted, only the ignored rows are needed, so the parser stops at the
    // entry cap and never inflates totals.
    if (ignoredStatus) {
        for (const line of ignoredStatus.rows) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (trimmed.startsWith("!!")) {
                ignored.push(statusEntryPath(line));
            }
        }
    }
    const entries = [...tracked, ...untracked, ...ignored].slice(0, MAX_EVIDENCE_ENTRIES);
    // Overflow rows from the regular status call carry tracked/untracked work.
    // The ignored call repeats the regular status rows, so only its `!!`
    // overflow is consumed — counting its `??`/tracked rows again would
    // double-count the at-risk totals (B7).
    const trackedTotal = tracked.length + status.overflow.tracked;
    const untrackedTotal = untracked.length + status.overflow.untracked;
    const ignoredTotal = ignored.length + (ignoredStatus?.overflow.ignored ?? 0);
    const truncated = status.outputTruncated ||
        ignoredStatus?.outputTruncated === true ||
        tracked.length + untracked.length + ignored.length > MAX_EVIDENCE_ENTRIES;
    return {
        kind: trackedTotal + untrackedTotal > 0 ? "dirty" : "clean",
        worktreeRoot: sanitizePathPart(toplevel),
        isLinkedWorktree: linked,
        trackedCount: trackedTotal,
        untrackedCount: untrackedTotal,
        ignoredCount: ignoredTotal,
        entries,
        truncated,
    };
}
/**
 * Build a bounded, redacted coordinator-facing notice for dirty-worktree
 * evidence. Returns null when there is nothing to warn about (clean, non-git,
 * missing cwd, git unavailable).
 */
export function buildDirtyWorktreeNotice(evidence, agentId, agentType) {
    if (evidence.kind !== "dirty" || !evidence.worktreeRoot)
        return null;
    const total = evidence.trackedCount + evidence.untrackedCount;
    const shortId = sanitizePathPart(agentId).substring(0, 7) || "agent";
    const type = sanitizePathPart(agentType).substring(0, 40) || "subagent";
    return (`[OMC] Agent ${shortId} (${type}) terminated with ${total} uncommitted file(s) ` +
        `(${evidence.trackedCount} tracked, ${evidence.untrackedCount} untracked) in ` +
        `${evidence.worktreeRoot}. Preserve this worktree before destructive cleanup; ` +
        `OMC does not auto-commit agent work.`);
}
//# sourceMappingURL=worktree-evidence.js.map