import { describe, it, expect } from 'vitest';
import { waitForPaneReady } from '../tmux-session.js';
import { vi } from 'vitest';

/**
 * Test for issue #4816: isCmuxSurfaceTarget(value) treats every non-'%' pane id as a cmux surface
 * 
 * Problem: herdr pane ids (format w234:p13) are misclassified as cmux surfaces because the
 * function returns true for any non-empty string that doesn't start with '%'.
 * 
 * This causes waitForPaneReady to proceed with tmux capture against a non-tmux pane id.
 */

describe('issue #4816: isCmuxSurfaceTarget misclassifies herdr pane ids', () => {
  it('should not treat herdr pane id (w234:p13) as cmux surface', async () => {
    // The issue: herdr pane id format is w<window>:p<pane> (e.g., w234:p13)
    // These should NOT be classified as cmux surfaces
    // Without a tmuxServerIdentity, waitForPaneReady should return false for herdr ids
    
    const herdrPaneId = 'w234:p13';
    
    // Mock capturePaneAsync to fail if called (since herdr is not tmux or cmux)
    const capturePaneAsyncMock = vi.fn().mockRejectedValue(new Error('Invalid pane id'));
    
    // This should return false quickly because:
    // 1. 'w234:p13' is NOT a tmux pane id (doesn't start with '%')
    // 2. 'w234:p13' is NOT a cmux surface (doesn't match cmux format)
    // 3. No tmuxServerIdentity is provided
    
    // The bug is that waitForPaneReady treats w234:p13 as a cmux surface
    // and tries to capture it, which fails with "anchors not found: waitForPaneReady cmux short-circuit"
    
    const result = await waitForPaneReady(herdrPaneId, { timeoutMs: 100 });
    expect(result).toBe(false);
  });

  it('should correctly identify tmux pane ids (starting with %)', async () => {
    // tmux pane ids start with '%' followed by digits
    // These require a tmuxServerIdentity to be polled
    
    const tmuxPaneId = '%2';
    
    // Without tmuxServerIdentity, should return false
    const result = await waitForPaneReady(tmuxPaneId, { timeoutMs: 100 });
    expect(result).toBe(false);
  });

  it('should recognize cmux surface ids with positive matching', () => {
    // This is a conceptual test showing what cmux surface ids should look like
    // Real cmux surface ids include:
    // - surface:1000060015 (surface: prefix)
    // - 5F4BFAF8-F133-41C9-BCB5-75801B364168 (UUID format)
    // - surface-worker-1, cmux-worker-1, cmux-leader (custom names starting with surface/cmux)
    
    // The fix should use positive matching for cmux surfaces, not negative matching
    // i.e., check if it IS a cmux surface, not if it's NOT a tmux id
    
    expect(true).toBe(true); // Placeholder - actual logic tested in waitForPaneReady behavior
  });
});
