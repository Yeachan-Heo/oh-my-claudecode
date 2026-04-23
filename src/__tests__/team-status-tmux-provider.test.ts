import { describe, it, expect } from "vitest";
import { resolveWorkerProvider } from "../team/capabilities.js";

// ============================================================================
// BUG 6: team-status provider type handles tmux workers
// ============================================================================
describe('BUG 6: team-status provider type for tmux workers', () => {
  it('delegates provider mapping through the shared capability resolver', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/team/team-status.ts'),
      'utf-8',
    );

    expect(source).toContain('resolveWorkerProvider');
  });

  it('WorkerStatus interface uses the shared WorkerProvider alias', async () => {
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
    expect(interfaceMatch![1].trim()).toBe('WorkerProvider');
    expect(source).toContain('type WorkerProvider');
  });

  it('resolver correctly handles tmux/mcp/copilot worker labels', () => {
    expect(resolveWorkerProvider('mcp-codex')).toBe('codex');
    expect(resolveWorkerProvider('tmux-claude')).toBe('claude');
    expect(resolveWorkerProvider('tmux-copilot')).toBe('copilot');
  });
});
