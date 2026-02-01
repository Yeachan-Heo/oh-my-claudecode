import { existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { loadConfig } from '../config.js';

/**
 * Validates a working directory path for security.
 * Prevents path traversal attacks and unauthorized directory access.
 *
 * @param directory - The directory path to validate
 * @returns The resolved absolute path
 * @throws Error if validation fails
 */
export function validateWorkingDirectory(directory: string): string {
  const config = loadConfig();
  const resolved = resolve(directory);

  // Must be absolute (reject relative input for clarity)
  if (!isAbsolute(directory)) {
    throw new Error('Directory must be an absolute path');
  }

  // Must not contain path traversal sequences
  if (directory.includes('..')) {
    throw new Error('Directory must not contain ".."');
  }

  // Must exist and be a directory
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  // If defaultProjectDir is configured, directory must be under it
  if (config.defaultProjectDir) {
    const normalizedDir = resolved.endsWith('/') ? resolved : resolved + '/';
    const normalizedBase = resolve(config.defaultProjectDir);
    const normalizedBaseDir = normalizedBase.endsWith('/') ? normalizedBase : normalizedBase + '/';

    if (!normalizedDir.startsWith(normalizedBaseDir) && resolved !== normalizedBase) {
      throw new Error(`Directory must be under ${config.defaultProjectDir}`);
    }
  }

  return resolved;
}
