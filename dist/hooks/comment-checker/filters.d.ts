/**
 * Comment Checker Filters
 *
 * Filters to determine which comments should be flagged vs skipped.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 */
import type { CommentInfo, FilterResult } from './types.js';
/**
 * Filter for shebang comments (#!/usr/bin/env ...)
 */
export declare function filterShebangComments(comment: CommentInfo): FilterResult;
/**
 * Filter for BDD (Behavior-Driven Development) comments
 */
export declare function filterBddComments(comment: CommentInfo): FilterResult;
/**
 * Filter for type checker and linter directive comments
 */
export declare function filterDirectiveComments(comment: CommentInfo): FilterResult;
/**
 * Filter for docstring comments in non-public functions
 * (More lenient - only flags excessive docstrings)
 */
export declare function filterDocstringComments(_comment: CommentInfo): FilterResult;
/**
 * Filter for copyright/license headers
 */
export declare function filterCopyrightComments(comment: CommentInfo): FilterResult;
/**
 * Filter for TODO/FIXME comments (these are acceptable)
 */
export declare function filterTodoComments(comment: CommentInfo): FilterResult;
/**
 * Apply all filters to a list of comments
 * Returns only comments that should be flagged
 */
export declare function applyFilters(comments: CommentInfo[]): CommentInfo[];
//# sourceMappingURL=filters.d.ts.map