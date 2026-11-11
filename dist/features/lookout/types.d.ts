/** Shared public types for the lookout feature. */
export type LookoutSeverity = "high" | "medium" | "low" | "info";
export type LookoutConfidence = "high" | "low";
export type LookoutVerdict = "clear" | "advisory" | "review-recommended";
export interface LookoutFinding {
    /** Stable rule id, namespaced `lookout.<surface>.<signal>`. */
    id: string;
    title: string;
    severity: LookoutSeverity;
    /** Mechanically checkable confidence level. */
    confidence: LookoutConfidence;
    actionable: boolean;
    /** Exact matched snippets / paths the finding is based on. */
    evidence: string[];
    /** What to do about it. */
    advice: string;
}
export interface LookoutReport {
    scannedAt: string;
    /** Repository root that was scanned, or null when outside a git repo. */
    repo: string | null;
    briefSource: "flag" | "file" | "none";
    findings: LookoutFinding[];
    summary: {
        counts: Record<LookoutSeverity, number>;
        verdict: LookoutVerdict;
    };
}
export declare class LookoutError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
//# sourceMappingURL=types.d.ts.map