/**
 * Rules Injector Constants
 *
 * Constants for rule file discovery and matching.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { getGlobalOmcStatePath } from '../../utils/paths.js';

/** Get storage directory path for rules injector state */
export function getRulesInjectorStoragePath(): string {
  return getGlobalOmcStatePath('rules-injector');
}

/**
 * @deprecated Use getRulesInjectorStoragePath() instead
 */
export const RULES_INJECTOR_STORAGE = getRulesInjectorStoragePath();

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

/** Valid rule file extensions */
export const RULE_EXTENSIONS = ['.md', '.mdc'];

/** Tools that trigger rule injection */
export const TRACKED_TOOLS = ['read', 'write', 'edit', 'multiedit'];
