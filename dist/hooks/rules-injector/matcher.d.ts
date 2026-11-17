/**
 * Rules Matcher
 *
 * Matches rules against file paths using glob patterns.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import type { RuleMetadata, MatchResult } from './types.js';
/**
 * Check if a rule should apply to the current file based on metadata.
 */
export declare function shouldApplyRule(metadata: RuleMetadata, currentFilePath: string, projectRoot: string | null): MatchResult;
/**
 * Check if realPath already exists in cache (symlink deduplication).
 */
export declare function isDuplicateByRealPath(realPath: string, cache: Set<string>): boolean;
/**
 * Create SHA-256 hash of content, truncated to 16 chars.
 */
export declare function createContentHash(content: string): string;
/**
 * Check if content hash already exists in cache.
 */
export declare function isDuplicateByContentHash(hash: string, cache: Set<string>): boolean;
//# sourceMappingURL=matcher.d.ts.map