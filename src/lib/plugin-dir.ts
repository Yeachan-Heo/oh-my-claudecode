/**
 * Shared helper for resolving a --plugin-dir argument to an absolute path.
 *
 * Used by both `src/cli/launch.ts` (non-consuming parse of the raw argv array)
 * and `src/cli/index.ts` (Commander option value passed as a string).
 */

import { posix, resolve, win32 } from 'path';

/**
 * Resolve a raw `--plugin-dir` value (relative or absolute string) to an
 * absolute path.  Throws with a clear message if the value is empty.
 */
function isCrossPlatformAbsolutePath(rawPath: string): boolean {
  return posix.isAbsolute(rawPath) || win32.isAbsolute(rawPath);
}

export function resolvePluginDirArg(rawPath: string): string {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error('--plugin-dir requires a non-empty path argument');
  }
  return isCrossPlatformAbsolutePath(rawPath) ? rawPath : resolve(rawPath);
}
