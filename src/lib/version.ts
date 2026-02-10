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
export function getRuntimePackageVersion(): string {
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
      } catch {
        continue;
      }
    }
  } catch {
    // Fallback
  }
  return 'unknown';
}
