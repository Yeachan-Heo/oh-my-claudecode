/**
 * Learned Skills Types
 *
 * Type definitions for skill files and metadata.
 * Follows patterns from rules-injector/types.ts
 */

/**
 * Skill metadata from YAML frontmatter.
 */
export interface SkillMetadata {
  /** Unique identifier for the skill */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this skill does */
  description: string;
  /** Keywords that trigger skill injection */
  triggers: string[];
  /** When the skill was created */
  createdAt: string;
  /** Source: 'extracted' | 'promoted' | 'manual' */
  source: 'extracted' | 'promoted' | 'manual';
  /** Original session ID if extracted */
  sessionId?: string;
  /** Quality score (0-100) */
  quality?: number;
  /** Number of times successfully applied */
  usageCount?: number;
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Parsed skill file with content.
 */
export interface LearnedSkill {
  /** Absolute path to skill file */
  path: string;
  /** Path relative to skills directory */
  relativePath: string;
  /** Whether from user (~/.claude) or project (.omc) */
  scope: 'user' | 'project';
  /** Parsed frontmatter metadata */
  metadata: SkillMetadata;
  /** Skill content (the actual instructions) */
  content: string;
  /** SHA-256 hash for deduplication */
  contentHash: string;
  /** Priority: project > user */
  priority: number;
}

/**
 * Skill file candidate during discovery.
 */
export interface SkillFileCandidate {
  /** Path to the skill file */
  path: string;
  /** Real path after symlink resolution */
  realPath: string;
  /** Scope: user or project */
  scope: 'user' | 'project';
}

/**
 * Quality gate validation result.
 */
export interface QualityValidation {
  /** Whether skill passes quality gates */
  valid: boolean;
  /** Missing required fields */
  missingFields: string[];
  /** Warnings (non-blocking) */
  warnings: string[];
  /** Quality score (0-100) */
  score: number;
}

/**
 * Skill extraction request.
 */
export interface SkillExtractionRequest {
  /** The problem being solved */
  problem: string;
  /** The solution/approach */
  solution: string;
  /** Trigger keywords */
  triggers: string[];
  /** Optional tags */
  tags?: string[];
  /** Target scope: user or project */
  targetScope: 'user' | 'project';
}

/**
 * Session storage for tracking injected skills.
 */
export interface InjectedSkillsData {
  /** Session ID */
  sessionId: string;
  /** Content hashes of already injected skills */
  injectedHashes: string[];
  /** Timestamp of last update */
  updatedAt: number;
}

/**
 * Hook context passed to skill processing.
 */
export interface HookContext {
  sessionId: string;
  directory: string;
  prompt?: string;
}
