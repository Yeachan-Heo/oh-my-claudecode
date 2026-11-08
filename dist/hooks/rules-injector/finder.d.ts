/**
 * Rules Finder
 *
 * Finds rule files in project directories and [$CLAUDE_CONFIG_DIR|~/.claude].
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import type { RuleFileCandidate } from './types.js';
/**
 * Find project root by walking up from startPath.
 * Checks for PROJECT_MARKERS (.git, package.json, etc.)
 */
export declare function findProjectRoot(startPath: string): string | null;
/**
 * Calculate directory distance between a rule file and current file.
 */
export declare function calculateDistance(rulePath: string, currentFile: string, projectRoot: string | null): number;
/**
 * Find all rule files for a given context.
 * Searches from currentFile upward to projectRoot for rule directories,
 * then [$CLAUDE_CONFIG_DIR|~/.claude]/rules.
 */
export declare function findRuleFiles(projectRoot: string | null, currentFile: string): RuleFileCandidate[];
//# sourceMappingURL=finder.d.ts.map