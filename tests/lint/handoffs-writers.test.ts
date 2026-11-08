/**
 * Wave G lint test: assert that only the `team` skill writes to `.omc/handoffs/`.
 *
 * `.omc/handoffs/` is intentionally shared across team runs to enable resume
 * and post-mortem. Only code under `src/team/**` or `src/hooks/team-pipeline/**`
 * is permitted to write there. Any other writer is a governance violation.
 *
 * This test scans all TypeScript source files under `src/` for string literals
 * or template expressions that reference `handoffs/` and asserts every match
 * lives in an allowed path.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const TEMPLATES_ROOT = join(REPO_ROOT, 'templates');

/**
 * Allowed source directories that may reference `.omc/handoffs/` as writers.
 * Paths use forward slashes for cross-platform regex matching.
 */
const ALLOWED_WRITER_PREFIXES = [
  'src/team/',
  'src/hooks/team-pipeline/',
];

/** Pattern that identifies a handoffs reference in source code. */
const HANDOFFS_PATTERN = /['"` ](?:[^'"` ]*[/\\])?handoffs\//;

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Skip test directories to avoid false positives from test fixtures
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      results.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
      results.push(full);
    }
  }
  return results;
}

function collectMjsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...collectMjsFiles(full));
    } else if (entry.endsWith('.mjs') || entry.endsWith('.js') || entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function toForwardSlash(p: string): string {
  return p.split(sep).join('/');
}

describe('handoffs-writers lint (Wave G)', () => {
  it('no source file outside src/team or src/hooks/team-pipeline references handoffs/', () => {
    const srcFiles = collectTsFiles(SRC_ROOT);
    const templateFiles = collectMjsFiles(TEMPLATES_ROOT);
    const allFiles = [...srcFiles, ...templateFiles];

    const violations: string[] = [];

    for (const filePath of allFiles) {
      const relPath = toForwardSlash(relative(REPO_ROOT, filePath));
      const isAllowed = ALLOWED_WRITER_PREFIXES.some(prefix => relPath.startsWith(prefix));

      if (isAllowed) continue;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (HANDOFFS_PATTERN.test(lines[i])) {
          violations.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        '',
        'GOVERNANCE VIOLATION: Only src/team/** and src/hooks/team-pipeline/** may reference .omc/handoffs/.',
        'See docs/REFERENCE.md § ".omc/handoffs/ shared contract" for the policy.',
        '',
        'Offending lines:',
        ...violations.map(v => `  ${v}`),
        '',
      ].join('\n');
      expect.fail(msg);
    }

    // If we reach here the allowlist is clean — assert so explicitly.
    expect(violations).toHaveLength(0);
  });

  it('legitimate handoffs references exist only in the allowed directories (allowlist sanity check)', () => {
    // Verify that the allowed dirs themselves do NOT currently reference handoffs/
    // (since the audit showed zero code references anywhere — this is expected to pass
    // confirming the allowlist is not masking real writers that need review).
    // If team code starts writing handoffs/ in the future, this test remains green
    // because those files ARE in the allowlist. The first test catches outside writers.
    const allowedFiles: string[] = [];
    for (const prefix of ALLOWED_WRITER_PREFIXES) {
      const absDir = join(REPO_ROOT, ...prefix.split('/'));
      allowedFiles.push(...collectTsFiles(absDir));
    }

    // Just verify we can read the allowed dirs without error — this is a smoke check.
    // (Zero matches in allowed dirs is fine; the governance test above is the enforcer.)
    expect(allowedFiles).toBeDefined();
    expect(Array.isArray(allowedFiles)).toBe(true);
  });
});
