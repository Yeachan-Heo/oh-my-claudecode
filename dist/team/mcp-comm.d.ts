/**
 * MCP Communication Layer - High-level dispatch functions.
 *
 * Coordinates inbox writes, mailbox messages, and dispatch requests
 * with notification callbacks. Mirrors OMX src/team/mcp-comm.ts exactly.
 *
 * Functions:
 * - queueInboxInstruction: write inbox + enqueue dispatch + notify
 * - queueDirectMailboxMessage: send message + enqueue dispatch + notify
 * - queueBroadcastMailboxMessage: broadcast to all recipients
 * - waitForDispatchReceipt: poll with exponential backoff
 */
import { type TeamDispatchRequest, type TeamDispatchRequestInput } from './dispatch-queue.js';
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
    broadcastMessage(teamName: string, fromWorker: string, body: string, cwd: string): Promise<Array<{
        message_id: string;
        to_worker: string;
    }>>;
    markMessageNotified(teamName: string, workerName: string, messageId: string, cwd: string): Promise<void>;
}
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