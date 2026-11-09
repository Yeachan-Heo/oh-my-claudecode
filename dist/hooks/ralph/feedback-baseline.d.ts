/**
 * Feedback baseline engine (spec #45): the single executor of ralph's
 * feedback diff judgment.
 *
 * A ralph run records, per feedback command, a set of normalized failure
 * SIGNATURE LINES from the current tree at startup; every later gate judges by
 * diffing the current run's signatures against that baseline. New signatures
 * are real signal; baseline-only signatures are environment noise (a dirty
 * toolchain or platform-specific suite) and must not consume iterations.
 *
 * Pure logic here; the CLI command owns execution, IO, and exit codes. The
 * skill text owns when to gate and what a signature means for the current
 * story — this module never decides that.
 */
export declare const FEEDBACK_BASELINE_FILENAME = "feedback-baseline.json";
/** Sibling directory that keeps replaced baselines recoverable. */
export declare const FEEDBACK_BASELINE_HISTORY_DIRNAME = "feedback-baseline.history";
/** Bounded history: older re-records are pruned so the state directory cannot grow without limit. */
export declare const MAX_FEEDBACK_BASELINE_HISTORY = 20;
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export declare const MAX_SIGNATURES_PER_COMMAND = 200;
/**
 * Reduce one command's combined output to its failure signature set:
 * ANSI stripped, volatile fragments normalized, boilerplate dropped,
 * deduplicated, capped, and sorted for a stable diff. Lines that look like
 * progress rather than failure ("Running tests...", spinner frames) are
 * dropped. Pass/test count summary lines (e.g., '# pass N', '# tests N') are
 * excluded but failure count lines (e.g., '# fail N') are kept — a changed
 * fail count is signal that something moved. Individual passing test results
 * ("ok N ...") are excluded to prevent false positives when tests are added;
 * failing results ("not ok ...") are kept.
 */
export declare function signatureLines(output: string): string[];
export interface CommandBaseline {
    /** Normalized failure signatures observed for this command at baseline time. */
    signatures: string[];
    /** True when the command could not execute at all (tool missing, suite unrunnable). */
    unrunnable?: boolean;
    /**
     * True when the command exceeded the verify timeout. A killed process only
     * produced partial output, so nothing in it is failure evidence: the
     * progress lines depend on how long the run lasted, not on what failed.
     */
    timedOut?: boolean;
}
export interface FeedbackBaseline {
    version: 1;
    /** ISO 8601. */
    recordedAt: string;
    commands: Record<string, CommandBaseline>;
}
export interface BaselineDiff {
    /** Present now, absent in the baseline — the only real signal. */
    newSignatures: string[];
    /** In the baseline, gone now — informational only. */
    resolvedSignatures: string[];
}
/**
 * Pure diff: a signature is new when it is absent from the baseline. A command
 * that used to run and now cannot execute is itself a regression. With no
 * baseline at all, everything present is reported as new — the caller decides
 * what that means (baseline creation reports instead of failing).
 */
export declare function diffAgainstBaseline(baseline: FeedbackBaseline | null, current: Record<string, CommandBaseline>): BaselineDiff;
export declare function baselinePath(stateRoot: string, sessionId: string): string;
export declare function readBaseline(path: string): FeedbackBaseline | null;
/**
 * Copy the live baseline into its sibling history directory before it is
 * replaced, returning the history path (or null when there is nothing to
 * archive or the copy failed). The file name uses the replaced document's own
 * `recordedAt` (sanitized for cross-platform paths) plus a counter, so history
 * sorts chronologically.
 */
export declare function archiveBaseline(path: string, now?: Date): string | null;
export interface BaselineWriteResult {
    written: boolean;
    /** History path preserving the replaced baseline, when one existed. */
    previousPath?: string;
    /** Signatures present now but absent from the replaced baseline. */
    added: number;
    /** Signatures in the replaced baseline that are gone now. */
    removed: number;
    /** Commands that ran in the replaced baseline but could not execute now. */
    becameUnrunnable?: string[];
}
/**
 * Write a baseline, archiving any existing document first. The archive must
 * succeed before the live file is replaced: losing history silently is the bug
 * this guards against, so an unarchivable previous baseline fails the write.
 *
 * The whole read/archive/write transaction runs under a sibling `.lock` file.
 * `COPYFILE_EXCL` only makes archive NAMES unique; without serialization two
 * writers could archive the same original and the second could overwrite the
 * first replacement without archiving it. A writer that cannot take the lock
 * fails closed rather than proceeding unlocked.
 *
 * A failed live write leaves the archive in place: when `writeFileSync` fails
 * partway (ENOSPC/EFBIG) that archive is the only intact recovery copy.
 */
export declare function recordBaseline(path: string, commands: Record<string, CommandBaseline>, now?: Date): BaselineWriteResult;
/** Backward-compatible wrapper: the boolean says only whether the write succeeded. */
export declare function writeBaseline(path: string, commands: Record<string, CommandBaseline>, now?: Date): boolean;
//# sourceMappingURL=feedback-baseline.d.ts.map