import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * Test coverage for session-start.mjs OMC_PROJECT_MEMORY_FRAME enabled code path.
 * 
 * With OMC_PROJECT_MEMORY_FRAME=1, session-start.mjs uses formatContextSummaryWithFrame
 * instead of formatContextSummary. This new selection path is currently not tested in
 * session-start subprocess tests, only in the direct project-memory-frame.test.ts tests.
 * 
 * This test verifies that:
 * 1. The selection logic exists in session-start.mjs
 * 2. It properly checks for OMC_PROJECT_MEMORY_FRAME environment variable
 * 3. It falls back to the base formatter when the framed variant is not available
 */

describe('session-start.mjs OMC_PROJECT_MEMORY_FRAME support', () => {
  it('should have selection logic for OMC_PROJECT_MEMORY_FRAME', () => {
    const sessionStartPath = join(process.cwd(), 'scripts', 'session-start.mjs');
    const content = readFileSync(sessionStartPath, 'utf8');

    // Verify the code path exists
    expect(content).toContain('OMC_PROJECT_MEMORY_FRAME');
    expect(content).toContain('formatContextSummaryWithFrame');

    // Verify the selection logic is present
    expect(content).toMatch(
      /formatContextSummary:\s*\(\['1',\s*'true'\]\.includes\(String\(process\.env\.OMC_PROJECT_MEMORY_FRAME/
    );
  });

  it('should have fallback to base formatter', () => {
    const sessionStartPath = join(process.cwd(), 'scripts', 'session-start.mjs');
    const content = readFileSync(sessionStartPath, 'utf8');

    // Verify the fallback (??) pattern exists - formatter selection with ?? fallback
    expect(content).toContain('formatContextSummaryWithFrame');
    expect(content).toContain('??');
    expect(content).toContain('projectMemoryFormatter.formatContextSummary');
  });

  it('should use the framed formatter when enabled', () => {
    // This is a code-based assertion that the enable path would use the framed variant
    const sessionStartPath = join(process.cwd(), 'scripts', 'session-start.mjs');
    const content = readFileSync(sessionStartPath, 'utf8');

    // Extract the relevant code section (may have line breaks)
    const selectPattern = /\['1',\s*'true'\]\s*\.includes\s*\(\s*String\s*\(\s*process\s*\.\s*env\s*\.\s*OMC_PROJECT_MEMORY_FRAME[\s\S]*?\?\s*projectMemoryFormatter\s*\.\s*formatContextSummaryWithFrame/;
    expect(content).toMatch(selectPattern);
  });
});
