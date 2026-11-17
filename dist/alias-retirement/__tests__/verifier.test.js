import { describe, it, expect } from 'vitest';
import { ALIAS_REGISTRY, getAliasRecord } from '../registry.js';
import { evaluateAlias, verifyAllAliases, summarizeReceipts } from '../verifier.js';
import { isTemporalThresholdMet } from '../policy.js';
const CURRENT_VERSION = '4.15.10';
const NOW = new Date('2026-08-12T00:00:00Z');
// Helpers to build telemetry that satisfies share gates
function eligibleHistory() {
    return [
        { aliasCount: 2, canonicalCount: 98 }, // 98%
        { aliasCount: 1, canonicalCount: 99 }, // 99%
    ];
}
function ineligibleHistory() {
    return [
        { aliasCount: 2, canonicalCount: 98 },
        { aliasCount: 10, canonicalCount: 90 }, // 90% < 95
    ];
}
/**
 * A recently-introduced alias, used to exercise the temporal gate. The real
 * `understanding-gate` record filled this role until it was retired in 5.0.0;
 * every surviving registry alias is now old enough to clear the temporal gate,
 * so the blocked case needs a synthetic record to stay covered.
 */
const RECENT_RECORD = {
    alias: 'recently-introduced',
    canonical: 'cancel',
    kind: 'skill',
    introducedVersion: '4.15.3',
    introducedDate: '2026-07-10',
    owner: 'workflow-registry (test fixture)',
    removalMilestone: 'TBD: >=4.17.0 && >=2026-10-08 && 2 consecutive releases at >=95% canonical',
    generatedArtifacts: [],
};
describe('alias-retirement verifier', () => {
    it('emits extension receipts for every alias at current version without telemetry (acceptance guard)', () => {
        const receipts = verifyAllAliases({ currentVersion: CURRENT_VERSION, now: NOW });
        expect(receipts).toHaveLength(ALIAS_REGISTRY.length);
        for (const r of receipts) {
            expect(r.verdict).toBe('extended');
            expect(r.extensionReceipt).toBe(true);
            expect(r.blockers.length).toBeGreaterThan(0);
            expect(r.schemaVersion).toBe(1);
            expect(r.currentVersion).toBe(CURRENT_VERSION);
            // Every extension receipt must carry at least one blocker reason
            expect(r.blockers.join(' ')).toMatch(/temporal|canonical-share|critical-integrations/);
        }
        const summary = summarizeReceipts(receipts);
        expect(summary.allExtended).toBe(true);
        expect(summary.anyEligible).toBe(false);
    });
    it('a recently-introduced alias is blocked by temporal gate at current version even with perfect telemetry', () => {
        const rec = RECENT_RECORD;
        const temporal = isTemporalThresholdMet(rec.introducedVersion, rec.introducedDate, CURRENT_VERSION, NOW);
        expect(temporal.met).toBe(false);
        // 4.15.3 → 4.15.10 is 0 minors, need 2 more; 2026-07-10 → 2026-08-12 is 33 days, need 57 more
        expect(temporal.minors.met).toBe(false);
        expect(temporal.days.met).toBe(false);
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistory: eligibleHistory(),
            criticalIntegrations: [],
        });
        expect(receipt.verdict).toBe('extended');
        expect(receipt.blockers.some((b) => b.includes('temporal'))).toBe(true);
        expect(receipt.nextEligibleDate).toBe('2026-10-08');
        expect(receipt.nextEligibleVersion).toBe('4.17.0');
    });
    it('psm is temporal-eligible at current version but still extended without share telemetry', () => {
        const rec = getAliasRecord('psm');
        const temporal = isTemporalThresholdMet(rec.introducedVersion, rec.introducedDate, CURRENT_VERSION, NOW);
        expect(temporal.met).toBe(true); // 4.2.15 → 4.15.10 is 13 minors + 174 days
        const receiptNoTelemetry = evaluateAlias({
            record: rec,
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistory: [],
            criticalIntegrations: [],
        });
        expect(receiptNoTelemetry.verdict).toBe('extended');
        expect(receiptNoTelemetry.blockers.some((b) => b.includes('canonical-share'))).toBe(true);
        expect(receiptNoTelemetry.checks.temporal.met).toBe(true);
    });
    it('psm becomes eligible when all three gates are satisfied (future proof)', () => {
        const rec = getAliasRecord('psm');
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistory: eligibleHistory(),
            criticalIntegrations: [],
        });
        expect(receipt.verdict).toBe('eligible');
        expect(receipt.extensionReceipt).toBe(false);
        expect(receipt.blockers).toEqual([]);
        expect(receipt.checks.temporal.met).toBe(true);
        expect(receipt.checks.consecutiveShare.met).toBe(true);
        expect(receipt.checks.criticalIntegrations.met).toBe(true);
    });
    it('eligible psm is still extended when only one of the two share samples passes', () => {
        const rec = getAliasRecord('psm');
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistory: ineligibleHistory(),
            criticalIntegrations: [],
        });
        expect(receipt.verdict).toBe('extended');
        expect(receipt.blockers.some((b) => b.includes('canonical-share'))).toBe(true);
    });
    it('critical-integrations block prevents eligibility even when temporal+share are met', () => {
        const rec = getAliasRecord('psm');
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistory: eligibleHistory(),
            criticalIntegrations: ['org/repo uses /psm in CI', 'marketplace template references psm'],
        });
        expect(receipt.verdict).toBe('extended');
        expect(receipt.blockers.some((b) => b.includes('critical-integrations'))).toBe(true);
        expect(receipt.checks.criticalIntegrations.count).toBe(2);
    });
    it('verifyAllAliases bulk path respects per-alias histories and integrations', () => {
        const receipts = verifyAllAliases({
            currentVersion: CURRENT_VERSION,
            now: NOW,
            usageHistoryByAlias: {
                psm: eligibleHistory(),
                'cancel-ralph': ineligibleHistory(),
            },
            criticalIntegrationsByAlias: {
                psm: [],
            },
        });
        const byAlias = new Map(receipts.map((r) => [r.alias, r]));
        expect(byAlias.get('psm').verdict).toBe('eligible');
        expect(byAlias.get('cancel-ralph').verdict).toBe('extended'); // share
        expect(summarizeReceipts(receipts).anyEligible).toBe(true);
        expect(summarizeReceipts(receipts).allExtended).toBe(false);
    });
    it('receipt shape is stable and carries policy + next-eligible fields', () => {
        const rec = RECENT_RECORD;
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: '4.17.0',
            now: new Date('2026-10-09T00:00:00Z'),
            usageHistory: [{ aliasCount: 0, canonicalCount: 0 }],
            criticalIntegrations: [],
        });
        // 4.15.3 → 4.17.0 is 2 minors, 2026-07-10 → 2026-10-09 is 91 days → temporal met, but share empty → still extended
        expect(receipt.checks.temporal.met).toBe(true);
        expect(receipt.verdict).toBe('extended');
        expect(receipt.policy.minMinorReleases).toBe(2);
        expect(receipt.policy.minDays).toBe(90);
        expect(receipt.policy.minCanonicalShare).toBe(0.95);
        expect(typeof receipt.evaluatedAt).toBe('string');
        expect(receipt.generatedArtifacts).toBeDefined();
        expect(Array.isArray(receipt.generatedArtifacts)).toBe(true);
    });
    it('future eligible date/version: a recently-introduced alias becomes eligible only after 4.17.0 + 90d + share with zero integrations', () => {
        const rec = RECENT_RECORD;
        const receipt = evaluateAlias({
            record: rec,
            currentVersion: '4.17.0',
            now: new Date('2026-10-09T00:00:00Z'),
            usageHistory: eligibleHistory(),
            criticalIntegrations: [],
        });
        expect(receipt.verdict).toBe('eligible');
        expect(receipt.nextEligibleDate).toBeNull();
        expect(receipt.nextEligibleVersion).toBeNull();
    });
});
//# sourceMappingURL=verifier.test.js.map