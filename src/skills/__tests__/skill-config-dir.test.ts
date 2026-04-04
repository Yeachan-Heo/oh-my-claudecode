/**
 * Regression test: skill markdown files must use CLAUDE_CONFIG_DIR
 *
 * Ensures that bash code blocks in skill files never hardcode $HOME/.claude
 * without a ${CLAUDE_CONFIG_DIR:-...} fallback. This prevents skills from
 * ignoring the user's custom config directory.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Extract content from fenced bash code blocks in a markdown file.
 * Returns an array of { startLine, content } for each ```bash ... ``` block.
 */
function extractBashBlocks(filePath: string): { startLine: number; content: string }[] {
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const blocks: { startLine: number; content: string }[] = [];

  let inBlock = false;
  let blockStart = 0;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^```bash\b/.test(line.trim())) {
      inBlock = true;
      blockStart = i + 2; // 1-indexed, next line
      blockLines = [];
    } else if (inBlock && line.trim() === '```') {
      inBlock = false;
      blocks.push({ startLine: blockStart, content: blockLines.join('\n') });
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  return blocks;
}

/**
 * Find lines in bash blocks that use $HOME/.claude without the
 * ${CLAUDE_CONFIG_DIR:-$HOME/.claude} pattern.
 */
function findHardcodedHomeClaude(filePath: string): { line: number; text: string }[] {
  const blocks = extractBashBlocks(filePath);
  const violations: { line: number; text: string }[] = [];

  for (const block of blocks) {
    const lines = block.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match $HOME/.claude that is NOT inside ${CLAUDE_CONFIG_DIR:-$HOME/.claude}
      if (/\$HOME\/\.claude/.test(line) && !/\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/.test(line)) {
        violations.push({
          line: block.startLine + i,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

const SKILLS_ROOT = join(__dirname, '..', '..', '..', 'skills');

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const ALL_FILES = findMarkdownFiles(SKILLS_ROOT);

describe('skill markdown bash blocks must respect CLAUDE_CONFIG_DIR', () => {
  it.each(ALL_FILES.map((f) => [f.replace(/.*skills\//, 'skills/'), f]))(
    '%s has no hardcoded $HOME/.claude in bash blocks',
    (_label, filePath) => {
      const violations = findHardcodedHomeClaude(filePath);
      if (violations.length > 0) {
        const details = violations
          .map((v) => `  line ${v.line}: ${v.text}`)
          .join('\n');
        expect.fail(
          `Found $HOME/.claude without CLAUDE_CONFIG_DIR fallback:\n${details}\n` +
          `Replace with: \${CLAUDE_CONFIG_DIR:-$HOME/.claude}`
        );
      }
    },
  );
});
