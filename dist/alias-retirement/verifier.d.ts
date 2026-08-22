/**
 * Alias retirement verifier — Issue #3711 / Epic #3698.
 *
 * Implements the authoritative retirement contract:
 *   retire ONLY after (2 minor releases AND 90 days) AND (>=95% canonical share for 2 consecutive releases) AND (zero critical integrations)
 * Otherwise an extension receipt is emitted. No alias or generated closure is removed by this module.
 *
 * This is a pure, deterministic, read-only evaluator. Callers supply current
 * version / date / telemetry; the verifier reports verdict + blockers and
 * materialises a machine-readable receipt. Deletion of aliases or their
 * generated projections is a separate, future PR that MUST attach these
 * receipts as evidence.
 */
import { type AliasRecord } from './registry.js';
import { RETIREMENT_POLICY, isTemporalThresholdMet, isConsecutiveCanonicalShareMet } from './policy.js';
export type RetirementVerdict = 'eligible' | 'extended';
export interface UsageSample {
    aliasCount: number;
    canonicalCount: number;
    releaseVersion?: string;
}
export interface AliasEvaluationInput {
    record: AliasRecord;
    currentVersion: string;
    now: Date;
    usageHistory: UsageSample[];
    criticalIntegrations: string[];
}
export interface BulkEvaluationInput {
    currentVersion?: string;
    now?: Date;
    /**
     * Per-alias usage history. Absence or empty array is treated as "no telemetry" → extension.
     * Supply at least `RETIREMENT_POLICY.requiredConsecutiveReleases` samples, ordered oldest→newest.
     * Each sample is one release window. For the consecutive-share gate, only the last N samples are evaluated.
     */
    usageHistoryByAlias?: Record<string, UsageSample[]>;
    /** Per-alias list of known critical integrations still using the alias. Non-empty → extension. */
    criticalIntegrationsByAlias?: Record<string, string[]>;
}
export interface AliasRetirementReceipt {
    schemaVersion: number;
    alias: string;
    canonical: string;
    kind: string;
    introducedVersion: string;
    introducedDate: string;
    currentVersion: string;
    evaluatedAt: string;
    policy: typeof RETIREMENT_POLICY;
    owner: string;
    checks: {
        temporal: ReturnType<typeof isTemporalThresholdMet>;
        consecutiveShare: ReturnType<typeof isConsecutiveCanonicalShareMet>;
        criticalIntegrations: {
            met: boolean;
            count: number;
            items: string[];
            reason: string;
        };
    };
    verdict: RetirementVerdict;
    blockers: string[];
    /**
     * Records whether a major-version boundary authorized this removal despite
     * unmet temporal/share gates, and which blockers it waived. Always present so
     * receipts stay auditable; `applied: false` carries the reason it did not fire.
     */
    majorBoundaryOverride: {
        applied: boolean;
        reason: string;
        waivedBlockers: string[];
    };
    /** True when verdict is 'extended' — i.e. this receipt is an extension receipt per the contract. */
    extensionReceipt: boolean;
    generatedArtifacts: string[];
    /**
     * Earliest date when the 90-day rule would be satisfied (null when already satisfied or introducedDate invalid).
     */
    nextEligibleDate: string | null;
    /**
     * Earliest minor release when the 2-minor rule would be satisfied (null when already satisfied).
     */
    nextEligibleVersion: string | null;
    removalMilestone: string;
}
export declare function evaluateAlias(input: AliasEvaluationInput): AliasRetirementReceipt;
export declare function verifyAllAliases(input?: BulkEvaluationInput): AliasRetirementReceipt[];
export declare function summarizeReceipts(receipts: AliasRetirementReceipt[]): {
    eligible: AliasRetirementReceipt[];
    extended: AliasRetirementReceipt[];
    allExtended: boolean;
    anyEligible: boolean;
};
//# sourceMappingURL=verifier.d.ts.map