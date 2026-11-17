import type { DaemonState, RateLimitStatus } from './types.js';
export declare function createInitialState(): DaemonState;
/** Fingerprint the selected usage provider and active profile without storing secrets. */
export declare function getUsageProfileHash(includeEnvironmentCredentials?: boolean): string | null;
/** Keep saved pane recovery state when the active profile cannot be identified. */
export declare function scopeStateToCurrentUsageProfile(state: DaemonState, usageProfileHash: string | null, stateDir: string): DaemonState;
/** Only a confirmed transition out of quota exhaustion can trigger pane resume. */
export declare function shouldResumeBlockedPanesOnStatusChange(previousStatus: Pick<RateLimitStatus, 'isLimited'> | null, nextStatus: RateLimitStatus | null): boolean;
//# sourceMappingURL=daemon-state.d.ts.map