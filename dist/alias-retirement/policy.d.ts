/**
 * Alias retirement policy — Issue #3711 / Epic #3698.
 *
 * Retirement requires **all** of:
 * 1. Temporal: at least 2 minor releases AND 90 days (whichever is longer)
 * 2. Share: >=95% canonical usage for two consecutive releases
 * 3. Integrations: zero known critical integrations using the alias
 *
 * Otherwise an extension receipt is emitted.
 *
 * @see docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md (authoritative owner decisions)
 */
export declare const RETIREMENT_POLICY: {
    readonly minMinorReleases: 2;
    readonly minDays: 90;
    readonly minCanonicalShare: 0.95;
    readonly requiredConsecutiveReleases: 2;
    readonly requiresZeroCriticalIntegrations: true;
    readonly schemaVersion: 1;
};
/**
 * Major-version carve-out.
 *
 * The gates above protect users from aliases vanishing inside a minor release.
 * A major version is the sanctioned place for breaking removals, so a major
 * bump authorizes retirement directly — the removal is announced by the version
 * number itself rather than earned by elapsed time and usage share.
 *
 * This is deliberately narrow: it applies only when the current release crosses
 * a major boundary relative to when the alias was introduced. It never fires
 * within a minor or patch release, so the ordinary policy still governs
 * everything between majors.
 */
export declare function isMajorBoundaryRemoval(introducedVersion: string, currentVersion: string): {
    authorized: boolean;
    reason: string;
};
export interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    raw: string;
}
export declare function parseVersion(version: string): ParsedVersion | null;
export declare function countMinorReleasesSince(introducedVersion: string, currentVersion: string): number | null;
export declare function isMinorThresholdMet(introducedVersion: string, currentVersion: string, minMinors?: number): {
    met: boolean;
    elapsed: number | null;
    reason: string;
};
export declare function daysBetween(introducedDateIso: string, now: Date): number | null;
export declare function isDaysThresholdMet(introducedDateIso: string, now: Date, minDays?: number): {
    met: boolean;
    elapsed: number | null;
    reason: string;
};
export declare function isTemporalThresholdMet(introducedVersion: string, introducedDateIso: string, currentVersion: string, now: Date): {
    met: boolean;
    minors: ReturnType<typeof isMinorThresholdMet>;
    days: ReturnType<typeof isDaysThresholdMet>;
    nextEligibleDate: string | null;
    nextEligibleVersion: string | null;
};
export declare function canonicalShare(aliasCount: number, canonicalCount: number): number | null;
export declare function isCanonicalShareMet(aliasCount: number, canonicalCount: number, threshold?: number): {
    met: boolean;
    share: number | null;
    reason: string;
};
/**
 * Check two consecutive releases both meet the canonical share threshold.
 * `history` should be ordered oldest -> newest or by release semver ascending.
 * Only the last `requiredConsecutiveReleases` entries are evaluated when history
 * is longer.
 */
export declare function isConsecutiveCanonicalShareMet(history: Array<{
    aliasCount: number;
    canonicalCount: number;
}>, threshold?: number, requiredConsecutive?: number): {
    met: boolean;
    evaluated: Array<{
        share: number | null;
        met: boolean;
    }>;
    reason: string;
};
//# sourceMappingURL=policy.d.ts.map