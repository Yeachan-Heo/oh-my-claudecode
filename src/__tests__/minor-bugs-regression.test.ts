/**
 * Regression tests for Milestone 5: Minor Fixes
 *
 * Tests for 8 minor bugs:
 * 1. Session summary spawning unbounded
 * 2. Slack fallback injects into wrong session
 * 3. Dispatcher webhook timeout leak
 * 4. Session-start hooks timeout leak
 * 5. featured-contributors regex rejects dots
 * 6. team-status provider type for tmux workers
 * 7. outbox-reader re-delivers partial trailing lines
 * 8. detectPipelineSignal unescaped regex
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// BUG 1: Session summary spawning unbounded
// ============================================================================
describe('BUG 1: session summary spawn guard', () => {
  it('source has spawn timestamp guard preventing duplicate processes', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // Should track the last spawn timestamp
    expect(source).toContain('lastSummarySpawnTimestamp');

    // Should check elapsed time before spawning
    expect(source).toMatch(/now\s*-\s*lastSummarySpawnTimestamp/);

    // Should have a guard window (120s)
    expect(source).toContain('120_000');
  });

  it('source exports _resetSummarySpawnTimestamp for testing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    expect(source).toContain('export function _resetSummarySpawnTimestamp');
  });

  it('guard returns early before spawn when within window', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // The function should return early if within the window
    const fnStart = source.indexOf('function spawnSessionSummaryScript');
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('return;');
    expect(fnBody).toContain('lastSummarySpawnTimestamp = now');
  });
});

// ============================================================================
// BUG 2: Slack fallback does not inject into unrelated sessions
// ============================================================================
describe('BUG 2: Slack fallback removal', () => {
  it('reply-listener does not contain fallback to last mapping for Slack', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/notifications/reply-listener.ts'),
      'utf-8',
    );

    // The old pattern: `mappings[mappings.length - 1].tmuxPaneId`
    expect(source).not.toContain('mappings[mappings.length - 1]');

    // The comment about skipping should be present
    expect(source).toContain(
      'skip injection to avoid sending to an unrelated session',
    );
  });
});

// ============================================================================
// BUG 3: Dispatcher webhook timeout leak
// ============================================================================
describe('BUG 3: sendCustomWebhook clears timeout on error', () => {
  it('source uses finally block to clear timeout', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/notifications/dispatcher.ts'),
      'utf-8',
    );

    // Find the sendCustomWebhook function
    const fnStart = source.indexOf('export async function sendCustomWebhook');
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = source.slice(fnStart, fnStart + 2000);
    // clearTimeout should appear inside a finally block
    expect(fnBody).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
  });
});

// ============================================================================
// BUG 4: Session-start hooks timeout leak
// ============================================================================
describe('BUG 4: session-start hooks clear timeout in finally', () => {
  it('templates/hooks/session-start.mjs uses finally for clearTimeout', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'templates/hooks/session-start.mjs'),
      'utf-8',
    );

    // Find the checkForUpdates function
    const fnStart = source.indexOf('async function checkForUpdates');
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = source.slice(fnStart, fnStart + 1500);
    expect(fnBody).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
  });

  it('scripts/session-start.mjs uses finally for clearTimeout', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'scripts/session-start.mjs'),
      'utf-8',
    );

    // The checkNpmUpdate function should use finally for clearTimeout
    // Look for the npm fetch section
    const fetchSection = source.indexOf('registry.npmjs.org');
    expect(fetchSection).toBeGreaterThan(-1);

    // Find the surrounding try/finally block
    const surroundingCode = source.slice(
      Math.max(0, fetchSection - 300),
      fetchSection + 800,
    );
    expect(surroundingCode).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
  });
});

// ============================================================================
// BUG 5: featured-contributors regex accepts dots in repo names
// ============================================================================
describe('BUG 5: extractRepoSlug accepts dots', () => {
  it('parses repo with dots: next.js', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/vercel/next.js')).toBe(
      'vercel/next.js',
    );
  });

  it('parses repo with dots: socket.io.git', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/socketio/socket.io.git')).toBe(
      'socketio/socket.io',
    );
  });

  it('parses repo with dots: vue.js.git', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/vuejs/vue.js.git')).toBe(
      'vuejs/vue.js',
    );
  });

  it('still parses standard repos without dots', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/facebook/react')).toBe(
      'facebook/react',
    );
  });

  it('still parses SSH URLs', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('git@github.com:vuejs/vue.js.git')).toBe(
      'vuejs/vue.js',
    );
  });
});

// ============================================================================
// BUG 6: team-status provider type handles tmux workers
// ============================================================================
describe('BUG 6: team-status provider type for tmux workers', () => {
  it('source strips both mcp- and tmux- prefixes', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/team/team-status.ts'),
      'utf-8',
    );

    // Should use a regex that strips both prefixes
    expect(source).toMatch(/replace\(.*mcp.*tmux/s);
    // Should include 'claude' in the provider union type
    expect(source).toContain("'claude'");
  });

  it('WorkerStatus interface includes claude in provider union', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/team/team-status.ts'),
      'utf-8',
    );

    // The interface should have claude in the union
    const interfaceMatch = source.match(
      /interface WorkerStatus[\s\S]*?provider:\s*([^;]+);/,
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch![1]).toContain("'claude'");
    expect(interfaceMatch![1]).toContain("'codex'");
    expect(interfaceMatch![1]).toContain("'gemini'");
  });

  it('regex correctly strips mcp- prefix', () => {
    const regex = /^(?:mcp|tmux)-/;
    expect('mcp-codex'.replace(regex, '')).toBe('codex');
  });

  it('regex correctly strips tmux- prefix', () => {
    const regex = /^(?:mcp|tmux)-/;
    expect('tmux-claude'.replace(regex, '')).toBe('claude');
  });

  it('regex correctly strips tmux-codex to codex', () => {
    const regex = /^(?:mcp|tmux)-/;
    expect('tmux-codex'.replace(regex, '')).toBe('codex');
  });
});

// ============================================================================
// BUG 7: outbox-reader only parses complete lines
// ============================================================================
describe('BUG 7: outbox-reader partial line handling', () => {
  it('source only parses lines from completePortion', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/team/outbox-reader.ts'),
      'utf-8',
    );

    // The fix introduces a `completePortion` variable
    expect(source).toContain('completePortion');

    // Lines should be split from completePortion, not from chunk directly
    expect(source).toMatch(/completePortion\.split/);
  });

  it('does not parse partial trailing line when chunk lacks trailing newline', () => {
    // Simulate the logic from the fix
    const chunk = '{"msg":"line1"}\n{"msg":"line2"}\n{"msg":"partial';
    let completePortion = chunk;
    if (!chunk.endsWith('\n')) {
      const lastNewline = chunk.lastIndexOf('\n');
      completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
    }

    const lines = completePortion.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"msg":"line1"}');
    expect(lines[1]).toBe('{"msg":"line2"}');
  });

  it('parses all lines when chunk ends with newline', () => {
    const chunk = '{"msg":"line1"}\n{"msg":"line2"}\n';
    let completePortion = chunk;
    if (!chunk.endsWith('\n')) {
      const lastNewline = chunk.lastIndexOf('\n');
      completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
    }

    const lines = completePortion.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(2);
  });

  it('returns empty when chunk is a single partial line with no newline', () => {
    const chunk = '{"msg":"partial';
    let completePortion = chunk;
    if (!chunk.endsWith('\n')) {
      const lastNewline = chunk.lastIndexOf('\n');
      completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
    }

    const lines = completePortion.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(0);
  });
});

// ============================================================================
// BUG 8: detectPipelineSignal escapes regex metacharacters
// ============================================================================
describe('BUG 8: detectPipelineSignal escapes regex', () => {
  it('source escapes regex metacharacters before creating RegExp', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hooks/autopilot/enforcement.ts'),
      'utf-8',
    );

    // Find the detectPipelineSignal function
    const fnStart = source.indexOf('function detectPipelineSignal');
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = source.slice(fnStart, fnStart + 500);

    // Should escape special regex chars before passing to RegExp
    expect(fnBody).toContain('.replace(');
    expect(fnBody).toContain('\\$&');
  });

  it('escaped regex does not match unintended text', () => {
    const signal = 'stage.complete(1)';
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');

    // Should match the exact signal
    expect(pattern.test('The stage.complete(1) was reached')).toBe(true);

    // Should NOT match variations that would match an unescaped regex
    expect(pattern.test('stagexcomplete11')).toBe(false);
  });

  it('handles signals with multiple regex metacharacters', () => {
    const signal = '[DONE] pipeline.finished()';
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');

    expect(pattern.test('The [DONE] pipeline.finished() was emitted')).toBe(true);
    expect(pattern.test('DONE_ pipelinexfinished__')).toBe(false);
  });
});
