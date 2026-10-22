/**
 * Version comparison shared by the updater, the installer and the plugin-cache
 * purge.
 *
 * Previously each of those carried its own copy built on
 * `version.split('.').map(part => parseInt(part, 10) || 0)`. That splits a
 * prerelease into an extra segment -- '5.7.7-beta.1' becomes
 * ['5', '7', '7-beta', '1'] -- so the trailing '.1' was read as a fourth
 * version component and the prerelease sorted *above* its own release:
 * compare('5.7.7-beta.1', '5.7.7') returned 1. A user on a prerelease was
 * therefore told they were up to date and never offered the stable build.
 *
 * This implementation follows semver's precedence rules: build metadata is
 * ignored, the numeric core is compared component-wise, and a version carrying
 * a prerelease sorts below the same version without one.
 */

interface ParsedVersion {
  core: [number, number, number];
  /** Dot-separated prerelease identifiers; empty when this is a release. */
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion {
  // Build metadata ('+sha') never affects precedence (semver §10).
  const withoutBuild = version.replace(/^v/, '').split('+', 1)[0];

  // Only a hyphen introduces a prerelease. A bare trailing suffix such as the
  // display-only '4.15.7L' is not a prerelease, and parseInt below tolerates it
  // so that '4.15.7L' still compares equal to '4.15.7' (see issue #3867).
  const hyphen = withoutBuild.indexOf('-');
  const coreText = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen);
  const prereleaseText = hyphen === -1 ? '' : withoutBuild.slice(hyphen + 1);

  const parts = coreText.split('.').map(part => parseInt(part, 10) || 0);

  return {
    core: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    prerelease: prereleaseText === '' ? [] : prereleaseText.split('.'),
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);

  // Numeric identifiers compare numerically; a numeric identifier always has
  // lower precedence than an alphanumeric one (semver §11).
  if (aNumeric && bNumeric) {
    return Number(a) - Number(b);
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version without a prerelease outranks one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const delta = comparePrereleaseIdentifier(a[i], b[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }

  // All shared identifiers match, so the longer set has higher precedence.
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Compare two version strings.
 *
 * Returns a negative number when `a` precedes `b`, a positive number when `a`
 * follows `b`, and 0 when they have equal precedence. An optional leading 'v'
 * is ignored, as is build metadata.
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    if (parsedA.core[i] < parsedB.core[i]) return -1;
    if (parsedA.core[i] > parsedB.core[i]) return 1;
  }

  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}
