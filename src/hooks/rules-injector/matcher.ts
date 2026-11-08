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
 * `{a,b}` is brace alternation (see expandBraces). Other regex
 * metacharacters are literal path characters, except `[...]`, which stays a
 * character class as in other glob dialects, and `\X`, which is a literal X.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  const expanded = expandBraces(pattern);
  return expanded !== null && expanded.some((candidate) => matchExpandedGlob(candidate, filePath));
}

/** Upper bound on alternatives one glob may expand to (guards `{a,b}{c,d}...`). */
const MAX_BRACE_EXPANSIONS = 256;
/** Bounds nested and recursive group processing for pathological brace patterns. */
const MAX_BRACE_DEPTH = 256;

/**
 * Expand `{a,b}` alternation into one pattern per alternative, e.g.
 * `src/**\/*.{ts,tsx}` -> [`src/**\/*.ts`, `src/**\/*.tsx`]. Braces nest, `\{`
 * stays literal, and a brace group without a comma (or without a closing
 * brace) is left as literal text so paths like `app/{id}/page.tsx` still match.
 * Expansion keeps at most 256 alternatives and rejects patterns deeper than
 * 256 groups to bound memory, stack use, and work.
 */
function expandBraces(pattern: string, from = 0, expansionDepth = 0): string[] | null {
  for (let i = from; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] !== '{') continue;

    const parts: string[] = [];
    let depth = 0;
    let start = i + 1;
    let end = -1;
    for (let j = i + 1; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === '\\') {
        j++;
      } else if (c === '{') {
        depth++;
        if (depth > MAX_BRACE_DEPTH) return null;
      } else if (c === '}') {
        if (depth === 0) {
          end = j;
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) {
        if (parts.length < MAX_BRACE_EXPANSIONS) {
          parts.push(pattern.slice(start, j));
        }
        start = j + 1;
      }
    }
    if (end === -1 || parts.length === 0) continue;
    if (expansionDepth >= MAX_BRACE_DEPTH) return null;

    if (parts.length < MAX_BRACE_EXPANSIONS) {
      parts.push(pattern.slice(start, end));
    }
    const prefix = pattern.slice(0, i);
    const suffix = pattern.slice(end + 1);
    const expanded: string[] = [];
    for (const part of parts) {
      const alternatives = expandBraces(prefix + part + suffix, i, expansionDepth + 1);
      if (alternatives === null) return null;
      for (const alternative of alternatives) {
        expanded.push(alternative);
        if (expanded.length >= MAX_BRACE_EXPANSIONS) return expanded;
      }
    }
    return expanded;
  }
  return [pattern];
}

function matchExpandedGlob(pattern: string, filePath: string): boolean {
  let regexStr = '';
  let inCharacterClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (!inCharacterClass && ch === '*') {
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
    } else if (!inCharacterClass && ch === '[') {
      inCharacterClass = true;
      regexStr += ch;
    } else if (inCharacterClass && ch === ']') {
      inCharacterClass = false;
      regexStr += ch;
    } else if (!inCharacterClass && ch === '?') {
      regexStr += '.';             // ? matches single character
    } else if (!inCharacterClass && ch === '^') {
      regexStr += '\\^';          // ^ is literal outside a character class
    } else {
      regexStr += ch.replace(/[.+$(){}|]/g, '\\$&');
    }
  }

  try {
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filePath);
  } catch {
    return false;
  }
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
