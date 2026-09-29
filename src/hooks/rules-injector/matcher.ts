/**
 * Rules Matcher
 *
 * Matches rules against file paths using glob patterns.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { createHash } from 'crypto';
import { relative } from 'path';
import type { RuleMetadata, MatchResult } from './types.js';

/**
 * Simple glob pattern matcher.
 * Supports basic patterns like *.ts, **\/*.js, src/**\/*.py
 *
 * `*` stays within one path segment, `**\/` matches zero or more directories
 * (so `**\/*.py` also matches `main.py`), and a bare `**` matches anything.
 * Other regex metacharacters are literal path characters, except `[...]`,
 * which stays a character class as in other glob dialects, and `\X`, which
 * is a literal X.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  let regexStr = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          regexStr += '(?:.*/)?';  // **/ matches zero or more directories
        } else {
          regexStr += '.*';        // ** matches anything including /
        }
      } else {
        regexStr += '[^/]*';       // * matches any characters except /
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      i++;                         // \X is a literal X
      regexStr += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '?') {
      regexStr += '.';             // ? matches single character
    } else {
      regexStr += ch.replace(/[.+$(){}|]/g, '\\$&');
    }
  }

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Check if a rule should apply to the current file based on metadata.
 */
export function shouldApplyRule(
  metadata: RuleMetadata,
  currentFilePath: string,
  projectRoot: string | null
): MatchResult {
  if (metadata.alwaysApply === true) {
    return { applies: true, reason: 'alwaysApply' };
  }

  const globs = metadata.globs;
  if (!globs) {
    return { applies: false };
  }

  const patterns = Array.isArray(globs) ? globs : [globs];
  if (patterns.length === 0) {
    return { applies: false };
  }

  const relativePath = projectRoot
    ? relative(projectRoot, currentFilePath)
    : currentFilePath;

  // Normalize path separators to forward slashes for matching
  const normalizedPath = relativePath.replace(/\\/g, '/');

  for (const pattern of patterns) {
    if (matchGlob(pattern, normalizedPath)) {
      return { applies: true, reason: `glob: ${pattern}` };
    }
  }

  return { applies: false };
}

/**
 * Check if realPath already exists in cache (symlink deduplication).
 */
export function isDuplicateByRealPath(realPath: string, cache: Set<string>): boolean {
  return cache.has(realPath);
}

/**
 * Create SHA-256 hash of content, truncated to 16 chars.
 */
export function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Check if content hash already exists in cache.
 */
export function isDuplicateByContentHash(hash: string, cache: Set<string>): boolean {
  return cache.has(hash);
}
