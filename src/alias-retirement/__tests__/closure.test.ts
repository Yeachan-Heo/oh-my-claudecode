import { describe, it, expect } from 'vitest';
import { verifyAllAliases } from '../verifier.js';
import { buildClosureReport, summarizeClosureForEvidence } from '../closure.js';

const CURRENT_VERSION = '4.15.10';
const NOW = new Date('2026-08-12T00:00:00Z');

describe('alias-retirement generated closure', () => {
  it('reports no deletable artifacts while every alias is extended (steady state)', () => {
    const receipts = verifyAllAliases({ currentVersion: CURRENT_VERSION, now: NOW });
    // Inject exists -> always true for listed artifacts (simulates repo still carrying them)
    const report = buildClosureReport(receipts, {
      exists: () => true,
    });
    expect(report.allDeletable).toBe(false);
    expect(report.noPrematureDeletion).toBe(true);
    expect(report.entries.length).toBeGreaterThan(0);
    // Every entry must be non-deletable while its alias is extended
    for (const e of report.entries) {
      expect(e.deletableNow).toBe(false);
      expect(e.blockedBy.length).toBeGreaterThan(0);
    }
    expect(summarizeClosureForEvidence(report)).toContain('noPrematureDeletion=true');
    expect(summarizeClosureForEvidence(report)).toContain('allDeletable=false');
  });

  it('marks generated artifacts deletable only after eligibility is proven', () => {
    // Make learner eligible (temporal already satisfied + share satisfied + no critical)
    const receipts = verifyAllAliases({
      currentVersion: CURRENT_VERSION,
      now: NOW,
      usageHistoryByAlias: {
        learner: [
          { aliasCount: 2, canonicalCount: 98 },
          { aliasCount: 1, canonicalCount: 99 },
        ],
      },
      criticalIntegrationsByAlias: {
        learner: [],
      },
    });
    const report = buildClosureReport(receipts, {
      exists: () => true,
    });
    const learnerEntries = report.entries.filter((e) => e.alias === 'learner');
    expect(learnerEntries.length).toBeGreaterThan(0);
    // learner entries should be deletable now, others not
    for (const e of learnerEntries) expect(e.deletableNow).toBe(true);
    const other = report.entries.filter((e) => e.alias !== 'learner');
    // at least one other alias remains extended at this version without sufficient share
    expect(other.some((e) => !e.deletableNow)).toBe(true);
    // overall not all deletable yet
    expect(report.allDeletable).toBe(false);
  });

  it('never treats a missing file as deletable when alias is still extended', () => {
    const receipts = verifyAllAliases({ currentVersion: CURRENT_VERSION, now: NOW });
    const report = buildClosureReport(receipts, {
      exists: () => false,
    });
    // noPrematureDeletion is false when expected artifacts are missing while extended
    expect(report.noPrematureDeletion).toBe(false);
    // but deletability still reflects verifier verdict, not existence
    for (const e of report.entries) expect(e.deletableNow).toBe(false);
  });

  it('allDeletable true only when every receipt is eligible (future world)', () => {
    const futureVersion = '4.17.0';
    const futureNow = new Date('2026-10-09T00:00:00Z');
    const receipts = verifyAllAliases({
      currentVersion: futureVersion,
      now: futureNow,
      usageHistoryByAlias: {
        learner: [
          { aliasCount: 2, canonicalCount: 98 },
          { aliasCount: 1, canonicalCount: 99 },
        ],
        psm: [
          { aliasCount: 2, canonicalCount: 98 },
          { aliasCount: 1, canonicalCount: 99 },
        ],
        'cancel-ralph': [
          { aliasCount: 2, canonicalCount: 98 },
          { aliasCount: 1, canonicalCount: 99 },
        ],
        'understanding-gate': [
          { aliasCount: 2, canonicalCount: 98 },
          { aliasCount: 1, canonicalCount: 99 },
        ],
      },
    });
    for (const r of receipts) expect(r.verdict).toBe('eligible');
    const report = buildClosureReport(receipts, { exists: () => true });
    expect(report.allDeletable).toBe(true);
    expect(report.noPrematureDeletion).toBe(true);
    expect(report.entries.every((e) => e.deletableNow)).toBe(true);
  });
});
