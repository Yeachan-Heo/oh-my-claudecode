/**
 * Rules Parser
 *
 * Parses YAML frontmatter from rule files.
 * Supports multiple formats for compatibility.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import type { RuleFrontmatterResult } from './types.js';
/**
 * Parse YAML frontmatter from rule file content.
 * Supports:
 * - Single string: globs: "**\/*.py"
 * - Inline array: globs: ["**\/*.py", "src/**\/*.ts"]
 * - Multi-line array with dashes
 * - Comma-separated: globs: "**\/*.py, src/**\/*.ts"
 * - Claude Code 'paths' field (alias for globs)
 */
export declare function parseRuleFrontmatter(content: string): RuleFrontmatterResult;
//# sourceMappingURL=parser.d.ts.map