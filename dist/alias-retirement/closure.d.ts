/**
 * Generated closure inventory for alias retirement — Issue #3711.
 *
 * Enumerates the generated/duplicate projection paths that become deletable
 * ONLY after their owning alias is proven `eligible` by the verifier. This
 * module never deletes files; it reports what would be deletable under a
 * proven-eligible receipt and asserts that no deletable file is removed
 * while the receipt is `extended`.
 *
 * Deletion itself MUST be performed in a dedicated, separately reviewed PR
 * that attaches the eligibility receipt as evidence.
 */
import type { AliasRetirementReceipt } from './verifier.js';
export interface GeneratedClosureEntry {
    path: string;
    alias: string;
    canonical: string;
    deletableOnlyAfterEligible: true;
    description: string;
}
export interface ClosureReport {
    evaluatedAt: string;
    currentVersion: string;
    entries: Array<{
        path: string;
        alias: string;
        canonical: string;
        deletableOnlyAfterEligible: true;
        exists: boolean;
        deletableNow: boolean;
        blockedBy: string[];
    }>;
    /** True only when every alias that owns a generated artifact is `eligible`. */
    allDeletable: boolean;
    /** True when every generated artifact that is present on disk is still owned by an `extended` alias — i.e. no premature cleanup happened. */
    noPrematureDeletion: boolean;
}
/**
 * Build a closure report from verifier receipts and a filesystem snapshot.
 *
 * `receipts` must be the output of `verifyAllAliases`.
 * `exists` is injectable for testing (defaults to fs.existsSync against `cwd`).
 */
export declare function buildClosureReport(receipts: AliasRetirementReceipt[], options?: {
    cwd?: string;
    exists?: (p: string) => boolean;
}): ClosureReport;
export declare function summarizeClosureForEvidence(report: ClosureReport): string;
//# sourceMappingURL=closure.d.ts.map