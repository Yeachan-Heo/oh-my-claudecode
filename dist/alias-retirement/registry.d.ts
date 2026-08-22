/**
 * Alias retirement registry — Issue #3711 / Epic #3698.
 *
 * Source of truth for every alias that MUST remain until retirement
 * thresholds are proven. Retirement removes only the alias entry; the
 * generated-closure files listed under `generatedArtifacts` are eligible
 * for deletion *after* the alias itself is proven removable.
 *
 * Introduced metadata is derived from git history (package.json version
 * + commit date) so temporal checks are reproducible without relying on
 * a separate ledger.
 *
 * | alias              | canonical                | introduced | date       | min eligible (2 minors) | +90d            |
 * |--------------------|--------------------------|------------|------------|-------------------------|-----------------|
 * | learner            | skillify                 | 4.2.15     | 2026-02-19 | 4.4.0                   | 2026-05-20      |
 * | psm                | project-session-manager  | 4.2.15     | 2026-02-19 | 4.4.0                   | 2026-05-20      |
 * | cancel-ralph       | cancel                   | 4.3.0      | 2026-02-21 | 4.5.0                   | 2026-05-22      |
 * | understanding-gate | merge-readiness          | 4.15.3     | 2026-07-10 | 4.17.0                  | 2026-10-08      |
 */
export declare const ALIAS_RETIREMENT_SCHEMA_VERSION = 1;
export type AliasKind = 'skill';
export interface AliasRecord {
    /** Alias name as it appears to the user (lower-case canonical). */
    alias: string;
    /** Canonical skill name the alias resolves to. */
    canonical: string;
    /** Skill surface kind — planning keeps Tier-0 workflow kind out of this registry. */
    kind: AliasKind;
    /** Package version where the alias was first shipped. */
    introducedVersion: string;
    /** ISO date (YYYY-MM-DD) where the alias was first shipped. */
    introducedDate: string;
    /** Owner as defined in the planning contract (workflow registry owner). */
    owner: string;
    /** Human removal milestone — computed from temporal policy + proof gate. */
    removalMilestone: string;
    /** Generated / projection paths that become deletable only after alias removal. */
    generatedArtifacts: string[];
    /** Notes — e.g. whether the alias is realised via frontmatter or legacy directory. */
    notes?: string;
}
export declare const ALIAS_REGISTRY: readonly AliasRecord[];
export declare function getAliasRecord(alias: string): AliasRecord | undefined;
export declare function assertAliasRegistryIntegrity(): string[];
//# sourceMappingURL=registry.d.ts.map