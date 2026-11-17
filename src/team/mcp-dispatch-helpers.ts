/**
 * MCP Dispatch Helpers - Utility functions for dispatch queue operations.
 *
 * Extracted to keep mcp-comm.ts within the 800-line module size limit.
 */

import { basename, dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { DispatchOutcome } from './mcp-comm.js';

/** Convert an exception to a notification error message. */
export function notifyExceptionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `notify_exception:${message}`;
}

/** Reported, not thrown: callers enqueue after persisting a message or starting a worker, and a throw would hide that fact. */
export function enqueueFailedOutcome(error: unknown): DispatchOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, transport: 'none', reason: `dispatch_enqueue_failed:${message}` };
}

/** Check if a value is a non-empty trimmed string. */
export function isExactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

/** Resolve a lock path to its canonical form for consistency across symlinks and relative paths. */
export function canonicalNotificationLockIdentity(lockPath: string): string {
  try {
    return realpathSync(lockPath);
  } catch {
    try {
      return join(realpathSync(dirname(lockPath)), basename(lockPath));
    } catch {
      return lockPath;
    }
  }
}
