import { describe, it, expect } from 'vitest';

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
