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
export declare const MAX_EVIDENCE_ENTRIES = 20;
export declare const GIT_TIMEOUT_MS = 2500;
export declare const MAX_EVIDENCE_PATH_LENGTH = 200;
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
export declare const EVIDENCE_DEADLINE_MS = 3000;
/**
 * Deliberate output bound for a single git call. Node's execFileSync default
 * maxBuffer is 1 MiB and raises ENOBUFS on large `--untracked-files=all`
 * output, silently losing ALL evidence (issue #3663 B7). We raise the child
 * buffer to this bound so a normal large dirty tree is fully counted, while
 * the incremental parser stops storing paths once MAX_EVIDENCE_ENTRIES is
 * reached (bounded memory) and keeps counting lines past the bound.
 */
export declare const GIT_MAX_BUFFER: number;
/** Kinds of evidence a stop hook can produce (never throws). */
export type WorktreeEvidenceKind = "dirty" | "clean" | "not_git" | "cwd_missing" | "git_unavailable";
export interface WorktreeDirtyEvidence {
    kind: WorktreeEvidenceKind;
    /** Git toplevel (worktree root) when resolvable. */
    worktreeRoot?: string;
    /** True when the toplevel is a linked git worktree (`.git` is a file). */
    isLinkedWorktree: boolean;
    /** Number of changed tracked files. */
    trackedCount: number;
    /** Number of untracked files (`??`). */
    untrackedCount: number;
    /** Number of ignored files (`!!`) — informational, NOT at-risk work. */
    ignoredCount: number;
    /** Bounded relative paths (redacted: paths only, never content). */
    entries: string[];
    /** True when entries were capped at MAX_EVIDENCE_ENTRIES. */
    truncated: boolean;
    /** Bounded reason when git could not be queried. */
    error?: string;
}
export interface WorktreeEvidenceOptions {
    /** Git binary path (test seam). Defaults to "git". */
    gitCommand?: string;
    /** Per-call git timeout in ms (test seam). Defaults to GIT_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Total budget in ms for ALL git work (test seam). Defaults to EVIDENCE_DEADLINE_MS. */
    deadlineMs?: number;
}
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
export declare function isAbnormalTermination(input: {
    success?: boolean;
    output?: string;
}): boolean;
/**
 * Collect bounded dirty-worktree evidence for a directory. READ-ONLY and
 * fail-closed: never throws, never mutates the repository. Total git wall-time
 * is capped by the shared EVIDENCE_DEADLINE_MS budget (issue #3663 B5/B8) so
 * durable state writes after collection can never be starved by the collector.
 */
export declare function collectWorktreeDirtyEvidence(cwd: string, opts?: WorktreeEvidenceOptions): WorktreeDirtyEvidence;
/**
 * Build a bounded, redacted coordinator-facing notice for dirty-worktree
 * evidence. Returns null when there is nothing to warn about (clean, non-git,
 * missing cwd, git unavailable).
 */
export declare function buildDirtyWorktreeNotice(evidence: WorktreeDirtyEvidence, agentId: string, agentType: string): string | null;
//# sourceMappingURL=worktree-evidence.d.ts.map