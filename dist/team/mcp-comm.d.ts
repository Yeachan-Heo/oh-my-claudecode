/**
 * MCP Communication Layer - High-level dispatch functions.
 *
 * Coordinates inbox writes, mailbox messages, and dispatch requests with
 * notification callbacks. Direct mailbox notifications are authorized against
 * current strict durable state before any pane effect.
 */
import { type StrictDispatchReadResult, type TeamDispatchRequest, type TeamDispatchRequestInput } from './dispatch-queue.js';
import { type StrictCanonicalMailboxMessageReadResult } from './team-ops.js';
import { type MailboxNotificationGuardInput, type MailboxNotificationGuardResult, type MailboxNotificationTarget } from './mailbox-notification-guard.js';
import { type DirectMailboxEffectResult } from './tmux-session.js';
export interface TeamNotifierTarget {
    workerName: string;
    workerIndex?: number;
    paneId?: string;
}
export type DispatchTransport = 'hook' | 'prompt_stdin' | 'tmux_send_keys' | 'mailbox' | 'none';
export interface DispatchOutcome {
    ok: boolean;
    transport: DispatchTransport;
    reason: string;
    request_id?: string;
    message_id?: string;
    to_worker?: string;
    /** Internal handoff marker; removed before queue functions return. */
    notification_managed?: true;
}
export type TeamNotifier = (target: TeamNotifierTarget, message: string, context: {
    request: TeamDispatchRequest;
    message_id?: string;
}) => DispatchOutcome | Promise<DispatchOutcome>;
/** Dependency interface for inbox write operations */
export interface InboxWriter {
    writeWorkerInbox(teamName: string, workerName: string, inbox: string, cwd: string): Promise<void>;
}
/** Dependency interface for mailbox message operations */
export interface MailboxSender {
    sendDirectMessage(teamName: string, fromWorker: string, toWorker: string, body: string, cwd: string): Promise<{
        message_id: string;
        to_worker: string;
    }>;
    /** Retained for callers that provide the historical mailbox sender shape. */
    broadcastMessage(teamName: string, fromWorker: string, body: string, cwd: string): Promise<Array<{
        message_id: string;
        to_worker: string;
    }>>;
    markMessageNotified(teamName: string, workerName: string, messageId: string, cwd: string): Promise<void | boolean>;
}
export interface MailboxNotificationAttemptParams {
    teamName: string;
    recipient: string;
    requestId: string;
    messageId: string;
    triggerMessage: string;
    cwd: string;
}
export interface MailboxNotificationAttemptDependencies {
    readGuard: (input: MailboxNotificationGuardInput, cwd: string) => Promise<MailboxNotificationGuardResult>;
    readStrictDispatch: (teamName: string, requestId: string, cwd: string) => Promise<StrictDispatchReadResult>;
    readStrictMailbox: (teamName: string, workerName: string, messageId: string, cwd: string) => Promise<StrictCanonicalMailboxMessageReadResult>;
    invokeEffect: (target: MailboxNotificationTarget, message: string) => Promise<DirectMailboxEffectResult>;
    markMailbox: (teamName: string, workerName: string, messageId: string, cwd: string) => Promise<boolean>;
    markDispatch: (teamName: string, requestId: string, cwd: string) => Promise<TeamDispatchRequest | null>;
    patchPendingReason: (teamName: string, requestId: string, reason: string, cwd: string) => Promise<{
        kind: string;
    }>;
    withRequestLock: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
}
/**
 * Runs one direct mailbox notification attempt. The process-identity lock and
 * tombstone are deliberately outside the dispatch lock so checked marker and
 * reason writes can use their existing dispatch serialization without nesting it.
 */
export declare function runMailboxNotificationAttempt(params: MailboxNotificationAttemptParams, overrides?: Partial<MailboxNotificationAttemptDependencies>): Promise<DispatchOutcome>;
export interface QueueInboxParams {
    teamName: string;
    workerName: string;
    workerIndex: number;
    paneId?: string;
    inbox: string;
    triggerMessage: string;
    cwd: string;
    transportPreference?: TeamDispatchRequestInput['transport_preference'];
    fallbackAllowed?: boolean;
    inboxCorrelationKey?: string;
    notify: TeamNotifier;
    deps: InboxWriter;
}
export declare function queueInboxInstruction(params: QueueInboxParams): Promise<DispatchOutcome>;
export interface QueueDirectMessageParams {
    teamName: string;
    fromWorker: string;
    toWorker: string;
    toWorkerIndex?: number;
    toPaneId?: string;
    body: string;
    triggerMessage: string;
    cwd: string;
    transportPreference?: TeamDispatchRequestInput['transport_preference'];
    fallbackAllowed?: boolean;
    notify: TeamNotifier;
    deps: MailboxSender;
}
export declare function queueDirectMailboxMessage(params: QueueDirectMessageParams): Promise<DispatchOutcome>;
export interface QueueBroadcastParams {
    teamName: string;
    fromWorker: string;
    recipients: Array<{
        workerName: string;
        workerIndex: number;
        paneId?: string;
    }>;
    body: string;
    cwd: string;
    triggerFor: (workerName: string) => string;
    transportPreference?: TeamDispatchRequestInput['transport_preference'];
    fallbackAllowed?: boolean;
    notify: TeamNotifier;
    deps: MailboxSender;
}
export declare function queueBroadcastMailboxMessage(params: QueueBroadcastParams): Promise<DispatchOutcome[]>;
export declare function waitForDispatchReceipt(teamName: string, requestId: string, cwd: string, options: {
    timeoutMs: number;
    pollMs?: number;
}): Promise<TeamDispatchRequest | null>;
//# sourceMappingURL=mcp-comm.d.ts.map