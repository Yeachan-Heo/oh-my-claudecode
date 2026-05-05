import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE = process.execPath;
const SESSION_START_SCRIPT = join(__dirname, '..', '..', 'scripts', 'wiki-session-start.mjs');
const PRE_COMPACT_SCRIPT = join(__dirname, '..', '..', 'scripts', 'wiki-pre-compact.mjs');

describe('wiki hook wrapper output', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-wiki-hook-format-'));
    mkdirSync(join(tempDir, '.omc', 'wiki'), { recursive: true });

    writeFileSync(
      join(tempDir, '.omc', 'wiki', 'test-page.md'),
      [
        '---',
        'title: "Test Page"',
        'tags: ["test"]',
        'created: 2026-04-13T00:00:00.000Z',
        'updated: 2026-04-13T00:00:00.000Z',
        'sources: ["session-1"]',
        'links: []',
        'category: reference',
        'confidence: high',
        'schemaVersion: 1',
        '---',
        '# Test Page',
        '',
      ].join('\n'),
    );

    writeFileSync(join(tempDir, '.omc', 'wiki', 'index.md'), '# Wiki Index\n- test-page.md\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runHook(scriptPath: string) {
    const raw = execFileSync(NODE, [scriptPath], {
      cwd: join(__dirname, '..', '..'),
      input: JSON.stringify({ cwd: tempDir }),
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();

    return JSON.parse(raw) as {
      continue?: boolean;
      suppressOutput?: boolean;
      additionalContext?: string;
      systemMessage?: string;
      hookSpecificOutput?: {
        hookEventName?: string;
        additionalContext?: string;
      };
    };
  }

  it('wraps SessionStart wiki context under hookSpecificOutput', () => {
    const output = runHook(SESSION_START_SCRIPT);

    expect(output.continue).toBe(true);
    expect(output.additionalContext).toBeUndefined();
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: expect.stringContaining('[LLM Wiki: 1 pages at .omc/wiki/]'),
    });
  });

  it('emits PreCompact wiki context as top-level systemMessage', () => {
    const output = runHook(PRE_COMPACT_SCRIPT);

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(output.systemMessage).toBe(
      '[Wiki: 1 pages | categories: reference | last updated: 2026-04-13T00:00:00.000Z]',
    );
  });
});
