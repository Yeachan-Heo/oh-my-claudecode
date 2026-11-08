import { createHash } from 'node:crypto';
import { getUsageCredentialIdentity } from '../../hud/usage-api.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { isRateLimitStatusDegraded, shouldMonitorBlockedPanes } from './rate-limit-monitor.js';
import { resetPaneTailPositions } from './pane-fresh-capture.js';
import type { DaemonState, RateLimitStatus } from './types.js';

export function createInitialState(): DaemonState {
  return {
    isRunning: true,
    pid: process.pid,
    startedAt: new Date(),
    lastPollAt: null,
    rateLimitStatus: null,
    resumePending: false,
    blockedPanes: [],
    resumedPaneIds: [],
    totalResumeAttempts: 0,
    successfulResumes: 0,
    errorCount: 0,
  };
}

/** Fingerprint the selected usage provider and active profile without storing secrets. */
export function getUsageProfileHash(includeEnvironmentCredentials = true): string | null {
  const credentialIdentity = getUsageCredentialIdentity(includeEnvironmentCredentials, true);
  if (credentialIdentity === null) return null;

  return createHash('sha256')
    .update(JSON.stringify([
      process.env.CLAUDE_CONFIG_DIR ?? null,
      getClaudeConfigDir(),
      credentialIdentity,
    ]))
    .digest('hex');
}

/** Keep saved pane recovery state when the active profile cannot be identified. */
export function scopeStateToCurrentUsageProfile(
  state: DaemonState,
  usageProfileHash: string | null,
  stateDir: string,
): DaemonState {
  if (usageProfileHash === null) return state;
  if (state.usageProfileHash !== usageProfileHash) {
    resetPaneTailPositions(stateDir);
    state.lastPollAt = null;
    state.rateLimitStatus = null;
    state.lastConfirmedLimited = false;
    state.resumePending = false;
    state.blockedPanes = [];
    state.resumedPaneIds = [];
    state.totalResumeAttempts = 0;
    state.successfulResumes = 0;
    state.errorCount = 0;
    state.lastError = undefined;
  }
  state.usageProfileHash = usageProfileHash;
  return state;
}

/** Only a confirmed transition out of quota exhaustion can trigger pane resume. */
export function shouldResumeBlockedPanesOnStatusChange(
  previousStatus: Pick<RateLimitStatus, 'isLimited'> | null,
  nextStatus: RateLimitStatus | null,
): boolean {
  const wasLimited = !!previousStatus?.isLimited;
  const isNowLimited = shouldMonitorBlockedPanes(nextStatus);
  return wasLimited && nextStatus !== null && !isNowLimited && !isRateLimitStatusDegraded(nextStatus);
}
