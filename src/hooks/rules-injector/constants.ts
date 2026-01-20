/**
 * Rules Injector Constants
 *
 * Constants for rule file discovery and matching.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { join } from 'path';
import { homedir } from 'os';

/** Storage directory for rules injector state */
export const OMC_STORAGE_DIR = join(homedir(), '.omc');
export const RULES_INJECTOR_STORAGE = join(OMC_STORAGE_DIR, 'rules-injector');

/** Project marker files that indicate a project root */
export const PROJECT_MARKERS = [
  '.git',
  'pyproject.toml',
  'package.json',
  'Cargo.toml',
  'go.mod',
  '.venv',
];

/** Subdirectories to search for rules within projects */
export const PROJECT_RULE_SUBDIRS: [string, string][] = [
  ['.github', 'instructions'],
  ['.cursor', 'rules'],
  ['.claude', 'rules'],
];

/** Single-file rules that always apply */
export const PROJECT_RULE_FILES: string[] = [
  '.github/copilot-instructions.md',
];

/** Pattern for GitHub instructions files */
export const GITHUB_INSTRUCTIONS_PATTERN = /\.instructions\.md$/;

/** User-level rule directory */
export const USER_RULE_DIR = '.claude/rules';

/** Valid rule file extensions */
export const RULE_EXTENSIONS = ['.md', '.mdc'];

/** Tools that trigger rule injection */
export const TRACKED_TOOLS = ['read', 'write', 'edit', 'multiedit'];
