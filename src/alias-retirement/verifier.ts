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
import { ALIAS_REGISTRY, ALIAS_RETIREMENT_SCHEMA_VERSION, type AliasRecord } from './registry.js';
import {
  RETIREMENT_POLICY,
  isTemporalThresholdMet,
  isConsecutiveCanonicalShareMet,
} from './policy.js';

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

export function evaluateAlias(input: AliasEvaluationInput): AliasRetirementReceipt {
  const { record, currentVersion, now, usageHistory, criticalIntegrations } = input;

  const temporal = isTemporalThresholdMet(
    record.introducedVersion,
    record.introducedDate,
    currentVersion,
    now,
  );

  const consecutiveShare = isConsecutiveCanonicalShareMet(usageHistory);

  const criticalItems = Array.isArray(criticalIntegrations) ? criticalIntegrations : [];
  const criticalMet = criticalItems.length === 0;
  const criticalReason = criticalMet
    ? 'zero known critical integrations'
    : `blocked by ${criticalItems.length} known critical integration(s): ${criticalItems.slice(0, 5).join(', ')}${criticalItems.length > 5 ? ' …' : ''}`;

  const blockers: string[] = [];
  if (!temporal.met) {
    if (!temporal.minors.met) blockers.push(`temporal: ${temporal.minors.reason}`);
    if (!temporal.days.met) blockers.push(`temporal: ${temporal.days.reason}`);
  }
  if (!consecutiveShare.met) blockers.push(`canonical-share: ${consecutiveShare.reason}`);
  if (!criticalMet) blockers.push(`critical-integrations: ${criticalReason}`);

  const verdict: RetirementVerdict = blockers.length === 0 ? 'eligible' : 'extended';

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
    extensionReceipt: verdict === 'extended',
    generatedArtifacts: [...record.generatedArtifacts],
    nextEligibleDate: temporal.nextEligibleDate,
    nextEligibleVersion: temporal.nextEligibleVersion,
    removalMilestone: record.removalMilestone,
  };
}

function getPackageVersionFallback(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          version?: string;
        };
        if (pkg.version) return pkg.version;
      } catch { /* empty — no package.json at this level, try parent */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* empty — no package.json found in any ancestor */ }
  return '0.0.0';
}

export function verifyAllAliases(input: BulkEvaluationInput = {}): AliasRetirementReceipt[] {
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

export function summarizeReceipts(receipts: AliasRetirementReceipt[]): {
  eligible: AliasRetirementReceipt[];
  extended: AliasRetirementReceipt[];
  allExtended: boolean;
  anyEligible: boolean;
} {
  const eligible = receipts.filter((r) => r.verdict === 'eligible');
  const extended = receipts.filter((r) => r.verdict === 'extended');
  return {
    eligible,
    extended,
    allExtended: eligible.length === 0,
    anyEligible: eligible.length > 0,
  };
}
