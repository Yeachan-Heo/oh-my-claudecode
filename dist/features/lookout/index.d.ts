/**
 * lookout: pre-flight danger scan for autonomous runs.
 *
 * Before an unattended effort starts (graph run, autopilot, launch, a
 * multi-agent team), lookout scans two inputs:
 *   1. the task briefing text (what the agent is about to be asked to do)
 *   2. the workspace state (what dangerous surfaces already exist)
 * and emits a machine-readable report of findings. High-risk verdicts pair
 * naturally with OMC's approval gates (`omc graph run --approval-mode
 * remote`) and checkpoints (`omc checkpoint create`), but lookout itself is
 * advisory only: it never blocks, never mutates, and has no skip-file
 * backdoor (silence is a whole-feature decision, not a per-run reflex).
 *
 * Design constraints (lessons from the retired risk-assess classifier,
 * see upstream issue #3164):
 * - High-confidence signals only: every rule is mechanically checkable and
 *   reports the exact evidence it matched. No volume heuristics, no
 *   catch-all "unknown means warn" branches, no bare substring matching
 *   on broad tokens (patterns are word- and path-segment-anchored).
 * - Prefer misses over false positives: a lookout that cries wolf trains
 *   users to ignore it, and the protection dies with the habit.
 * - Zero-config: no ignore files, no per-rule toggles. If a scan is noisy,
 *   that is a bug in the rules, not something the user should have to
 *   suppress per run.
 *
 * The finding shape (severity / confidence / actionable) deliberately uses
 * the vocabulary drydock's `--check` audit documents, so a structured
 * contract can later be shared by both surfaces.
 */
import type { LookoutReport } from "./types.js";
export { LookoutError } from "./types.js";
export type { LookoutConfidence, LookoutFinding, LookoutReport, LookoutSeverity, LookoutVerdict, } from "./types.js";
export interface ScanLookoutOptions {
    /** Directory to scan (defaults to process.cwd() at the CLI layer). */
    repo: string;
    /** Briefing text to scan; omit to scan workspace state only. */
    brief?: string;
    /** Where the brief came from (report metadata only). */
    briefSource?: LookoutReport["briefSource"];
    /** Injectable clock for tests. */
    now?: Date;
}
/**
 * Runs every lookout rule over the given inputs and returns the full report.
 * Read-only by construction: the only filesystem/git access is reading
 * tracked-file lists and status output.
 */
export declare function scanLookout(options: ScanLookoutOptions): LookoutReport;
/** Loads a briefing from `@path` (or returns inline text unchanged). */
export declare function resolveBriefArg(briefArg: string): {
    text: string;
    source: LookoutReport["briefSource"];
};
//# sourceMappingURL=index.d.ts.map