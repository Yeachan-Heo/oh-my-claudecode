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
/**
 * Compare two version strings.
 *
 * Returns a negative number when `a` precedes `b`, a positive number when `a`
 * follows `b`, and 0 when they have equal precedence. An optional leading 'v'
 * is ignored, as is build metadata.
 */
export declare function compareVersions(a: string, b: string): number;
//# sourceMappingURL=semver-compare.d.ts.map