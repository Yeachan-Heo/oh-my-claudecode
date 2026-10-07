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
    it('should reject cmux target with tmux-format paneId (unavailable)', async () => {
      // This simulates when TMUX is set by cmux's tmux-compat layer
      // Session: cmux:1, but TMUX_PANE is still %4675534428059654805
      // Current behavior: returns 'unavailable' because TMUX_MAILBOX_PANE_ID.test returns true
      // for cmux provider, which is rejected as invalid
      const target: MailboxNotificationTarget = {
        provider: 'cmux',
        providerTarget: 'cmux:1',
        paneId: '%4675534428059654805',
        recipient: 'worker',
        recipientRole: 'worker',
      };

      const dependencies: MailboxTargetOwnershipDependencies = {
        tmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        serverIdentityDependencies: undefined,
      };

      const result = await verifyTeamTargetOwnership(target, dependencies);

      // The issue is that when session is 'cmux:1' but paneId is tmux-format (%...),
      // the verification fails. This is Failure 1 from issue #4261.
      expect(result.kind).toBe('unavailable');
      expect(dependencies.cmuxExec).not.toHaveBeenCalled();
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
});
