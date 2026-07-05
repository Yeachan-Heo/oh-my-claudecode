/**
 * Shared version helper
 * Single source of truth for package version at runtime.
 */
import { readFileSync } from 'fs';
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
    // the path itself contains the version: .../lazycc/4.11.2/dist/lib/version.js
    try {
        const __filename = fileURLToPath(import.meta.url);
        const pathMatch = __filename.match(/lazycc\/(\d+\.\d+\.\d+[^/]*)\//);
        if (pathMatch?.[1]) {
            return pathMatch[1];
        }
    }
    catch {
        // Fallback
    }
    return 'unknown';
}
//# sourceMappingURL=version.js.map