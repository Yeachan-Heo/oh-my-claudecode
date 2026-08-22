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
export const ALIAS_RETIREMENT_SCHEMA_VERSION = 1;
// `learner` (-> skillify) and `understanding-gate` (-> merge-readiness) were
// retired in 5.0.0 under the major-version carve-out; their skills, commands,
// and generated projections were removed, so they no longer have records here.
export const ALIAS_REGISTRY = [
    {
        alias: 'psm',
        canonical: 'project-session-manager',
        kind: 'skill',
        introducedVersion: '4.2.15',
        introducedDate: '2026-02-19',
        owner: 'workflow-registry (src/features/builtin-skills/skills.ts + commands/)',
        removalMilestone: 'TBD: >=4.4.0 && >=2026-05-20 && 2 consecutive releases at >=95% canonical && zero critical integrations',
        generatedArtifacts: ['commands/psm.md'],
        notes: 'project-session-manager frontmatter aliases:[psm]; no extra skill dir — frontmatter-only alias',
    },
    {
        alias: 'cancel-ralph',
        canonical: 'cancel',
        kind: 'skill',
        introducedVersion: '4.3.0',
        introducedDate: '2026-02-21',
        owner: 'workflow-registry (src/features/builtin-skills/skills.ts + commands/)',
        removalMilestone: 'TBD: >=4.5.0 && >=2026-05-22 && 2 consecutive releases at >=95% canonical && zero critical integrations',
        generatedArtifacts: [],
        notes: 'cancel frontmatter aliases:[cancel-ralph]; frontmatter-only alias, no duplicate projection dir',
    },
];
export function getAliasRecord(alias) {
    const key = alias.trim().toLowerCase();
    return ALIAS_REGISTRY.find((r) => r.alias.toLowerCase() === key);
}
export function assertAliasRegistryIntegrity() {
    const errors = [];
    const seen = new Set();
    for (const rec of ALIAS_REGISTRY) {
        if (!rec.alias || !rec.canonical)
            errors.push(`empty alias/canonical for ${JSON.stringify(rec)}`);
        const k = rec.alias.toLowerCase();
        if (seen.has(k))
            errors.push(`duplicate alias ${rec.alias}`);
        seen.add(k);
        if (rec.alias.toLowerCase() === rec.canonical.toLowerCase()) {
            errors.push(`alias ${rec.alias} equals canonical`);
        }
        // Validate introducedVersion parses
        const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(rec.introducedVersion.replace(/^v/, ''));
        if (!m)
            errors.push(`alias ${rec.alias} has invalid introducedVersion ${rec.introducedVersion}`);
        // Validate introducedDate is YYYY-MM-DD
        if (Number.isNaN(new Date(rec.introducedDate).getTime())) {
            errors.push(`alias ${rec.alias} has invalid introducedDate ${rec.introducedDate}`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.introducedDate)) {
            errors.push(`alias ${rec.alias} introducedDate must be YYYY-MM-DD, got ${rec.introducedDate}`);
        }
    }
    return errors;
}
//# sourceMappingURL=registry.js.map