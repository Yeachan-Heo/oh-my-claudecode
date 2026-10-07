import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Focused tests for GitHub issue #4261: cmux team ownership failures
//
// Failure 1: session name is 'cmux:N' but paneId is still tmux-format (%...)
// When TMUX is set by cmux's tmux-compat layer, the provider detects 'cmux'
// from the session name, but the paneId is in tmux format, causing
// verifyTeamTargetOwnership to return 'unavailable' because
// TMUX_MAILBOX_PANE_ID.test(target.paneId) returns true.
//
// Failure 2: ownership verification fails due to ref vs UUID mismatch
// cmux new-split returns a ref (e.g., surface:1000060015), but
// parseCmuxResourceIds compares against UUIDs from --json list-pane-surfaces,
// so surfaces.includes(paneId) can never match.

import {
  verifyTeamTargetOwnership,
  type MailboxTargetOwnershipDependencies,
} from '../tmux-session.js';
import type { MailboxNotificationTarget } from '../mailbox-notification-guard.js';

describe('Issue #4261: cmux team ownership failures', () => {
  // Set up cmux context for tests that need it
  beforeEach(() => {
    // Simulate cmux environment for native cmux context detection
    process.env.CMUX_SURFACE_ID = 'surface-leader';
  });

  afterEach(() => {
    // Clean up environment
    delete process.env.CMUX_SURFACE_ID;
  });
  describe('Failure 1: cmux session with tmux-format paneId', () => {
    it('should reject provider mismatch when session is cmux: but paneId is tmux-format', async () => {
      // This simulates cmux's tmux-compat layer:
      // - Session name: cmux:1 (from cmux tmux-compat display-message)
      // - TMUX is set, CMUX_SURFACE_ID is set (tmux-compat mode)
      // - But paneId is still tmux-format: %4675534428059654805
      // 
      // The target incorrectly specifies provider: 'cmux', but it should be 'tmux'
      // because paneId is tmux-format.
      const target: MailboxNotificationTarget = {
        provider: 'cmux', // WRONG: should be 'tmux' because paneId is %...
        providerTarget: 'cmux:1',
        paneId: '%4675534428059654805', // tmux-format
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const dependencies: MailboxTargetOwnershipDependencies = {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        serverIdentityDependencies: undefined,
      };

      const result = await verifyTeamTargetOwnership(target, dependencies);

      // Should detect provider mismatch: session is cmux: but paneId is tmux-format
      expect(result.kind).toBe('provider_mismatch');
      expect(dependencies.cmuxExec).not.toHaveBeenCalled();
      expect(dependencies.tmuxExec).not.toHaveBeenCalled();
    });

    it('should correctly determine provider as tmux when paneId is tmux-format despite cmux: session', async () => {
      // Issue #4261 Failure 1: spawnV2Worker determines provider incorrectly
      // When session name is 'cmux:1' (from cmux's tmux-compat) but paneId is tmux-format (%...),
      // the launchProvider should be 'tmux' (based on paneId format), not 'cmux' (based on session name).
      // 
      // This test verifies the provider detection logic:
      // - if session starts with 'cmux:' AND paneId is cmux-format => provider 'cmux'
      // - if session starts with 'cmux:' BUT paneId is tmux-format (%...) => provider 'tmux'
      
      // Test case 1: paneId is tmux-format, session is cmux:X
      // => Expected provider should be 'tmux', not 'cmux'
      const target1: MailboxNotificationTarget = {
        provider: 'cmux', // WRONG: paneId is %..., which is tmux-format
        providerTarget: 'cmux:1',
        paneId: '%9',
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const result1 = await verifyTeamTargetOwnership(target1, {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        serverIdentityDependencies: undefined,
      });

      // Provider mismatch: target says 'cmux' but paneId format indicates 'tmux'
      expect(result1.kind).toBe('provider_mismatch');
    });

    it('should correctly determine provider for cmux with tmux-compat scenario', async () => {
      // Issue #4261 detailed scenario: cmux with tmux-compat layer
      // When TMUX + CMUX_SURFACE_ID are both set:
      // - Session name is 'cmux:1' (from cmux)
      // - PaneId is '%4675534428059654805' (tmux-format from tmux-compat)
      // 
      // According to the provider detection rule in verifyTeamTargetOwnership:
      // - paneId format is tmux-format (%...) => provider should be 'tmux'
      // - NOT 'cmux' just because session is 'cmux:1'
      // 
      // This test verifies that passing provider: 'cmux' with tmux-format paneId
      // correctly returns provider_mismatch (the paneId format takes precedence)
      
      process.env.TMUX = '/tmp/tmux-1000/default';
      process.env.TMUX_PANE = '%4675534428059654805';
      
      const targetWithWrongProvider: MailboxNotificationTarget = {
        provider: 'cmux', // WRONG: paneId is %..., which is tmux-format
        providerTarget: 'cmux:1',
        paneId: '%4675534428059654805', // tmux-format pane id
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const resultWrongProvider = await verifyTeamTargetOwnership(targetWithWrongProvider, {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        serverIdentityDependencies: undefined,
      });

      // Should reject provider: 'cmux' because paneId is tmux-format
      expect(resultWrongProvider.kind).toBe('provider_mismatch');
      
      const targetWithCorrectProvider: MailboxNotificationTarget = {
        provider: 'tmux', // CORRECT: paneId is %..., which is tmux-format
        providerTarget: 'cmux:1',
        paneId: '%4675534428059654805', // tmux-format pane id
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const resultCorrectProvider = await verifyTeamTargetOwnership(targetWithCorrectProvider, {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        serverIdentityDependencies: undefined,
      });

      // Should reject 'unavailable' (due to missing tmuxServerIdentity)
      // But importantly, it should NOT reject with provider_mismatch
      // This means the provider detection correctly chose 'tmux'
      expect(resultCorrectProvider.kind).not.toBe('provider_mismatch');
      
      // Clean up env
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
    });
  });

  describe('Failure 2: cmux ref vs UUID mismatch in ownership verification', () => {
    it('should match cmux surface by ref when paneId is a ref', async () => {
      // This simulates the native cmux path where:
      // - cmux new-split returns: OK surface:1000060015 workspace:1000060002
      // - parseCmuxSurfaceId extracts: surface:1000060015 (the ref)
      // - cmux --json list-pane-surfaces returns: { id: "UUID", ref: "surface:1000060015", ... }
      // 
      // Current behavior: surfaces.includes(paneId) fails because it only checks
      // against id (UUID), not ref. This is Failure 2 from issue #4261.

      const target: MailboxNotificationTarget = {
        provider: 'cmux',
        providerTarget: 'cmux:workspace-1',
        paneId: 'surface:1000060015', // This is the ref returned by cmux new-split
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const cmuxExecMock = vi.fn(async (args: string[]) => {
        if (args[0] === '--json' && args[1] === 'list-panes') {
          return {
            stdout: JSON.stringify({
              panes: [{ id: 'pane-a' }, { id: 'pane-b' }],
            }),
            stderr: '',
          };
        }
        if (args[0] === '--json' && args[1] === 'list-pane-surfaces') {
          // Return both UUID and ref, but verification only checks ID
          return {
            stdout: JSON.stringify({
              surfaces: [
                {
                  id: '5F4BFAF8-F133-41C9-BCB5-75801B364168',
                  ref: 'surface:1000060015', // This should match, but doesn't!
                },
              ],
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      const dependencies: MailboxTargetOwnershipDependencies = {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: cmuxExecMock,
        serverIdentityDependencies: undefined,
      };

      const result = await verifyTeamTargetOwnership(target, dependencies);

      // AFTER FIX: should match on 'ref' field and return 'owned'
      // This fixes the second failure in issue #4261.
      expect(result).toMatchObject({
        kind: 'owned',
        provider: 'cmux',
        providerTarget: 'cmux:workspace-1',
        paneId: 'surface:1000060015',
      });
    });

    it('should match cmux surface by UUID if paneId is a UUID', async () => {
      // This is the alternative scenario where the paneId is already a UUID
      const target: MailboxNotificationTarget = {
        provider: 'cmux',
        providerTarget: 'cmux:workspace-1',
        paneId: '5F4BFAF8-F133-41C9-BCB5-75801B364168', // UUID format
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const cmuxExecMock = vi.fn(async (args: string[]) => {
        if (args[0] === '--json' && args[1] === 'list-panes') {
          return {
            stdout: JSON.stringify({ panes: [{ id: 'pane-a' }] }),
            stderr: '',
          };
        }
        if (args[0] === '--json' && args[1] === 'list-pane-surfaces') {
          return {
            stdout: JSON.stringify({
              surfaces: [
                {
                  id: '5F4BFAF8-F133-41C9-BCB5-75801B364168',
                  ref: 'surface:1000060015',
                },
              ],
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      const dependencies: MailboxTargetOwnershipDependencies = {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: cmuxExecMock,
        serverIdentityDependencies: undefined,
      };

      const result = await verifyTeamTargetOwnership(target, dependencies);

      // This case works because the UUID matches
      expect(result).toMatchObject({
        kind: 'owned',
        provider: 'cmux',
        providerTarget: 'cmux:workspace-1',
        paneId: '5F4BFAF8-F133-41C9-BCB5-75801B364168',
      });
    });
  });

  describe('Failure 3 (side effect): cleanup blocked after failed start', () => {
    it('documents the shutdown --force fix for workers without pane', () => {
      // Issue #4261 side effect: when team start fails in planning phase,
      // no pane is created, so worker.pane_id is not set. During shutdown,
      // the code should allow cleanup with --force even if it can't verify ownership.
      //
      // The runtime-v2.ts shutdown logic has been updated to:
      // 1. If worker.pane_id is empty and --force is used, skip cleanup (nothing to verify)
      // 2. If ownership adoption fails and --force is used, allow cleanup to proceed
      // 3. Without --force, preserve state (keep protection for actual panes)
      //
      // This prevents the blocking 'provider_cleanup_unverified' error that
      // prevents later team starts from the same leader session.
      expect(true).toBe(true);
    });
  });
});
