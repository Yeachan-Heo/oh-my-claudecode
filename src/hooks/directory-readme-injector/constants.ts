/**
 * Directory README Injector Constants
 *
 * Constants for finding and injecting README files from directories.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */

import { getGlobalOmcStatePath } from '../../utils/paths.js';

/** Get storage directory path for directory-readme-injector state */
export function getReadmeInjectorStoragePath(): string {
  return getGlobalOmcStatePath('directory-readme');
}

/** README filename to search for */
export const README_FILENAME = 'README.md';

/** AGENTS.md filename to search for (deepinit output) */
export const AGENTS_FILENAME = 'AGENTS.md';

/** All context filenames to search for during directory walks */
export const CONTEXT_FILENAMES = [README_FILENAME, AGENTS_FILENAME];

/** Tools that trigger context file injection */
export const TRACKED_TOOLS = ['read', 'write', 'edit', 'multiedit'];
