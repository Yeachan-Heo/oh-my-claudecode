/**
 * Shared version helper
 * Single source of truth for package version at runtime.
 */
/**
 * Get the package version from package.json at runtime.
 * Works from any file within the package (src/ or dist/).
 */
export declare function getRuntimePackageVersion(): string;
/**
 * Detect whether OMC is running from a local fork / dev install rather
 * than from the npm-published package.
 *
 * Signals (any one triggers "local"):
 *  - A `.git/` directory exists at the package root (dev clone)
 *  - The resolved package directory is reached via a symlink/junction
 *    (e.g. `npm link`, or a manual junction in `~/.claude/plugins/marketplaces/`)
 *  - A `src/` directory exists at the package root — the npm-published
 *    package ships only `dist/`. The presence of `src/` proves the
 *    payload came from a fork (e.g. Claude Code's plugin cache copied
 *    the full repo through a marketplace junction).
 *
 * Used by the HUD to append an "L" suffix to the version tag, so users
 * can tell at a glance whether their changes are live.
 *
 * Returns false on any error — the indicator is informational and must
 * never block rendering.
 */
export declare function isRuntimePackageLocal(): boolean;
//# sourceMappingURL=version.d.ts.map