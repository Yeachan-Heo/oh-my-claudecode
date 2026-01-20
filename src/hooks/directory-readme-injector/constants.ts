/**
 * Directory README Injector Constants
 *
 * Constants for finding and injecting README files from directories.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

/** Storage directory for directory-readme-injector state */
export const OMC_STORAGE_DIR = join(homedir(), '.omc');
export const README_INJECTOR_STORAGE = join(
  OMC_STORAGE_DIR,
  'directory-readme',
);

/** README filename to search for */
export const README_FILENAME = 'README.md';

/** Tools that trigger README injection */
export const TRACKED_TOOLS = ['read', 'write', 'edit', 'multiedit'];
