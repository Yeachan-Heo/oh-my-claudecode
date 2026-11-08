/**
 * Shared version helper
 * Single source of truth for package version at runtime.
 */
import { readFileSync, existsSync, lstatSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
/**
 * Get the package version from package.json at runtime.
 * Works from any file within the package (src/ or dist/).
 */
export function getRuntimePackageVersion() {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        // Try multiple levels up to find package.json
        // From dist/lib/version.js -> ../../package.json
        // From src/lib/version.ts -> ../../package.json
        for (let i = 0; i < 5; i++) {
            const candidate = join(__dirname, ...Array(i + 1).fill('..'), 'package.json');
            try {
                const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
                if (pkg.name && pkg.version) {
                    return pkg.version;
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        // Fallback
    }
    // Fallback: extract version from the plugin cache directory path.
    // When package.json is missing (e.g. Claude Code plugin system didn't copy it),
    // the path itself contains the version: .../oh-my-claudecode/4.11.2/dist/lib/version.js
    try {
        const __filename = fileURLToPath(import.meta.url);
        const pathMatch = __filename.match(/oh-my-claudecode\/(\d+\.\d+\.\d+[^/]*)\//);
        if (pathMatch?.[1]) {
            return pathMatch[1];
        }
    }
    catch {
        // Fallback
    }
    return 'unknown';
}
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
export function isRuntimePackageLocal() {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        // Walk up to find the package root (the dir containing package.json)
        let pkgRoot = null;
        for (let i = 0; i < 5; i++) {
            const candidate = join(__dirname, ...Array(i + 1).fill('..'));
            if (existsSync(join(candidate, 'package.json'))) {
                pkgRoot = candidate;
                break;
            }
        }
        if (!pkgRoot)
            return false;
        // Signal 1: a .git/ directory at package root means dev clone
        if (existsSync(join(pkgRoot, '.git')))
            return true;
        // Signal 2: a src/ directory at the package root means the payload
        // came from a fork — the npm-published package only ships dist/.
        if (existsSync(join(pkgRoot, 'src')))
            return true;
        // Signal 3: realpath differs from the path we walked to — the package
        // was reached via a symlink or junction (`npm link`, manual junction).
        try {
            const real = realpathSync(pkgRoot);
            // Normalize separators for cross-platform comparison
            const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
            if (norm(real) !== norm(pkgRoot))
                return true;
        }
        catch {
            // realpath failure — fall through
        }
        // Signal 3b: check ancestors for symlink/junction (covers cases where
        // a parent dir like ~/.claude/plugins/marketplaces/omc is the junction).
        let cursor = pkgRoot;
        for (let i = 0; i < 6; i++) {
            const parent = dirname(cursor);
            if (parent === cursor)
                break;
            try {
                if (lstatSync(cursor).isSymbolicLink())
                    return true;
            }
            catch {
                // ignore
            }
            cursor = parent;
        }
    }
    catch {
        // Any failure — treat as not local
    }
    return false;
}
//# sourceMappingURL=version.js.map