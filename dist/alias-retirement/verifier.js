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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIAS_REGISTRY, ALIAS_RETIREMENT_SCHEMA_VERSION } from './registry.js';
import { RETIREMENT_POLICY, isTemporalThresholdMet, isConsecutiveCanonicalShareMet, isMajorBoundaryRemoval, } from './policy.js';
export function evaluateAlias(input) {
    const { record, currentVersion, now, usageHistory, criticalIntegrations } = input;
    const temporal = isTemporalThresholdMet(record.introducedVersion, record.introducedDate, currentVersion, now);
    const consecutiveShare = isConsecutiveCanonicalShareMet(usageHistory);
    const criticalItems = Array.isArray(criticalIntegrations) ? criticalIntegrations : [];
    const criticalMet = criticalItems.length === 0;
    const criticalReason = criticalMet
        ? 'zero known critical integrations'
        : `blocked by ${criticalItems.length} known critical integration(s): ${criticalItems.slice(0, 5).join(', ')}${criticalItems.length > 5 ? ' …' : ''}`;
    const majorBoundary = isMajorBoundaryRemoval(record.introducedVersion, currentVersion);
    const blockers = [];
    if (!temporal.met) {
        if (!temporal.minors.met)
            blockers.push(`temporal: ${temporal.minors.reason}`);
        if (!temporal.days.met)
            blockers.push(`temporal: ${temporal.days.reason}`);
    }
    if (!consecutiveShare.met)
        blockers.push(`canonical-share: ${consecutiveShare.reason}`);
    if (!criticalMet)
        blockers.push(`critical-integrations: ${criticalReason}`);
    // A major-version boundary authorizes breaking removal on its own, EXCEPT
    // where a known critical integration still depends on the alias — that
    // blocker is about breaking real consumers, not about elapsed time, so a
    // version bump does not clear it.
    const majorAuthorized = majorBoundary.authorized && criticalMet;
    const verdict = blockers.length === 0 || majorAuthorized ? 'eligible' : 'extended';
    return {
        schemaVersion: ALIAS_RETIREMENT_SCHEMA_VERSION,
        alias: record.alias,
        canonical: record.canonical,
        kind: record.kind,
        introducedVersion: record.introducedVersion,
        introducedDate: record.introducedDate,
        currentVersion,
        evaluatedAt: now.toISOString(),
        policy: RETIREMENT_POLICY,
        owner: record.owner,
        checks: {
            temporal,
            consecutiveShare,
            criticalIntegrations: {
                met: criticalMet,
                count: criticalItems.length,
                items: [...criticalItems],
                reason: criticalReason,
            },
        },
        verdict,
        blockers,
        majorBoundaryOverride: majorAuthorized
            ? { applied: true, reason: majorBoundary.reason, waivedBlockers: [...blockers] }
            : { applied: false, reason: majorBoundary.reason, waivedBlockers: [] },
        extensionReceipt: verdict === 'extended',
        generatedArtifacts: [...record.generatedArtifacts],
        nextEligibleDate: temporal.nextEligibleDate,
        nextEligibleVersion: temporal.nextEligibleVersion,
        removalMilestone: record.removalMilestone,
    };
}
function getPackageVersionFallback() {
    try {
        let dir = dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 6; i++) {
            try {
                const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
                if (pkg.version)
                    return pkg.version;
            }
            catch { /* empty — no package.json at this level, try parent */ }
            const parent = dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch { /* empty — no package.json found in any ancestor */ }
    return '0.0.0';
}
export function verifyAllAliases(input = {}) {
    const currentVersion = (input.currentVersion ?? getPackageVersionFallback()).trim().replace(/^v/, '');
    const now = input.now ?? new Date();
    const usageByAlias = input.usageHistoryByAlias ?? {};
    const integrationsByAlias = input.criticalIntegrationsByAlias ?? {};
    return ALIAS_REGISTRY.map((record) => {
        const key = record.alias.toLowerCase();
        const history = usageByAlias[record.alias] ?? usageByAlias[key] ?? [];
        const integrations = integrationsByAlias[record.alias] ?? integrationsByAlias[key] ?? [];
        return evaluateAlias({
            record,
            currentVersion,
            now,
            usageHistory: Array.isArray(history) ? history : [],
            criticalIntegrations: Array.isArray(integrations) ? integrations : [],
        });
    });
}
export function summarizeReceipts(receipts) {
    const eligible = receipts.filter((r) => r.verdict === 'eligible');
    const extended = receipts.filter((r) => r.verdict === 'extended');
    return {
        eligible,
        extended,
        allExtended: eligible.length === 0,
        anyEligible: eligible.length > 0,
    };
}
//# sourceMappingURL=verifier.js.map