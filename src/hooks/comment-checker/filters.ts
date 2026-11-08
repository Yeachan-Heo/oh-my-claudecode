/**
 * Comment Checker Filters
 *
 * Filters to determine which comments should be flagged vs skipped.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 */

import { BDD_KEYWORDS, TYPE_CHECKER_PREFIXES } from './constants.js';
import type { CommentInfo, FilterResult, CommentFilter } from './types.js';

/**
 * Filter for shebang comments (#!/usr/bin/env ...)
 */
export function filterShebangComments(comment: CommentInfo): FilterResult {
  const text = comment.text.trim();
  if (text.startsWith('#!') && comment.lineNumber === 1) {
    return { shouldSkip: true, reason: 'shebang' };
  }
  return { shouldSkip: false };
}

/**
 * Filter for BDD (Behavior-Driven Development) comments
 */
export function filterBddComments(comment: CommentInfo): FilterResult {
  // Don't filter docstrings
  if (comment.isDocstring) {
    return { shouldSkip: false };
  }

  const text = comment.text.toLowerCase().trim();

  // Check for BDD keywords
  for (const keyword of BDD_KEYWORDS) {
    if (text.startsWith(`#${keyword}`) || text.startsWith(`// ${keyword}`)) {
      return { shouldSkip: true, reason: `BDD keyword: ${keyword}` };
    }
    if (text.includes(keyword)) {
      // More lenient check for keywords anywhere in comment
      const words = text.split(/\s+/);
      if (words.some(w => BDD_KEYWORDS.has(w.replace(/[^a-z&]/g, '')))) {
        return { shouldSkip: true, reason: `BDD keyword detected` };
      }
    }
  }

  return { shouldSkip: false };
}

/**
 * Filter for type checker and linter directive comments
 */
export function filterDirectiveComments(comment: CommentInfo): FilterResult {
  const text = comment.text.toLowerCase().trim();

  for (const prefix of TYPE_CHECKER_PREFIXES) {
    if (text.includes(prefix.toLowerCase())) {
      return { shouldSkip: true, reason: `directive: ${prefix}` };
    }
  }

  return { shouldSkip: false };
}

/**
 * Filter for docstring comments in non-public functions
 * (More lenient - only flags excessive docstrings)
 */
export function filterDocstringComments(_comment: CommentInfo): FilterResult {
  // We don't skip docstrings by default - they should be reviewed
  // This filter is here for extensibility
  return { shouldSkip: false };
}

/**
 * Filter for copyright/license headers
 */
export function filterCopyrightComments(comment: CommentInfo): FilterResult {
  const text = comment.text.toLowerCase();
  const copyrightPatterns = [
    'copyright',
    'license',
    'licensed under',
    'spdx-license-identifier',
    'all rights reserved',
    'mit license',
    'apache license',
    'gnu general public',
    'bsd license',
  ];

  for (const pattern of copyrightPatterns) {
    if (text.includes(pattern)) {
      return { shouldSkip: true, reason: 'copyright/license' };
    }
  }

  return { shouldSkip: false };
}

/**
 * Filter for TODO/FIXME comments (these are acceptable)
 */
export function filterTodoComments(comment: CommentInfo): FilterResult {
  const text = comment.text.toUpperCase();
  const todoPatterns = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'REVIEW'];

  for (const pattern of todoPatterns) {
    if (text.includes(pattern)) {
      return { shouldSkip: true, reason: `todo marker: ${pattern}` };
    }
  }

  return { shouldSkip: false };
}

/**
 * All filters in order of application
 */
const ALL_FILTERS: CommentFilter[] = [
  filterShebangComments,
  filterBddComments,
  filterDirectiveComments,
  filterCopyrightComments,
  filterTodoComments,
  filterDocstringComments,
];

/**
 * Apply all filters to a list of comments
 * Returns only comments that should be flagged
 */
export function applyFilters(comments: CommentInfo[]): CommentInfo[] {
  return comments.filter((comment) => {
    for (const filter of ALL_FILTERS) {
      const result = filter(comment);
      if (result.shouldSkip) {
        return false;
      }
    }
    return true;
  });
}
