/**
 * Rules Injector Types
 *
 * Type definitions for rule file parsing and injection.
 * Supports Claude Code format (globs, paths) and GitHub Copilot format (applyTo).
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

/**
 * Rule file metadata from YAML frontmatter.
 * Supports multiple formats for compatibility.
 */
export interface RuleMetadata {
  /** Description of what this rule does */
  description?: string;
  /** Glob patterns for matching files */
  globs?: string | string[];
  /** Whether this rule always applies regardless of file path */
  alwaysApply?: boolean;
}

/**
 * Rule information with path context and content.
 */
export interface RuleInfo {
  /** Absolute path to the rule file */
  path: string;
  /** Path relative to project root */
  relativePath: string;
  /** Directory distance from target file (0 = same dir) */
  distance: number;
  /** Rule file content (without frontmatter) */
  content: string;
  /** SHA-256 hash of content for deduplication */
  contentHash: string;
  /** Parsed frontmatter metadata */
  metadata: RuleMetadata;
  /** Why this rule matched (e.g., "alwaysApply", "glob: *.ts") */
  matchReason: string;
  /** Real path after symlink resolution (for duplicate detection) */
  realPath: string;
}

/**
 * Rule file candidate found during discovery.
 */
export interface RuleFileCandidate {
  /** Path to the rule file */
  path: string;
  /** Real path after symlink resolution */
  realPath: string;
  /** Whether this is a global (user-level) rule */
  isGlobal: boolean;
  /** Directory distance from the target file */
  distance: number;
  /** Single-file rules (e.g., .github/copilot-instructions.md) always apply */
  isSingleFile?: boolean;
}

/**
 * Session storage for tracking injected rules.
 */
export interface InjectedRulesData {
  /** Session ID */
  sessionId: string;
  /** Content hashes of already injected rules */
  injectedHashes: string[];
  /** Real paths of already injected rules (for symlink deduplication) */
  injectedRealPaths: string[];
  /** Timestamp of last update */
  updatedAt: number;
}

/**
 * Rule to be injected into output.
 */
export interface RuleToInject {
  /** Relative path to the rule file */
  relativePath: string;
  /** Why this rule matched */
  matchReason: string;
  /** Rule content to inject */
  content: string;
  /** Directory distance */
  distance: number;
}

/**
 * Result of rule matching check.
 */
export interface MatchResult {
  /** Whether the rule applies */
  applies: boolean;
  /** Reason for match (e.g., "glob: *.ts") */
  reason?: string;
}

/**
 * Frontmatter parsing result.
 */
export interface RuleFrontmatterResult {
  /** Parsed metadata */
  metadata: RuleMetadata;
  /** Content body without frontmatter */
  body: string;
}
