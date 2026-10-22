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
  core: [string, string, string];
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

  const parts = coreText.split('.').map(part => {
    // Extract leading digits to handle display-only suffixes like '4.15.7L'.
    // parseInt would lose precision on very large numbers, so extract digits
    // as a string instead. If there are no leading digits, use '0'.
    const match = part.match(/^(\d+)/);
    return match ? match[1] : '0';
  });

  return {
    core: [parts[0] ?? '0', parts[1] ?? '0', parts[2] ?? '0'],
    prerelease: prereleaseText === '' ? [] : prereleaseText.split('.'),
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);

  // Numeric identifiers compare numerically; a numeric identifier always has
  // lower precedence than an alphanumeric one (semver §11).
  //
  // Compared as digit strings rather than through Number, which silently loses
  // precision past 2^53: Number('10000000000000000000') and
  // Number('10000000000000000001') are the same double, so two distinct
  // prereleases compared equal and an older target could pass the installer's
  // `compareVersions(...) < 0` downgrade guard. Semver puts no bound on the
  // length of a numeric identifier, so no fixed-width type is safe here.
  if (aNumeric && bNumeric) {
    const aDigits = a.replace(/^0+(?=\d)/, '');
    const bDigits = b.replace(/^0+(?=\d)/, '');
    if (aDigits.length !== bDigits.length) {
      return aDigits.length < bDigits.length ? -1 : 1;
    }
    return aDigits < bDigits ? -1 : aDigits > bDigits ? 1 : 0;
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

  // Compare core version using the same digit-string comparator as prerelease
  // identifiers to avoid precision loss on very large numbers. JavaScript
  // numbers lose precision past 2^53, so Number('1.10000000000000000000.0')
  // and Number('1.10000000000000000001.0') would compare equal.
  for (let i = 0; i < 3; i += 1) {
    const delta = comparePrereleaseIdentifier(parsedA.core[i], parsedB.core[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }

  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}
