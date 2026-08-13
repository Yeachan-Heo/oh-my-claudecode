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

export const RETIREMENT_POLICY = {
  minMinorReleases: 2,
  minDays: 90,
  minCanonicalShare: 0.95,
  requiredConsecutiveReleases: 2,
  requiresZeroCriticalIntegrations: true,
  schemaVersion: 1,
} as const;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function parseVersion(version: string): ParsedVersion | null {
  const raw = version.trim().replace(/^v/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw,
  };
}

export function countMinorReleasesSince(
  introducedVersion: string,
  currentVersion: string,
): number | null {
  const intro = parseVersion(introducedVersion);
  const cur = parseVersion(currentVersion);
  if (!intro || !cur) return null;

  if (cur.major > intro.major) {
    // Major bump implies at least (cur.major - intro.major) * large + minor drift.
    // Conservative: treat as satisfying the minor threshold (>>2)
    // Compute effective minors as (major diff * 1000 + cur.minor - intro.minor)
    return (cur.major - intro.major) * 1000 + (cur.minor - intro.minor);
  }
  if (cur.major < intro.major) return null;
  const diff = cur.minor - intro.minor;
  return diff >= 0 ? diff : null;
}

export function isMinorThresholdMet(
  introducedVersion: string,
  currentVersion: string,
  minMinors: number = RETIREMENT_POLICY.minMinorReleases,
): { met: boolean; elapsed: number | null; reason: string } {
  const elapsed = countMinorReleasesSince(introducedVersion, currentVersion);
  if (elapsed === null) {
    return {
      met: false,
      elapsed: null,
      reason: `invalid or regressive semver (introduced=${introducedVersion}, current=${currentVersion})`,
    };
  }
  return {
    met: elapsed >= minMinors,
    elapsed,
    reason:
      elapsed >= minMinors
        ? `minor releases elapsed ${elapsed} >= ${minMinors}`
        : `minor releases elapsed ${elapsed} < ${minMinors} (need ${minMinors - elapsed} more minor releases)`,
  };
}

export function daysBetween(introducedDateIso: string, now: Date): number | null {
  const introduced = new Date(introducedDateIso);
  if (Number.isNaN(introduced.getTime())) return null;
  const ms = now.getTime() - introduced.getTime();
  if (ms < 0) return null;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function isDaysThresholdMet(
  introducedDateIso: string,
  now: Date,
  minDays: number = RETIREMENT_POLICY.minDays,
): { met: boolean; elapsed: number | null; reason: string } {
  const elapsed = daysBetween(introducedDateIso, now);
  if (elapsed === null) {
    return {
      met: false,
      elapsed: null,
      reason: `invalid introducedDate ${introducedDateIso}`,
    };
  }
  return {
    met: elapsed >= minDays,
    elapsed,
    reason:
      elapsed >= minDays
        ? `days elapsed ${elapsed} >= ${minDays}`
        : `days elapsed ${elapsed} < ${minDays} (need ${minDays - elapsed} more days)`,
  };
}

export function isTemporalThresholdMet(
  introducedVersion: string,
  introducedDateIso: string,
  currentVersion: string,
  now: Date,
): {
  met: boolean;
  minors: ReturnType<typeof isMinorThresholdMet>;
  days: ReturnType<typeof isDaysThresholdMet>;
  nextEligibleDate: string | null;
  nextEligibleVersion: string | null;
} {
  const minors = isMinorThresholdMet(introducedVersion, currentVersion);
  const days = isDaysThresholdMet(introducedDateIso, now);

  const met = minors.met && days.met;

  let nextEligibleDate: string | null = null;
  if (!days.met && days.elapsed !== null) {
    const introduced = new Date(introducedDateIso);
    const target = new Date(introduced.getTime() + RETIREMENT_POLICY.minDays * 24 * 60 * 60 * 1000);
    nextEligibleDate = target.toISOString().slice(0, 10);
  }

  let nextEligibleVersion: string | null = null;
  if (!minors.met) {
    const intro = parseVersion(introducedVersion);
    if (intro) {
      const targetMinor = intro.minor + RETIREMENT_POLICY.minMinorReleases;
      nextEligibleVersion = `${intro.major}.${targetMinor}.0`;
    }
  }

  return { met, minors, days, nextEligibleDate, nextEligibleVersion };
}

export function canonicalShare(aliasCount: number, canonicalCount: number): number | null {
  const total = aliasCount + canonicalCount;
  if (total <= 0) return null;
  if (aliasCount < 0 || canonicalCount < 0) return null;
  return canonicalCount / total;
}

export function isCanonicalShareMet(
  aliasCount: number,
  canonicalCount: number,
  threshold: number = RETIREMENT_POLICY.minCanonicalShare,
): { met: boolean; share: number | null; reason: string } {
  const share = canonicalShare(aliasCount, canonicalCount);
  if (share === null) {
    return { met: false, share: null, reason: `no usage data (alias=${aliasCount}, canonical=${canonicalCount})` };
  }
  return {
    met: share >= threshold,
    share,
    reason:
      share >= threshold
        ? `canonical share ${(share * 100).toFixed(2)}% >= ${(threshold * 100).toFixed(0)}%`
        : `canonical share ${(share * 100).toFixed(2)}% < ${(threshold * 100).toFixed(0)}%`,
  };
}

/**
 * Check two consecutive releases both meet the canonical share threshold.
 * `history` should be ordered oldest -> newest or by release semver ascending.
 * Only the last `requiredConsecutiveReleases` entries are evaluated when history
 * is longer.
 */
export function isConsecutiveCanonicalShareMet(
  history: Array<{ aliasCount: number; canonicalCount: number }>,
  threshold: number = RETIREMENT_POLICY.minCanonicalShare,
  requiredConsecutive: number = RETIREMENT_POLICY.requiredConsecutiveReleases,
): {
  met: boolean;
  evaluated: Array<{ share: number | null; met: boolean }>;
  reason: string;
} {
  if (history.length < requiredConsecutive) {
    return {
      met: false,
      evaluated: history.map((h) => {
        const r = isCanonicalShareMet(h.aliasCount, h.canonicalCount, threshold);
        return { share: r.share, met: r.met };
      }),
      reason: `insufficient releases: have ${history.length}, need ${requiredConsecutive}`,
    };
  }
  const tail = history.slice(-requiredConsecutive);
  const evaluated = tail.map((h) => {
    const r = isCanonicalShareMet(h.aliasCount, h.canonicalCount, threshold);
    return { share: r.share, met: r.met };
  });
  const met = evaluated.every((e) => e.met);
  return {
    met,
    evaluated,
    reason: met
      ? `last ${requiredConsecutive} releases all >= ${(threshold * 100).toFixed(0)}% canonical`
      : `last ${requiredConsecutive} releases not all >= ${(threshold * 100).toFixed(0)}%: ${evaluated
          .map((e) => (e.share === null ? 'no-data' : `${(e.share * 100).toFixed(1)}%`))
          .join(', ')}`,
  };
}
