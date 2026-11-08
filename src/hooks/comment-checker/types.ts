/**
 * Comment Checker Types
 *
 * Type definitions for comment detection in code changes.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 */

/**
 * Type of comment detected
 */
export type CommentType = 'line' | 'block' | 'docstring';

/**
 * Information about a detected comment
 */
export interface CommentInfo {
  /** The comment text content */
  text: string;
  /** Line number where comment appears */
  lineNumber: number;
  /** File path containing the comment */
  filePath: string;
  /** Type of comment */
  commentType: CommentType;
  /** Whether this is a docstring */
  isDocstring: boolean;
  /** Additional metadata */
  metadata?: Record<string, string>;
}

/**
 * Pending tool call for comment checking
 */
export interface PendingCall {
  /** File path being modified */
  filePath: string;
  /** New file content (for Write tool) */
  content?: string;
  /** Old string being replaced (for Edit tool) */
  oldString?: string;
  /** New string replacement (for Edit tool) */
  newString?: string;
  /** Multiple edits (for MultiEdit tool) */
  edits?: Array<{ old_string: string; new_string: string }>;
  /** Tool that triggered this check */
  tool: 'write' | 'edit' | 'multiedit';
  /** Session ID */
  sessionId: string;
  /** Timestamp of the call */
  timestamp: number;
}

/**
 * Comments found in a file
 */
export interface FileComments {
  /** File path */
  filePath: string;
  /** List of comments found */
  comments: CommentInfo[];
}

/**
 * Result of a comment filter
 */
export interface FilterResult {
  /** Whether to skip this comment */
  shouldSkip: boolean;
  /** Reason for skipping */
  reason?: string;
}

/**
 * Function type for comment filters
 */
export type CommentFilter = (comment: CommentInfo) => FilterResult;

/**
 * Result of comment checking
 */
export interface CommentCheckResult {
  /** Whether comments were detected */
  hasComments: boolean;
  /** Number of comments found */
  count: number;
  /** Message to inject if comments found */
  message?: string;
  /** Detailed comment information */
  comments: CommentInfo[];
}
