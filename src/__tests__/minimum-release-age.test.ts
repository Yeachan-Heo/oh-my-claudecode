import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  filterEligibleRelease,
  type ReleaseInfo,
} from '../features/auto-update.js';
import {
  getSecurityConfig,
  clearSecurityConfigCache,
  getMinimumReleaseAge,
} from '../lib/security-config.js';

function makeRelease(tag: string, daysAgo: number, nowMs: number): ReleaseInfo {
  const publishedAt = new Date(nowMs - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    published_at: publishedAt,
    html_url: `https://github.com/test/repo/releases/tag/${tag}`,
    body: `Release notes for ${tag}`,
    prerelease: false,
    draft: false,
  };
}

const NOW = new Date('2026-04-04T12:00:00Z').getTime();

describe('filterEligibleRelease', () => {
  it('selects latest eligible version when multiple exist', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW), // 1 day old
      makeRelease('v4.10.0', 8, NOW), // 8 days old
      makeRelease('v4.9.0', 30, NOW), // 30 days old
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.0');
    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0].tag_name).toBe('v4.10.1');
  });

  it('returns null when all versions are too young', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 3, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 7, NOW);

    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(2);
  });

  it('returns newest when minimumReleaseAge is 0', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 8, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 0, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.1');
    expect(result.heldBack).toHaveLength(0);
  });

  it('correctly sorts by version, not by date', () => {
    // v4.11.0 is the newest version but published 2 days ago (too young)
    // v4.10.5 is older version but published 10 days ago (eligible)
    // If sorted by date instead of version, v4.10.5 would be checked first.
    // Correct behavior: sort by version desc, so v4.11.0 is checked first (too young),
    // then v4.10.5 is checked (eligible).
    const releases = [
      makeRelease('v4.11.0', 2, NOW),  // newest version, too young
      makeRelease('v4.10.5', 10, NOW), // older version, eligible by age
    ];

    const result = filterEligibleRelease(releases, '4.10.0', 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.5');
    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0].tag_name).toBe('v4.11.0');
  });

  it('handles empty releases array', () => {
    const result = filterEligibleRelease([], '4.9.0', 7, NOW);

    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(0);
  });

  it('handles no currentVersion (fresh install)', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 8, NOW),
    ];

    const result = filterEligibleRelease(releases, null, 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.0');
  });

  it('filters out versions older than currentVersion', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 8, NOW),
      makeRelease('v4.9.0', 30, NOW),
    ];

    // Current is 4.10.0 — only v4.10.1 is newer, but it's too young
    const result = filterEligibleRelease(releases, '4.10.0', 7, NOW);

    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0].tag_name).toBe('v4.10.1');
  });

  it('returns newest eligible when age is exactly at threshold', () => {
    const releases = [
      makeRelease('v4.10.0', 7, NOW), // exactly 7 days old
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.0');
  });

  it('heldBack array is in version-descending order', () => {
    const releases = [
      makeRelease('v4.10.2', 1, NOW),
      makeRelease('v4.10.1', 3, NOW),
      makeRelease('v4.10.0', 5, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 7, NOW);

    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(3);
    expect(result.heldBack[0].tag_name).toBe('v4.10.2');
    expect(result.heldBack[1].tag_name).toBe('v4.10.1');
    expect(result.heldBack[2].tag_name).toBe('v4.10.0');
  });

  // --- Edge cases ---

  it('handles currentVersion with v prefix', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 8, NOW),
    ];

    const result = filterEligibleRelease(releases, 'v4.9.0', 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.0');
  });

  it('treats malformed published_at as held back (fail-safe)', () => {
    const badRelease: ReleaseInfo = {
      tag_name: 'v4.10.0',
      name: 'Release v4.10.0',
      published_at: 'not-a-date',
      html_url: 'https://github.com/test/repo',
      body: '',
      prerelease: false,
      draft: false,
    };

    const result = filterEligibleRelease([badRelease], '4.9.0', 7, NOW);

    // NaN age means ageMs >= thresholdMs is false → held back
    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(1);
  });

  it('treats negative minimumReleaseAge as disabled (same as 0)', () => {
    const releases = [
      makeRelease('v4.10.1', 1, NOW),
      makeRelease('v4.10.0', 8, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.9.0', -5, NOW);

    // Negative treated as <= 0 → no filtering, returns newest
    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v4.10.1');
    expect(result.heldBack).toHaveLength(0);
  });

  it('handles currentVersion equal to a release (not treated as newer)', () => {
    const releases = [
      makeRelease('v4.10.0', 8, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.10.0', 7, NOW);

    // v4.10.0 is not > currentVersion 4.10.0, so no eligible release
    expect(result.eligible).toBeNull();
    expect(result.heldBack).toHaveLength(0);
  });

  it('handles single release that is both newer and eligible', () => {
    const releases = [
      makeRelease('v5.0.0', 14, NOW),
    ];

    const result = filterEligibleRelease(releases, '4.9.0', 7, NOW);

    expect(result.eligible).not.toBeNull();
    expect(result.eligible!.tag_name).toBe('v5.0.0');
    expect(result.heldBack).toHaveLength(0);
  });

  it('handles large version gap with many releases', () => {
    // Simulate user very far behind with 50 releases
    const releases = Array.from({ length: 50 }, (_, i) => {
      const minor = 50 - i;
      return makeRelease(`v4.${minor}.0`, i + 1, NOW);
    });

    const result = filterEligibleRelease(releases, '4.0.0', 7, NOW);

    // Should pick the newest release that's >= 7 days old
    expect(result.eligible).not.toBeNull();
    // v4.44.0 is 7 days old (index 6, daysAgo = 7)
    expect(result.eligible!.tag_name).toBe('v4.44.0');
    // v4.45.0 through v4.50.0 should be held back (6 releases, 1-6 days old)
    expect(result.heldBack).toHaveLength(6);
  });
});

describe('SecurityConfig.minimumReleaseAge', () => {
  const originalEnv = process.env.OMC_SECURITY;

  beforeEach(() => {
    clearSecurityConfigCache();
    delete process.env.OMC_SECURITY;
  });

  afterEach(() => {
    clearSecurityConfigCache();
    if (originalEnv !== undefined) {
      process.env.OMC_SECURITY = originalEnv;
    } else {
      delete process.env.OMC_SECURITY;
    }
  });

  it('returns 0 when no config and not strict mode', () => {
    const config = getSecurityConfig();
    expect(config.minimumReleaseAge).toBe(0);
  });

  it('returns 7 when OMC_SECURITY=strict and no explicit config', () => {
    process.env.OMC_SECURITY = 'strict';
    const config = getSecurityConfig();
    expect(config.minimumReleaseAge).toBe(7);
  });

  it('strict mode + minimumReleaseAge > 0 sets disableAutoUpdate to false', () => {
    process.env.OMC_SECURITY = 'strict';
    const config = getSecurityConfig();
    // minimumReleaseAge is 7 (from STRICT_OVERRIDES), so disableAutoUpdate should be false
    expect(config.minimumReleaseAge).toBe(7);
    expect(config.disableAutoUpdate).toBe(false);
  });

  it('getMinimumReleaseAge convenience function works', () => {
    expect(getMinimumReleaseAge()).toBe(0);

    clearSecurityConfigCache();
    process.env.OMC_SECURITY = 'strict';
    expect(getMinimumReleaseAge()).toBe(7);
  });
});
