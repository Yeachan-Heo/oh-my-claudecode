import { type StrictDispatchReadResult, type TeamDispatchRequest } from './dispatch-queue.js';
import { type StrictCanonicalMailboxMessageReadResult } from './team-ops.js';
import type { TeamConfig, TeamMailboxMessage } from './types.js';
export interface MailboxNotificationGuardInput {
    teamName: string;
    recipient: string;
    requestId: string;
    messageId: string;
    triggerMessage: string;
}
export type MailboxNotificationProvider = 'tmux' | 'cmux';
export interface MailboxNotificationTarget {
    provider: MailboxNotificationProvider;
    providerTarget: string;
    recipient: string;
    recipientRole: 'leader' | 'worker';
    paneId: string;
    workerIndex?: number;
}
export type MailboxTargetOwnership = {
    kind: 'owned';
    provider: MailboxNotificationProvider;
    providerTarget: string;
    paneId: string;
} | {
    kind: 'unavailable';
} | {
    kind: 'foreign';
} | {
    kind: 'provider_mismatch';
};
/** Fields that must remain identical between the guard's pre-effect re-reads. */
export interface MailboxNotificationSecurityTuple {
    configName: string;
    configProviderTarget: string;
    recipient: string;
    recipientRole: 'leader' | 'worker';
    canonicalPaneId: string;
    canonicalWorkerIndex?: number;
    requestId: string;
    requestKind: 'mailbox';
    requestTeamName: string;
    requestRecipient: string;
    requestMessageId: string;
    requestTriggerMessage: string;
    requestPaneId?: string;
    requestWorkerIndex?: number;
    requestTransportPreference: TeamDispatchRequest['transport_preference'];
    requestFallbackAllowed: boolean;
    requestStatus: 'pending';
    mailboxOwner: string;
    mailboxMessageId: string;
    mailboxRecipient: string;
    provider: MailboxNotificationProvider;
    providerTarget: string;
    providerPaneId: string;
}
export type MailboxNotificationGuardReason = 'mailbox_team_unavailable' | 'mailbox_team_identity_mismatch' | 'mailbox_request_missing' | 'mailbox_dispatch_store_invalid' | 'mailbox_request_ambiguous' | 'mailbox_request_not_pending' | 'mailbox_request_identity_mismatch' | 'mailbox_target_missing' | 'mailbox_target_metadata_mismatch' | 'leader_pane_missing_deferred' | 'mailbox_store_invalid' | 'mailbox_message_missing' | 'mailbox_message_ambiguous' | 'mailbox_recipient_mismatch' | 'mailbox_replay_suppressed' | 'mailbox_provider_mismatch' | 'mailbox_membership_unresolvable' | 'mailbox_target_foreign';
export type MailboxNotificationGuardResult = {
    kind: 'allow';
    target: MailboxNotificationTarget;
    request: TeamDispatchRequest;
    message: TeamMailboxMessage;
    securityTuple: MailboxNotificationSecurityTuple;
} | {
    kind: 'suppress';
    reason: MailboxNotificationGuardReason;
    safePendingRequest?: TeamDispatchRequest;
    target?: MailboxNotificationTarget;
};
export interface MailboxNotificationGuardState {
    config: TeamConfig | null;
    dispatch: StrictDispatchReadResult;
    mailbox: StrictCanonicalMailboxMessageReadResult;
    ownership?: MailboxTargetOwnership;
}
export interface MailboxNotificationGuardDependencies {
    readConfig: (teamName: string, cwd: string) => Promise<TeamConfig | null>;
    readStrictDispatchRequest: (teamName: string, requestId: string, cwd: string) => Promise<StrictDispatchReadResult>;
    readStrictMailboxMessage: (teamName: string, workerName: string, messageId: string, cwd: string) => Promise<StrictCanonicalMailboxMessageReadResult>;
    verifyProviderOwnership: (target: MailboxNotificationTarget) => Promise<MailboxTargetOwnership>;
}
/**
 * Purely evaluates current strict durable evidence. It has no transport,
 * marker, lock, or persistence effects.
 */
export declare function evaluateMailboxNotificationGuard(input: MailboxNotificationGuardInput, state: MailboxNotificationGuardState): MailboxNotificationGuardResult;
/** Compares only authorization-relevant fields; diagnostic dispatch fields are absent by design. */
export declare function mailboxNotificationSecurityTupleEquals(left: MailboxNotificationSecurityTuple, right: MailboxNotificationSecurityTuple): boolean;
/**
 * Reads current evidence through strict readers, then runs the pure evaluator.
 * The injected provider verifier must be read-only; this module has no way to
 * invoke a pane transport or write durable delivery markers.
 */
export declare function readCurrentMailboxNotificationGuard(input: MailboxNotificationGuardInput, cwd: string, dependencies?: Partial<MailboxNotificationGuardDependencies>): Promise<MailboxNotificationGuardResult>;
//# sourceMappingURL=mailbox-notification-guard.d.ts.map