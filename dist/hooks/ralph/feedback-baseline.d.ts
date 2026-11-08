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
export declare function writeBaseline(path: string, commands: Record<string, CommandBaseline>, now?: Date): boolean;
//# sourceMappingURL=feedback-baseline.d.ts.map